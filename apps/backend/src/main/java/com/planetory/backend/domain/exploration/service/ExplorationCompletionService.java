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

    /**
     * 진행 중인 별을 판정하고 필요한 경우 완료로 바꾼다.
     *
     * @return 진행 행이 없거나 이미 완료·미탐사면 빈 값, 그 밖에는 적용한 판정
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
        }
        return Optional.of(decision);
    }
}
