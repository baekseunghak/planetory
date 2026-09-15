package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class InitialExplorationService {
    private final JdbcClient jdbc;

    // 회원·설정 생성과 같은 트랜잭션. 튜토리얼 seed가 없으면 불완전한 회원을 남기지 않는다.
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long memberId) {
        long ticId = jdbc.sql("SELECT tic_id FROM tutorial_stars WHERE seq = 1 AND active")
                .query(Long.class).optional()
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
        jdbc.sql("""
                INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, generation,
                    angle_deg, radius_jitter, depth_z, unlocked_at)
                VALUES (?, ?, 'tutorial', 0, 0, 0, 0, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId).update();
        jdbc.sql("""
                INSERT INTO user_star_progress(user_id, tic_id) VALUES (?, ?)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId).update();
    }
}
