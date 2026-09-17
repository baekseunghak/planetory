package com.planetory.backend.domain.exploration.service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.exploration.service.SkyViews.Bounds;
import com.planetory.backend.domain.exploration.service.SkyViews.Marker;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyStar;

/**
 * 별 지도 조회 [S15P21C206-136].
 *
 * <p>좌표는 저장된 값을 읽기만 한다. 요청마다 배치 함수를 다시 돌리지 않는다
 * (`sky-reference` README: 운영 요청 시 좌표를 다시 계산하지 않는다).
 *
 * <p>회원 격리는 모든 질의의 `user_id` 조건이 담당한다. 다른 회원·미발견 별은 어떤 응답에도
 * 들어가지 않는다.
 */
@Repository
@RequiredArgsConstructor
public class SkyRepository {

    private final JdbcClient jdbc;

    /** 회원의 전체 발견 수와 월드 경계. 별이 없으면 비어 있다. */
    public Optional<Bounds> findBounds(long memberId) {
        return jdbc.sql("""
                        SELECT min(world_x)::float8 AS min_x, max(world_x)::float8 AS max_x,
                               min(world_y)::float8 AS min_y, max(world_y)::float8 AS max_y
                          FROM star_unlocks
                         WHERE user_id = :memberId
                        """)
                .param("memberId", memberId)
                .query((rs, rowNum) -> rs.getObject("min_x") == null ? null
                        : new Bounds(rs.getDouble("min_x"), rs.getDouble("max_x"),
                                rs.getDouble("min_y"), rs.getDouble("max_y")))
                .optional()
                .filter(bounds -> bounds != null);
    }

    public int countStars(long memberId) {
        return jdbc.sql("SELECT count(*) FROM star_unlocks WHERE user_id = :memberId")
                .param("memberId", memberId)
                .query(Integer.class).single();
    }

    /** 전체 보기의 처음 초점. 가장 먼저 열린 별을 준다. */
    public List<String> findCenterTicIds(long memberId) {
        return jdbc.sql("""
                        SELECT tic_id FROM star_unlocks
                         WHERE user_id = :memberId
                         ORDER BY layout_ordinal
                         LIMIT 1
                        """)
                .param("memberId", memberId)
                .query(String.class).list();
    }

    /** 범위 안 전체 별 수. 페이지를 다 모은 결과와 대조하는 값이라 같은 조건으로 센다. */
    public long countInRange(long memberId, SkyViews.TileBounds bounds) {
        return jdbc.sql("""
                        SELECT count(*) FROM star_unlocks
                         WHERE user_id = :memberId
                           AND world_x >= :minX AND world_x < :maxX
                           AND world_y >= :minY AND world_y < :maxY
                        """)
                .param("memberId", memberId)
                .param("minX", bounds.x()).param("maxX", bounds.x() + bounds.w())
                .param("minY", bounds.y()).param("maxY", bounds.y() + bounds.h())
                .query(Long.class).single();
    }

    /**
     * 범위 안 별 한 페이지. ticId 숫자값 오름차순으로 안정 정렬한다(탐사 API 4.1).
     *
     * @param afterTicId 이전 페이지의 마지막 ticId. 첫 페이지는 null이다.
     * @param limit      가져올 수. 호출자가 한 건 더 요청해 다음 페이지 유무를 판단한다.
     */
    public List<SkyStar> findStarsInRange(long memberId, SkyViews.TileBounds bounds,
                                          Long afterTicId, int limit) {
        return jdbc.sql("""
                        SELECT u.tic_id, u.world_x::float8 AS x, u.world_y::float8 AS y,
                               u.depth_z::float8 AS depth_z, u.layout_ordinal,
                               u.unlock_reason, t.seq AS tutorial_seq,
                               COALESCE(p.planet_count, 0) AS planet_count,
                               COALESCE(p.progress_stage, 'unexplored') AS progress_stage,
                               -- 재개된 뒤 아직 새 제출이 없는 상태만 "다시 열린 별"이다.
                               (p.reopened_at IS NOT NULL AND NOT EXISTS (
                                    SELECT 1 FROM submissions s
                                     WHERE s.user_id = u.user_id AND s.tic_id = u.tic_id
                                       AND s.created_at > p.reopened_at)) AS reopened
                          FROM star_unlocks u
                          LEFT JOIN user_star_progress p
                                 ON p.user_id = u.user_id AND p.tic_id = u.tic_id
                          LEFT JOIN tutorial_stars t
                                 ON t.tic_id = u.tic_id AND u.unlock_reason = 'tutorial'
                         WHERE u.user_id = :memberId
                           AND u.world_x >= :minX AND u.world_x < :maxX
                           AND u.world_y >= :minY AND u.world_y < :maxY
                           AND (CAST(:afterTicId AS BIGINT) IS NULL OR u.tic_id > :afterTicId)
                         ORDER BY u.tic_id
                         LIMIT :limit
                        """)
                .param("memberId", memberId)
                .param("minX", bounds.x()).param("maxX", bounds.x() + bounds.w())
                .param("minY", bounds.y()).param("maxY", bounds.y() + bounds.h())
                .param("afterTicId", afterTicId)
                .param("limit", limit)
                .query(SkyRepository::toStar)
                .list();
    }

    private static SkyStar toStar(ResultSet rs, int rowNum) throws SQLException {
        int planetCount = rs.getInt("planet_count");
        String progressStage = rs.getString("progress_stage");
        return new SkyStar(
                String.valueOf(rs.getLong("tic_id")),
                rs.getDouble("x"),
                rs.getDouble("y"),
                rs.getDouble("depth_z"),
                rs.getInt("layout_ordinal"),
                planetCount,
                progressStage,
                // FP 성과 여부와 무관하다. 완료했고 표시할 행성이 없는 상태만 뜻한다.
                "completed".equals(progressStage) && planetCount == 0,
                marker(rs),
                rs.getBoolean("reopened"));
    }

    /** 튜토리얼 번호만 싣는다. 챌린지 느낌표는 퀘스트 응답이 원천이다({@link Marker}). */
    private static Marker marker(ResultSet rs) throws SQLException {
        if (!"tutorial".equals(rs.getString("unlock_reason"))) {
            return null;
        }
        int seq = rs.getInt("tutorial_seq");
        return rs.wasNull() ? null : new Marker("tutorial", seq);
    }
}
