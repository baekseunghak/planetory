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
        int layoutOrdinal = nextLayoutOrdinal(memberId);
        // 튜토리얼 첫 별도 이후 발견 별과 같은 은하 배치 함수로 좌표를 정한다(탐사 API 9.4절).
        var position = layout.place(layoutOrdinal);
        jdbc.sql("""
                INSERT INTO star_unlocks(user_id, tic_id, unlock_reason,
                    world_x, world_y, depth_z, layout_version, layout_ordinal, unlocked_at)
                VALUES (?, ?, 'tutorial', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId, position.worldX(), position.worldY(),
                        position.depthZ(), position.layoutVersion(), layoutOrdinal).update();
        jdbc.sql("""
                INSERT INTO user_star_progress(user_id, tic_id) VALUES (?, ?)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId).update();
    }

    /**
     * 회원별 다음 배치 순번. 회원 행을 잠근 뒤 끝값을 읽어 같은 순번이 동시에 나가지 않게 한다
     * (S15P21C206-135의 {@code UNIQUE(user_id, layout_ordinal)}, 136의 원자 배정 계약).
     *
     * <p>발견이 {@code ON CONFLICT DO NOTHING}으로 건너뛰면 이 순번은 쓰이지 않는다. 순번은
     * 유일하고 안정적이면 되며 빈틈이 없어야 하는 값이 아니다.
     */
    private int nextLayoutOrdinal(long memberId) {
        jdbc.sql("SELECT id FROM users WHERE id = ? FOR UPDATE").param(memberId).query(Long.class).single();
        return jdbc.sql("SELECT COALESCE(MAX(layout_ordinal) + 1, 0) FROM star_unlocks WHERE user_id = ?")
                .param(memberId).query(Integer.class).single();
    }
}
