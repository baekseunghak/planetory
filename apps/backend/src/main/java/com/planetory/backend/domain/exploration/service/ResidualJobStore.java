package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;

/**
 * 온라인 잔차 작업의 상태·결과 저장소 (탐사 API 7장, DAT-14) [S15P21C206-147].
 *
 * <p>운영 저장소는 Redis다({@code docs/architecture/online-derived-compute.md} 「캐시 위치」).
 * 실행 제어·TTL·lease는 {@code S15P21C206-89}·{@code S15P21C206-90}이 맡고, 여기서는 이 API가
 * 필요로 하는 동작만 계약으로 고정한다.
 *
 * <p><b>상한 판정과 등록은 한 번에 일어나야 한다.</b> 따로 하면 두 요청이 같은 빈자리를 보고
 * 둘 다 등록한다. 그래서 {@link #enqueue}가 병합·상한·등록을 함께 결정한다.
 */
public interface ResidualJobStore {

    /** 2.4절 상태. 전이는 이 순서로만 일어나며 {@code FAILED}는 어느 단계에서든 갈 수 있다. */
    String QUEUED = "QUEUED";
    String RESIDUAL_CALCULATING = "RESIDUAL_CALCULATING";
    String RESIDUAL_READY = "RESIDUAL_READY";
    String PERIODOGRAM_CALCULATING = "PERIODOGRAM_CALCULATING";
    String COMPLETED = "COMPLETED";
    String FAILED = "FAILED";

    /**
     * 작업 한 건.
     *
     * @param attempt Job 단위 시도 번호(1부터). 주기도만 다시 계산해도 오른다. <b>이 API는 읽기만 한다</b> —
     *                올리는 함수는 아직 없고, 임대가 끝난 계산을 다시 시작하는 쪽({@code S15P21C206-88})이
     *                필요해질 때 더한다
     * @param cacheKey 7.1절 캐시 키. 같은 키의 계산은 하나만 돈다
     * @param watchers 이 작업을 기다리는 회원. 같은 목표를 요청한 사람은 같은 작업을 보므로
     *                 만든 회원만으로는 조회를 막을 수 없다. 요청이 목표 검증을 통과한 회원만 들어온다
     */
    record Job(String jobId, long ticId, CurveContext target, String cacheKey,
               String status, int attempt, Timeline timeline, Failure failure, Set<Long> watchers) {

        public boolean watchedBy(long memberId) {
            return watchers.contains(memberId);
        }
    }

    /** 각 단계에 들어간 시각. 아직 지나지 않은 단계는 null이다. */
    record Timeline(OffsetDateTime queuedAt, OffsetDateTime residualStartedAt, OffsetDateTime residualReadyAt,
                    OffsetDateTime periodogramStartedAt, OffsetDateTime completedAt) {
    }

    /** 실패 단계와 원인 (7.2절). {@code retryable}이면 같은 목표로 다시 요청할 수 있다. */
    record Failure(String stage, String code, String message, boolean retryable) {
    }

    /**
     * 계산 결과. 곡선·주기도 조회(5.2·5.3절)가 이 값을 그대로 읽는다.
     *
     * @param segmentFlux 세그먼트 id별 잔차 flux. 원본과 점 수·인덱스가 같다
     * @param power 잔차 주기도. 원본 주기도와 같은 격자다
     */
    record Result(OffsetDateTime computedAt, Map<Long, Float[]> segmentFlux, Float[] power) {
    }

    /** {@link #enqueue} 결과. */
    sealed interface Enqueued {

        /** 새 작업을 만들었다. 호출자가 계산을 시작시킨다. */
        record Created(Job job, int queuePosition) implements Enqueued {
        }

        /** 같은 키를 이미 계산하고 있다. 그 작업 상태를 그대로 준다(7.1절 「진행 중 작업 있음」). */
        record Merged(Job job, int queuePosition) implements Enqueued {
        }

