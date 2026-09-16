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
        // layout_ordinal은 회원별 발견 순번이며 모든 발견 종류가 공유한다(S15P21C206-135).
        // 가입 시 첫 별이라 보통 0이지만, 다른 경로가 먼저 별을 열었을 수 있으므로 계산해서 넣는다.
        // 같은 순번을 동시에 잡으면 UNIQUE(user_id, layout_ordinal)가 한쪽을 실패시킨다.
        jdbc.sql("""
                INSERT INTO star_unlocks(user_id, tic_id, unlock_reason,
                    world_x, world_y, depth_z, layout_version, layout_ordinal, unlocked_at)
                VALUES (?, ?, 'tutorial', ?, ?, ?, ?,
                    COALESCE((SELECT MAX(layout_ordinal) + 1 FROM star_unlocks WHERE user_id = ?), 0),
                    CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId, position.worldX(), position.worldY(),
                        position.depthZ(), position.layoutVersion(), memberId).update();
        jdbc.sql("""
                INSERT INTO user_star_progress(user_id, tic_id) VALUES (?, ?)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId).update();
    }
}
