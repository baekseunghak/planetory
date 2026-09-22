package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.domain.exploration.service.StarDiscoveryService.Reason;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class InitialExplorationService {
    private final TutorialRepository tutorials;
    private final StarDiscoveryService discovery;

    // 회원·설정 생성과 같은 트랜잭션. 튜토리얼 seed가 없거나 배치에 실패하면 불완전한 회원을 남기지 않는다.
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long memberId) {
        long ticId = tutorials.findActiveTicId(1)
                .orElseThrow(() -> {
                    log.error("OAuth member initialization failed: reason=active_tutorial_missing seq=1");
                    return new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
                });
        // 튜토리얼 첫 별도 이후 발견 별과 같은 순번·좌표·버전 규칙을 쓴다(탐사 API 9.4절).
        discovery.discover(memberId, ticId, Reason.TUTORIAL);
    }
}