        /** 이미 계산돼 있다. 작업을 만들지 않고 캐시로 답한다(7.1절 「캐시 있음」). */
        record Cached(Result result) implements Enqueued {
        }

        /**
         * 자리가 없다. 429 {@code RESIDUAL_QUEUE_FULL}이다.
         *
         * @param activeJobId 같은 회원의 다른 작업이 돌고 있어 막힌 경우 그 작업(D-4). 대기열 초과면 null
         */
        record Full(int retryAfterSeconds, String activeJobId) implements Enqueued {
        }
    }

    /**
     * 7.1절 캐시 키 {@code tic:{ticId}:b{bundleId}:rm{정렬 id}:{rm}:{pg}}.
     *
     * <p>제거 후보는 id 숫자 오름차순이라 같은 조합이면 요청 순서가 달라도 같은 키다(DAT-14).
     * 문맥이 이미 그 순서를 지키므로 여기서 다시 정렬하지 않는다.
     */
    static String cacheKey(long ticId, CurveContext target) {
        return "tic:" + ticId + ":" + target.bundleId()
                + ":rm" + String.join(",", target.removedCandidateIds())
                + ":" + target.residualModelVersion() + ":" + target.periodogramConfigVersion();
    }

    /** 작업 한 건. 없으면(만료·Redis 유실) 빈 값이며 호출자는 404로 덮는다. */
    Optional<Job> find(String jobId);

    /** 이 키의 완료된 결과. 없으면 빈 값이다. */
    Optional<Result> result(String cacheKey);

    /** 이 키를 계산 중인 작업. 조회는 작업을 만들지 않는다(D-14). */
    Optional<Job> active(String cacheKey);

    /** 대기 순번(0이면 지금 계산 중). 작업이 없으면 빈 값이다. */
    Optional<Integer> queuePosition(String jobId);

    /**
     * 캐시·병합·상한·등록을 한 번에 결정한다.
     *
     * <p><b>캐시 확인도 여기서 한다.</b> 밖에서 먼저 보고 들어오면 그 사이에 다른 회원의 같은 계산이
     * 끝났을 때 이미 있는 결과를 두고 작업을 하나 더 만든다. 끝난 작업은 병합 대상이 아니라 합쳐지지도
     * 않는다.
     */
    Enqueued enqueue(long memberId, long ticId, CurveContext target, String cacheKey);

    /** 계산 단계를 옮긴다. 늦게 도착한 옛 시도의 보고는 무시한다. */
    void advance(String jobId, int attempt, String status);

    /** 결과를 저장하고 작업을 완료로 옮긴다. */
    void complete(String jobId, int attempt, Result result);

    /** 실패로 끝낸다. 저장된 제출·매칭·성과는 건드리지 않는다(AT-101). */
    void fail(String jobId, int attempt, Failure failure);

    /**
     * 이 별에서 현재 판이 아닌 키를 모두 버린다 (탐사 API 10장 4단계 (1)) [S15P21C206-150].
     *
     * <p>키에 판이 들어 있으므로({@link #cacheKey}) 판이 바뀌면 이전 판의 결과는 다시 쓰이지 않는다.
     * 그래도 지우는 것은 TTL이 끝날 때까지 메모리를 잡고 있기 때문이다. 정합성 장치가 아니라 정리다 —
     * Backend는 결과를 저장하기 전에 요청의 판이 아직 {@code current}인지 다시 확인하고 아니면 버린다
     * ({@code docs/architecture/online-derived-compute.md}).
     *
     * <p>계산 중인 작업도 버린다. 이전 판으로 계산한 잔차는 채택될 수 없고, 작업이 사라지면 조회가
     * 404가 되는데 그것은 「Redis 유실」과 같은 상황이라 호출자가 이미 다룬다(7.2절).
     *
     * <p>같은 판으로 다시 불러도 결과가 같다. 두 번째에는 버릴 것이 없어 0을 돌려준다.
     *
     * @return 버린 작업과 결과의 수
     */
    int evictOtherBundles(long ticId, long currentBundleId);
}
