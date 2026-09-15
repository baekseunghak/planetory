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
    private final GalaxyLayout layout;

    // 회원·설정 생성과 같은 트랜잭션. 튜토리얼 seed가 없거나 배치에 실패하면 불완전한 회원을 남기지 않는다.
    @Transactional(propagation = Propagation.MANDATORY)
    public void initialize(long memberId) {
        long ticId = jdbc.sql("SELECT tic_id FROM tutorial_stars WHERE seq = 1 AND active")
                .query(Long.class).optional()
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
        // 튜토리얼 첫 별도 이후 발견 별과 같은 은하 배치 함수로 좌표를 정한다(탐사 API 9.4절).
        var position = layout.place(memberId, ticId);
        jdbc.sql("""
                INSERT INTO star_unlocks(user_id, tic_id, unlock_reason,
                    world_x, world_y, depth_z, layout_version, unlocked_at)
                VALUES (?, ?, 'tutorial', ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId, position.worldX(), position.worldY(),
                        position.depthZ(), position.layoutVersion()).update();
        jdbc.sql("""
                INSERT INTO user_star_progress(user_id, tic_id) VALUES (?, ?)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId).update();
    }
}
