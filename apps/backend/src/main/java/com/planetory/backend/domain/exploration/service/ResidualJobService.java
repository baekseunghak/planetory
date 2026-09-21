package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveQuery;
import com.planetory.backend.domain.exploration.service.ResidualJobStore.Enqueued;
import com.planetory.backend.domain.exploration.service.ResidualJobStore.Job;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobAccepted;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobRequest;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobStatus;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse.FieldError;

/**
 * 온라인 잔차 작업 요청·조회 (탐사 API 7.1·7.2절) [S15P21C206-147].
 *
 * <p>목표 문맥 검증은 곡선 조회(5.2절)와 <b>같은 함수</b>를 쓴다. 두 곳이 따로 판단하면 조회는 되는데
 * 계산은 거절되는 문맥이 생긴다.
 *
 * <p>요청에 {@code requestId}가 없다. 같은 목표를 다시 보내면 진행 중 작업이나 캐시가 그대로 오므로
 * 응답을 잃어도 재호출이 곧 복구다(7.1절).
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class ResidualJobService {

    private final AnalysisService analysis;
    private final ResidualJobStore store;
    private final ResidualJobProperties properties;
    /** 계산 실행은 Worker 어댑터(S15P21C206-88)가 채운다. 없으면 작업을 만들지 않는다. */
    private final ObjectProvider<ResidualComputeRunner> runners;

    /**
     * 계산을 요청한다(7.1절).
     *
     * <p>응답에 지금 판을 함께 싣는다(D-5). 목표 검증이 현재 판만 통과시키므로 여기서는 곧 그 판이다.
     *
     * @throws BusinessException 미공개 {@code STAR_NOT_PUBLISHED}, 미발견 {@code STAR_LOCKED},
     *                           판 교체 {@code BUNDLE_CHANGED}, 목표 형식·조합 오류 {@code VALIDATION_FAILED},
     *                           자리 없음 {@code RESIDUAL_QUEUE_FULL}, 계산 기반 미연결
     *                           {@code DEPENDENCY_UNAVAILABLE}
     */
    public Answer<JobAccepted> request(long memberId, long ticId, JobRequest body) {
        CurveContext target = resolveTarget(memberId, ticId, body);
        String cacheKey = ResidualJobStore.cacheKey(ticId, target);

        if (store.result(cacheKey).isPresent()) {
            // 이미 계산돼 있다. 계산 기반 없이도 쓸 수 있는 값이라 실행기보다 먼저 본다.
            return cached(target);
        }

        ResidualComputeRunner runner = runners.getIfAvailable();
        if (runner == null) {
            // 아무도 진행시키지 않을 작업을 만들지 않는다. 화면이 계산이 도는 줄 알게 된다.
            // 연결 상태는 내부 사정이라 기본 문구를 그대로 쓴다. 화면이 이 말을 사용자에게 보여 준다.
            throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        }

        Enqueued enqueued = store.enqueue(memberId, ticId, target, cacheKey);
        return switch (enqueued) {
            // 위 확인과 등록 사이에 다른 회원의 같은 계산이 끝났다. 저장소가 그것까지 보고 답한다.
            case Enqueued.Cached ignored -> cached(target);
            case Enqueued.Created(Job job, int queuePosition) -> {
                start(runner, job);
                yield accepted(job, queuePosition, target);
            }
            case Enqueued.Merged(Job job, int queuePosition) -> accepted(job, queuePosition, target);
            case Enqueued.Full(int retryAfterSeconds, String activeJobId) -> throw queueFull(retryAfterSeconds,
                    activeJobId);
        };
    }

    /**
     * 작업 상태를 본다(7.2절). 조회는 작업을 만들지 않는다(D-14).
     *
     * <p>같은 목표를 요청해 같은 작업을 기다리는 회원은 모두 볼 수 있다(7.1절 「진행 중 작업 있음」).
     * 요청하지 않은 회원의 작업과 사라진 작업은 같은 404로 덮는다. 구분하면 남의 작업 존재가 드러나고,
     * 프론트가 할 일도 「7.1절로 다시 요청」으로 같다.
     *
     * <p><b>지금 판을 헤더로 함께 준다</b>(D-5). 조회는 판을 보지 않아 409를 내지 않으므로, 계산이 도는
     * 동안 판이 바뀌는 것을 화면이 알아챌 수 있는 곳이 여기뿐이다. 폴링이 이미 돌고 있어 추가 요청도 없다.
     *
     * @throws BusinessException 없거나 내 것이 아니면 {@code RESOURCE_NOT_FOUND}
     */
    public Answer<JobStatus> status(long memberId, String jobId) {
        Job job = ExplorationIds.parse(jobId, ExplorationIds.RESIDUAL_JOB).isEmpty()
                ? null
                : store.find(jobId).filter(found -> found.watchedBy(memberId)).orElse(null);
        if (job == null) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }
        boolean completed = ResidualJobStore.COMPLETED.equals(job.status());
        boolean finished = completed || ResidualJobStore.FAILED.equals(job.status());
        JobStatus body = new JobStatus(job.jobId(), String.valueOf(job.ticId()), job.target(), job.status(),
                job.attempt(), job.timeline(), job.failure(), completed ? job.target() : null,
                finished ? null : store.queuePosition(jobId).orElse(null), properties.pollAfterSeconds());
        return new Answer<>(body, true, analysis.currentBundleId(job.ticId()).orElse(null));
    }

    /**
     * 계산을 시작시킨다. <b>시작하지 못하면 작업을 끝낸다.</b>
     *
     * <p>등록만 해 두고 시작에 실패하면 아무도 진행시키지 않는 {@code QUEUED}가 남는다. 같은 목표의
     * 재요청은 그 작업에 병합돼 실행기를 다시 부르지 않으므로, 화면은 오지 않을 결과를 만료까지
     * 기다린다. 실패로 끝내면 병합 대상에서 빠져 다음 요청이 새로 시작한다.
     *
     * <p>회원에게는 실행기의 예외를 보이지 않는다. 화면이 할 일은 잠시 뒤 다시 요청하는 것뿐이다.
     */
    private void start(ResidualComputeRunner runner, Job job) {
        try {
            runner.start(job);
        } catch (RuntimeException e) {
            log.warn("잔차 작업 {}의 계산을 시작하지 못해 실패로 끝냅니다.", job.jobId(), e);
            store.fail(job.jobId(), job.attempt(), new ResidualJobStore.Failure(ResidualJobStore.QUEUED,
                    "START_FAILED", "계산을 시작하지 못했습니다.", true));
            throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        }
    }

    /** 캐시는 곧바로 쓸 수 있으니 200이다. */
    private static Answer<JobAccepted> cached(CurveContext target) {
        return new Answer<>(new JobAccepted(null, ResidualJobStore.COMPLETED, true, target, null, null, null),
                true, target.bundleId());
    }

    private Answer<JobAccepted> accepted(Job job, int queuePosition, CurveContext target) {
        return new Answer<>(new JobAccepted(job.jobId(), job.status(), false, null, queuePosition, null,
                properties.pollAfterSeconds()), false, target.bundleId());
    }

    private static BusinessException queueFull(int retryAfterSeconds, String activeJobId) {
        // 같은 회원의 다른 작업 때문에 막힌 것과 대기열이 찬 것은 화면에서 다른 말이어야 한다(D-4).
        Map<String, Object> details = activeJobId == null
                ? Map.of("retryAfterSeconds", retryAfterSeconds)
                : Map.of("retryAfterSeconds", retryAfterSeconds, "activeJobId", activeJobId);
        return new BusinessException(ErrorCode.RESIDUAL_QUEUE_FULL, details);
    }

    /**
     * 본문의 목표를 곡선 조회와 같은 규칙으로 확인한다.
     *
     * <p>검증 실패 필드 이름을 본문 경로로 바꾼다. 조회는 쿼리라 {@code removed}지만 여기서는
     * {@code target.removedCandidateIds}다. 화면이 어느 값을 고쳐야 하는지 알아야 한다.
     */
    private CurveContext resolveTarget(long memberId, long ticId, JobRequest body) {
        ResidualJobViews.TargetRequest target = body == null ? null : body.target();
        if (target == null) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED,
                    ErrorCode.VALIDATION_FAILED.getDefaultMessage(),
                    List.of(new FieldError("target", "계산할 곡선 문맥이 필요합니다.")));
        }
        List<String> removed = target.removedCandidateIds() == null ? List.of() : target.removedCandidateIds();
        CurveQuery query = new CurveQuery(target.bundleId(), String.valueOf(removed.size()), removed,
                target.residualModelVersion(), target.periodogramConfigVersion());
        try {
            return analysis.residualTarget(memberId, ticId, query);
        } catch (BusinessException e) {
            throw e.getFieldErrors().isEmpty() ? e : rename(e);
        }
    }

    private static BusinessException rename(BusinessException from) {
        List<FieldError> renamed = from.getFieldErrors().stream()
                .map(error -> new FieldError(switch (error.field()) {
                    case "bundleId" -> "target.bundleId";
                    case "removed", "curveStep" -> "target.removedCandidateIds";
                    default -> error.field();
                }, error.reason()))
                .toList();
        return new BusinessException(from.getErrorCode(), from.getMessage(), renamed);
    }
}
