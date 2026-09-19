package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.GalaxyLayout.StarPosition;

/**
 * 회원에게 별을 여는 공통 함수 (탐사 API 9.2·9.4절) [S15P21C206-139].
 *
 * <p>가입·튜토리얼·챌린지, 이후 성과 발견(S15P21C206-144)까지 실제 신규 발견은 모두 이 함수를
 * 지난다. 순번 배정·좌표 계산·저장·지도 버전 갱신을 경로마다 따로 두면 한 경로만 규칙이 어긋난다.
 */
@Service
@RequiredArgsConstructor
public class StarDiscoveryService {

    private final JdbcClient jdbc;
    private final GalaxyLayout layout;
    private final SkyService sky;

    /** 별이 열린 이유. {@code star_unlocks.unlock_reason} 값이다. */
    public enum Reason {
        TUTORIAL("tutorial"),
        CHALLENGE("challenge");

        private final String column;

        Reason(String column) {
            this.column = column;
        }
    }

    /**
     * 새로 연 별.
     *
     * @param skyVersion 발견을 반영한 뒤의 지도 버전. 제출·공개 응답의 {@code skyVersion}에 넣는다.
     */
    public record DiscoveredStar(long ticId, int layoutOrdinal, StarPosition position, String skyVersion) {
    }

    /**
     * 별 하나를 연다.
     *
     * <p>회원 행을 먼저 잠근다. 같은 회원의 발견·제출이 이 잠금으로 줄을 서므로 순번이 겹치지 않고,
     * "이미 열렸는가"를 본 결과가 저장할 때까지 유지된다. 잠금 순서는 9.2절의
     * {@code users → user_star_progress → user_candidate_achievements → star_unlocks}를 따른다.
     *
     * <p>이미 열린 별이면 아무것도 바꾸지 않는다. 순번을 쓰지 않고 지도 버전도 올리지 않는다.
     * 바뀐 것이 없는데 버전을 올리면 프론트가 지도를 다시 받는다. 회차 일괄 발견처럼 같은 사건을
     * 다시 실행하는 경로가 있어 이 구분이 필요하다.
     *
     * @return 새로 열었으면 그 결과, 이미 열려 있었으면 빈 값
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<DiscoveredStar> discover(long memberId, long ticId, Reason reason) {
        jdbc.sql("SELECT id FROM users WHERE id = ? FOR UPDATE").param(memberId).query(Long.class).single();
        boolean unlocked = jdbc.sql("SELECT EXISTS(SELECT 1 FROM star_unlocks WHERE user_id = ? AND tic_id = ?)")
                .params(memberId, ticId).query(Boolean.class).single();
        if (unlocked) {
            return Optional.empty();
        }

        // 순번은 유일하고 안정적이면 된다. 빈틈이 없어야 하는 값이 아니다(S15P21C206-135).
        int ordinal = jdbc.sql("SELECT COALESCE(MAX(layout_ordinal) + 1, 0) FROM star_unlocks WHERE user_id = ?")
                .param(memberId).query(Integer.class).single();
        StarPosition position = layout.place(ordinal);

        jdbc.sql("""
                INSERT INTO user_star_progress(user_id, tic_id) VALUES (?, ?)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId).update();
        // 모든 발견 경로가 회원 잠금을 먼저 잡으므로 여기서 충돌하지 않는다. 잠금 없이 넣은 행
        // (운영자 수동 입력 등)과 부딪혀도 트랜잭션을 깨지 않고 새 발견이 아닌 것으로 처리한다.
        // 좌표는 BigDecimal로 넘긴다. double을 그대로 넘기면 float8→NUMERIC 변환이 유효숫자 15자리로
        // 반올림해, 저장값이 배치 함수가 계산한 값과 달라진다.
        int inserted = jdbc.sql("""
                INSERT INTO star_unlocks(user_id, tic_id, unlock_reason,
                    world_x, world_y, depth_z, layout_version, layout_ordinal, unlocked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, tic_id) DO NOTHING
                """).params(memberId, ticId, reason.column,
                        BigDecimal.valueOf(position.worldX()), BigDecimal.valueOf(position.worldY()),
                        BigDecimal.valueOf(position.depthZ()), position.layoutVersion(), ordinal).update();
        if (inserted == 0) {
            return Optional.empty();
        }
        // 같은 트랜잭션이라 발견과 버전이 어긋나지 않는다(D-7).
        return Optional.of(new DiscoveredStar(ticId, ordinal, position, sky.bumpVersion(memberId)));
    }
}
