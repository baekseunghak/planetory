package com.planetory.backend.domain.exploration.service;

import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.ExplorationCompletionPolicy.Decision;
import com.planetory.backend.domain.exploration.service.ExplorationCompletionRepository.CandidateCounts;

/**
 * 완료 판정을 현재 진행 행에 반영한다 [S15P21C206-149].
 *
 * <p>제출·분석 진입·판 전환 후처리의 트랜잭션 안에서 공통으로 호출한다. 이 서비스는 성과나
 * 새 별을 만들지 않는다. {@code no_candidate} 제출도 호출자가 이 서비스를 부르지 않는다.
 */
@Service
@RequiredArgsConstructor
public class ExplorationCompletionService {

    private final ExplorationCompletionRepository repository;
    private final SkyService sky;

    /**
     * 진행 중인 별을 판정하고 필요한 경우 완료로 바꾼다.
     *
     * @return 진행 행이 없거나 이미 완료·미탐사면 빈 값. 현재 판·활성 후보가 없으면
     *         {@link Decision#NOT_APPLICABLE}, 탐색 가능한 미발견 후보가 남으면
     *         {@link Decision#KEEP_IN_PROGRESS}, 완료 조건이면 반영한 완료 판정을 반환한다.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<Decision> evaluateAndApply(long memberId, long ticId) {
        Optional<String> stage = repository.lockProgressStage(memberId, ticId);
        if (stage.isEmpty() || !"in_progress".equals(stage.get())) {
            return Optional.empty();
        }

        CandidateCounts counts = repository.countCandidates(memberId, ticId);
        Decision decision = ExplorationCompletionPolicy.decide(
                counts.active(), counts.discoverableUnmatched(), counts.undiscoverableUnmatched());
        if (decision.completes()) {
            int updated = repository.complete(memberId, ticId, decision);
            if (updated != 1) {
                throw new IllegalStateException("잠근 진행 행의 완료 전환에 실패했습니다");
            }
            // 타일의 단계가 바뀐다(D-7). 별을 연 회원은 발견 때 버전 행이 생겼으므로 여기서는
            // UPDATE만 일어나 회원 행을 잠그지 않는다. 잠금 순서는 진행 행 → 버전 행 그대로다.
            sky.bumpVersion(memberId);
        }
        return Optional.of(decision);
    }
}
