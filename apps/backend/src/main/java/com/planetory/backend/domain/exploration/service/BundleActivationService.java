package com.planetory.backend.domain.exploration.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.BundleActivationRepository.ProgressRow;
import com.planetory.backend.domain.exploration.service.ExplorationCompletionPolicy.Decision;
import com.planetory.backend.domain.gold.GoldCatalogRepository;

/**
 * 새 판이 current가 된 뒤의 후처리 (탐사 API 9.3·10장) [S15P21C206-150].
 *
 * <p>Publisher가 판을 바꾼 뒤 알린다. 알림은 전환을 빨리 알아채기 위한 신호일 뿐이고 정본은
 * DB의 {@code current}다(10장). 그래서 알림이 없어도, 늦게 와도, 두 번 와도 결과가 같아야 한다.
 *
 * <p>10장 4단계의 세 가지를 순서대로 한다 — (1) 이전 판 잔차 캐시 정리, (2) 9.3 완료·재개 판정,
 * (3) 9.5 외부 라벨 표식. 셋은 서로 독립이라 한 트랜잭션으로 묶지 않는다.
 *
 * <p>회원마다 트랜잭션을 나눈다. 한 별에 진행 행이 많을 수 있고, 한 회원에서 실패했다고 앞서
 * 끝낸 회원의 판정을 되돌릴 이유가 없다.
 *
 * <p>이 후처리는 성과·발견 별·공개 기록을 건드리지 않는다. 재개는 진행 상태만 되돌린다.
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class BundleActivationService {

    private final BundleActivationRepository repository;
    private final TutorialRepository tutorials;
    private final ExplorationCompletionService completion;
    private final ExplorationCompletionRepository completionRepository;
    private final ResidualJobStore residualJobs;
    private final PlatformTransactionManager transactionManager;
    private final GoldCatalogRepository gold;
    private final SkyService sky;

    /** 회원 한 명을 처리한 결과. */
    enum Outcome {
        /** 판정이 바꾼 것이 없다. */
        NONE,
        /** 진행 중이던 별을 완료로 바꿨다. */
        COMPLETED,
        /** 완료했던 별을 다시 열고 재개 사건을 남겼다. */
        REOPENED
    }

    /**
     * 후처리 결과. 실행 여부를 알 수 있어야 재시도할지 판단할 수 있다.
     *
     * @param evicted   버린 이전 판 잔차 캐시 키 수(10장 4단계 (1))
     * @param completed 완료로 바꾼 회원 수(9.3절 (c))
     * @param reopened  다시 연 회원 수(9.3절)
     * @param relabeled 라벨 갱신 표식을 남긴 성과 수(9.5절)
     */
    public record Result(boolean applied, long ticId, int evicted, int completed, int reopened, int relabeled) {

        /** 현재 판이 아니어서 아무것도 하지 않았다. */
        static final Result SKIPPED = new Result(false, 0, 0, 0, 0, 0);
    }

    /**
     * 전환된 판의 별에 대해 완료 재판정과 재개 판정을 실행한다.
     *
     * <p>지난 판의 알림이면 아무것도 하지 않는다. 그 사이 더 새로운 판이 올라왔다면 그 판의
     * 알림이 따로 오고, 오지 않더라도 다음 요청이 현재 판을 기준으로 판정한다.
     */
    public Result onBundleActivated(long bundleId) {
        var tic = repository.findCurrentBundleTic(bundleId);
        if (tic.isEmpty()) {
            log.info("판 {}은 현재 판이 아니어서 후처리하지 않습니다.", bundleId);
            return Result.SKIPPED;
        }
        long ticId = tic.get();
        var template = new TransactionTemplate(transactionManager);
        // (1) 이전 판 잔차 캐시 정리. 회원 판정과 묶지 않는다 — 캐시는 없어도 다시 계산되므로
        // 여기서 실패해도 회원 상태를 되돌릴 이유가 없고, 반대로 판정이 실패해도 정리는 유효하다.
        int evicted = residualJobs.evictBundles(ticId, repository.findSupersededBundleIds(ticId));
        // (3) 외부 라벨 갱신 표식. 회원별 판정과 독립이며 한 문장으로 끝난다.
        int relabeled = template.execute(status -> repository.markRelabeledAchievements(ticId));
        // (2) 완료 재판정과 재개.
        int completed = 0;
        int reopened = 0;
        for (ProgressRow row : repository.findProgressRows(ticId)) {
            switch (template.execute(status -> apply(row, ticId, bundleId))) {
                case COMPLETED -> completed++;
                case REOPENED -> reopened++;
                case NONE -> { }
            }
        }
        // 공개 전환 알림이 도착하면 운영자가 고른 별의 새 판을 분석 요청 전에 채운다.
        // 적재 실패는 PostgreSQL Gold 조회로 복구하므로 기존 회원 후처리를 막지 않는다.
        try {
            gold.preloadSelectedTic(ticId);
        } catch (RuntimeException ex) {
            log.warn("판 {}의 Gold Redis 사전 적재 실패", bundleId, ex);
        }
        log.info("판 {}(TIC {}) 후처리: 캐시 {}건 정리, 라벨 표식 {}건, 재개 {}명, 완료 재판정 {}명.",
                bundleId, ticId, evicted, relabeled, reopened, completed);
        return new Result(true, ticId, evicted, completed, reopened, relabeled);
    }

    /**
     * 회원 한 명의 진행 행을 처리한다.
     *
     * <p>진행 중이면 완료 판정을 먼저 돌린다(9.3절 (c)). 그 판정이 완료로 바꾼 회원은 이번
     * 후처리에서 다시 열지 않는다 — 방금 "모두 찾았다"고 판정한 별을 같은 실행에서 "새 후보가
     * 있다"고 되돌리면 한 번의 전환으로 완료와 재개가 함께 생긴다.
     *
     * <p>위 {@code TransactionTemplate}이 만든 트랜잭션 안에서 실행된다. 같은 클래스에서 부르므로
     * 애노테이션을 달아도 프록시를 타지 않아 경계를 만들지 못한다. 트랜잭션이 없으면
     * {@code evaluateAndApply}의 {@code MANDATORY}가 먼저 막는다.
     *
     * <p><b>회원 행을 먼저 잠근다.</b> 제출·공개 경로가 {@code users → user_star_progress} 순서로
     * 잠그므로(9.2절 {@code recognize}) 여기서 진행 행을 먼저 잡으면 반대 순서가 된다. 재개는
     * 알림 INSERT의 외래 키 검사로 회원 행에 KEY SHARE를 요구하는데, 그 시점에 제출이 이미 회원
     * 행을 {@code FOR UPDATE}로 들고 진행 행을 기다리고 있으면 서로를 기다린다(MR !177 리뷰, 백승학).
     */
    Outcome apply(ProgressRow row, long ticId, long bundleId) {
        if (!tutorials.lockActiveMember(row.memberId())) return Outcome.NONE;
        if ("in_progress".equals(row.stage())) {
            return completion.evaluateAndApply(row.memberId(), ticId)
                    .filter(Decision::completes).isPresent() ? Outcome.COMPLETED : Outcome.NONE;
        }
        // 목록을 읽은 뒤 회원이 직접 움직였을 수 있다. 잠그고 다시 확인한 단계로만 판정한다.
        if (completionRepository.lockProgressStage(row.memberId(), ticId)
                .filter("completed"::equals).isEmpty()) {
            return Outcome.NONE;
        }
        int newDiscoverable =
                completionRepository.countCandidates(row.memberId(), ticId).discoverableUnmatched();
        if (newDiscoverable == 0) {
            return Outcome.NONE;
        }
        if (repository.reopen(row.memberId(), ticId) != 1) {
            throw new IllegalStateException("잠근 진행 행의 재개 전환에 실패했습니다");
        }
        repository.recordReopenEvent(row.memberId(), ticId, bundleId, newDiscoverable, null);
        // 타일의 단계·재개 표시가 바뀐다(D-7).
        sky.bumpVersion(row.memberId());
        return Outcome.REOPENED;
    }
}
