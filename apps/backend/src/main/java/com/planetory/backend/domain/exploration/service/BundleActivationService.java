package com.planetory.backend.domain.exploration.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.BundleActivationRepository.ProgressRow;
import com.planetory.backend.domain.exploration.service.ExplorationCompletionPolicy.Decision;

/**
 * 새 판이 current가 된 뒤의 후처리 (탐사 API 9.3·10장) [S15P21C206-150].
 *
 * <p>Publisher가 판을 바꾼 뒤 알린다. 알림은 전환을 빨리 알아채기 위한 신호일 뿐이고 정본은
 * DB의 {@code current}다(10장). 그래서 알림이 없어도, 늦게 와도, 두 번 와도 결과가 같아야 한다.
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
    private final ExplorationCompletionService completion;
    private final ExplorationCompletionRepository completionRepository;
    private final PlatformTransactionManager transactionManager;

    /** 회원 한 명을 처리한 결과. */
    enum Outcome {
        /** 판정이 바꾼 것이 없다. */
        NONE,
        /** 진행 중이던 별을 완료로 바꿨다. */
        COMPLETED,
        /** 완료했던 별을 다시 열고 재개 사건을 남겼다. */
        REOPENED
    }

    /** 후처리 결과. 실행 여부를 알 수 있어야 재시도할지 판단할 수 있다. */
    public record Result(boolean applied, long ticId, int completed, int reopened) {

        /** 현재 판이 아니어서 아무것도 하지 않았다. */
        static final Result SKIPPED = new Result(false, 0, 0, 0);
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
        int completed = 0;
        int reopened = 0;
        for (ProgressRow row : repository.findProgressRows(ticId)) {
            switch (template.execute(status -> apply(row, ticId, bundleId))) {
                case COMPLETED -> completed++;
                case REOPENED -> reopened++;
                case NONE -> { }
            }
        }
        log.info("판 {}(TIC {}) 후처리: 재개 {}명, 완료 재판정 {}명.", bundleId, ticId, reopened, completed);
        return new Result(true, ticId, completed, reopened);
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
     */
    Outcome apply(ProgressRow row, long ticId, long bundleId) {
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
        return Outcome.REOPENED;
    }
}
