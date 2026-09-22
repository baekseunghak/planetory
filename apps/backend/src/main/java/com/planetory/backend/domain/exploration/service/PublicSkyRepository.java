package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** 공개 은하의 허용 필드만 조회한다. 개인 지도와 같은 저장 좌표를 사용한다. */
@Repository
@RequiredArgsConstructor
public class PublicSkyRepository {
    private final JdbcClient jdbc;

    // 성과는 라벨 변경·공개 취소에도 보존된다. 행성 표시는 현재 HOME-05 조건과의 교집합이다.
    private static final String PUBLIC_PLANETS = """
            WITH public_planets AS (
                SELECT c.tic_id, ('c-' || c.id) AS candidate_id,
                       CASE WHEN c.is_confirmed THEN 'confirmed' ELSE 'unconfirmed' END AS kind,
                       c.period_days::float8 AS period_days, c.depth_ppm::float8 AS depth_ppm
                  FROM user_candidate_achievements a
                  JOIN candidates c ON c.id = a.candidate_id
                  JOIN star_unlocks u ON u.user_id = a.user_id AND u.tic_id = c.tic_id
             LEFT JOIN candidate_dispositions d ON d.candidate_id = c.id
                 WHERE a.user_id = :owner
                   AND COALESCE(d.disposition, 'none') <> 'fp'
                   AND (c.is_confirmed OR (
                       SELECT s.user_judgment FROM submissions s
                        WHERE s.user_id = a.user_id AND s.tic_id = c.tic_id
                          AND s.matched_candidate_id = c.id
                        ORDER BY s.created_at DESC, s.id DESC LIMIT 1
                   ) = 'LIKELY_PLANET')
            )
            """;

    public Optional<PublicSkyViews.Owner> findOwner(long owner) {
        return jdbc.sql("""
                SELECT u.id, u.nickname FROM users u
                LEFT JOIN user_settings s ON s.user_id = u.id
                WHERE u.id = :owner AND u.status = 'active' AND u.withdrawn_at IS NULL
                  AND COALESCE(s.star_list_public, true)
                """).param("owner", owner)
                .query((r, n) -> new PublicSkyViews.Owner("u-" + r.getLong("id"), r.getString("nickname")))
                .optional();
    }

    public List<PublicSkyViews.Planet> findPlanets(long owner, long tic) {
        return jdbc.sql(PUBLIC_PLANETS + """
                SELECT candidate_id, kind, period_days, depth_ppm FROM public_planets
                WHERE tic_id = :tic ORDER BY candidate_id
                """).param("owner", owner).param("tic", tic)
                .query((r, n) -> new PublicSkyViews.Planet(r.getString("candidate_id"), r.getString("kind"),
                        r.getObject("period_days", Double.class), r.getObject("depth_ppm", Double.class)))
                .list();
    }

    public List<PublicSkyViews.Star> findStarsInRange(long owner, SkyViews.TileBounds bounds,
                                                     Long after, int limit) {
        return jdbc.sql(PUBLIC_PLANETS + """
                SELECT u.tic_id, u.world_x::float8 AS x, u.world_y::float8 AS y,
                       u.depth_z::float8 AS depth_z, u.layout_ordinal,
                       COALESCE(pc.planet_count, 0) AS planet_count,
                       COALESCE(p.progress_stage, 'unexplored') AS progress_stage
                  FROM star_unlocks u
             LEFT JOIN user_star_progress p ON p.user_id = u.user_id AND p.tic_id = u.tic_id
             LEFT JOIN (SELECT tic_id, count(*) AS planet_count FROM public_planets GROUP BY tic_id) pc
                    ON pc.tic_id = u.tic_id
                 WHERE u.user_id = :owner
                   AND u.world_x >= :minX AND u.world_x < :maxX
                   AND u.world_y >= :minY AND u.world_y < :maxY
                   AND (CAST(:after AS BIGINT) IS NULL OR u.tic_id > :after)
                 ORDER BY u.tic_id LIMIT :limit
                """).param("owner", owner)
                .param("minX", bounds.x()).param("maxX", bounds.x() + bounds.w())
                .param("minY", bounds.y()).param("maxY", bounds.y() + bounds.h())
                .param("after", after).param("limit", limit)
                .query((r, n) -> {
                    int count = r.getInt("planet_count");
                    String stage = r.getString("progress_stage");
                    return new PublicSkyViews.Star(Long.toString(r.getLong("tic_id")),
                            r.getDouble("x"), r.getDouble("y"), r.getDouble("depth_z"),
                            r.getInt("layout_ordinal"), count, stage, "completed".equals(stage) && count == 0);
                }).list();
    }

    /** 새 발견이 없는 성과·진행·Gold 갱신도 공개 버전을 바꾼다. 호출자의 동일 스냅샷에서 읽는다. */
    public String fingerprint(long owner) {
        // ponytail: 전체 보유 별·행성 집계와 후보별 최신 제출 조회. 비용이 커지면 원천 트랜잭션의 버전 갱신으로 전환한다.
        return jdbc.sql(PUBLIC_PLANETS + """
                SELECT md5(jsonb_build_array(
                    (SELECT nickname FROM users WHERE id = :owner),
                    COALESCE((
                        SELECT jsonb_agg(jsonb_build_array(u.tic_id, u.world_x::float8, u.world_y::float8,
                                   u.depth_z::float8, u.layout_ordinal, u.layout_version,
                                   COALESCE(p.progress_stage, 'unexplored')) ORDER BY u.tic_id)
                        FROM star_unlocks u
                        LEFT JOIN user_star_progress p ON p.user_id = u.user_id AND p.tic_id = u.tic_id
                        WHERE u.user_id = :owner
                    ), '[]'::jsonb),
                    COALESCE((
                        SELECT jsonb_agg(jsonb_build_array(tic_id, candidate_id, kind, period_days, depth_ppm)
                                         ORDER BY tic_id, candidate_id)
                        FROM public_planets
                    ), '[]'::jsonb)
                )::text)
                """).param("owner", owner).query(String.class).single();
    }
}
