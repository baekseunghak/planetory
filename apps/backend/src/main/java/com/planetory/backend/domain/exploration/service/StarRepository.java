package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.exploration.service.StarViews.Achievement;
import com.planetory.backend.domain.exploration.service.StarViews.AchievementByType;
import com.planetory.backend.domain.exploration.service.StarViews.PlanetItem;
import com.planetory.backend.domain.exploration.service.StarViews.Position;
import com.planetory.backend.domain.exploration.service.StarViews.Progress;
import com.planetory.backend.domain.exploration.service.StarViews.StarInfo;
import com.planetory.backend.domain.exploration.service.StarViews.Unlock;

/**
 * 별 상세 조회 [S15P21C206-138].
 *
 * <p>모든 질의가 {@code user_id}로 회원을 가른다. 타인의 발견·제출·성과는 어떤 응답에도 들어가지
 * 않는다.
 */
@Repository
@RequiredArgsConstructor
public class StarRepository {

    private final JdbcClient jdbc;

    /** 이 회원이 그 별을 열었는지. 미발견이면 상세를 주지 않는다. */
    public boolean hasUnlocked(long memberId, long ticId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM star_unlocks WHERE user_id = ? AND tic_id = ?)")
                .params(memberId, ticId)
                .query(Boolean.class).single();
    }

    /**
     * 별의 관측 회차와 물리값.
     *
     * <p>같은 sector가 여러 {@code source_version}으로 들어올 수 있어 중복을 없앤다. 물리값은
     * 카탈로그에 없을 수 있어 그대로 null로 읽는다(D-18).
     */
    public Optional<StarInfo> findStar(long ticId) {
        return jdbc.sql("""
                        SELECT s.tmag::float8 AS tmag, s.teff_k::float8 AS teff_k,
                               s.radius_rsun::float8 AS radius_rsun,
                               COALESCE((SELECT array_agg(DISTINCT o.sector::int ORDER BY o.sector::int)
                                           FROM observation_datasets o
                                          WHERE o.tic_id = s.tic_id), '{}') AS sectors
                          FROM stars s
                         WHERE s.tic_id = :ticId
                        """)
                .param("ticId", ticId)
                .query((rs, rowNum) -> {
                    Integer[] sectors = (Integer[]) rs.getArray("sectors").getArray();
                    return new StarInfo(sectors.length, List.of(sectors),
                            nullableDouble(rs, "tmag"), nullableDouble(rs, "teff_k"),
                            nullableDouble(rs, "radius_rsun"));
                })
                .optional();
    }

    /** 발견 기록과 저장된 좌표. 좌표는 타일·위치 찾기와 같은 값이어야 한다. */
    public Optional<Unlock> findUnlock(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT unlock_reason, trigger_tic_id, trigger_achievement_id, unlocked_at,
                               world_x::float8 AS x, world_y::float8 AS y,
                               depth_z::float8 AS depth_z, layout_version, layout_ordinal
                          FROM star_unlocks
                         WHERE user_id = :memberId AND tic_id = :ticId
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> new Unlock(
                        rs.getString("unlock_reason"),
                        prefixed("", rs.getObject("trigger_tic_id")),
                        // 성과 식별자는 접두사를 붙인다. TIC은 숫자 문자열 그대로다(명세 4.2 예제).
                        prefixed("ach-", rs.getObject("trigger_achievement_id")),
                        rs.getObject("unlocked_at", java.time.OffsetDateTime.class),
                        new Position(rs.getDouble("x"), rs.getDouble("y"), rs.getDouble("depth_z"),
                                rs.getString("layout_version"), rs.getInt("layout_ordinal"))))
                .optional();
    }

    /** 진행 상태. 아직 분석을 시작하지 않았으면 행이 없다. */
    public Optional<Progress> findProgress(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT progress_stage, current_curve_step, completion_reason,
                               reopen_pending, reopened_at, completed_at
                          FROM user_star_progress
                         WHERE user_id = :memberId AND tic_id = :ticId
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> new Progress(
                        rs.getString("progress_stage"),
                        (Integer) rs.getObject("current_curve_step"),
                        rs.getString("completion_reason"),
                        rs.getBoolean("reopen_pending"),
                        rs.getObject("reopened_at", java.time.OffsetDateTime.class),
                        rs.getObject("completed_at", java.time.OffsetDateTime.class)))
                .optional();
    }

    /**
     * 이 회원이 이 별에서 찾은 행성 (HOME-05).
     *
     * <p>포함 규칙이 확정과 미확정에서 다르다. 확정 행성은 판단이 틀렸거나 성과를 못 받았어도
     * 넣는다. 미확정은 <b>그 회원의 그 후보에 대한 최신 판단</b>이 {@code LIKELY_PLANET}일 때만
     * 넣는다. 공개나 성과 인정은 조건이 아니다.
     *
     * <p>FP는 넣지 않는다. {@code candidate_dispositions} 행이 없으면 FP로 단정하지 않는다.
     *
     * <p>한 후보에 제출이 여러 건이면 가장 최근 것만 본다. 같은 시각이면 id가 큰 쪽이 최신이다.
     */
    public List<PlanetItem> findMyPlanets(long memberId, long ticId) {
        return jdbc.sql("""
                        WITH latest AS (
                            SELECT DISTINCT ON (s.matched_candidate_id)
                                   s.matched_candidate_id AS candidate_id,
                                   s.user_judgment
                              FROM submissions s
                             WHERE s.user_id = :memberId
                               AND s.tic_id = :ticId
                               AND s.matched_candidate_id IS NOT NULL
                             ORDER BY s.matched_candidate_id, s.created_at DESC, s.id DESC
                        )
                        SELECT c.id, c.is_confirmed,
                               c.period_days::float8 AS period_days,
                               c.depth_ppm::float8 AS depth_ppm
                          FROM latest l
                          JOIN candidates c ON c.id = l.candidate_id
                     LEFT JOIN candidate_dispositions d ON d.candidate_id = c.id
                         WHERE COALESCE(d.disposition, 'none') <> 'fp'
                           AND (c.is_confirmed OR l.user_judgment = 'LIKELY_PLANET')
                         ORDER BY ('c-' || c.id)
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> new PlanetItem(
                        "c-" + rs.getLong("id"),
                        rs.getBoolean("is_confirmed") ? "confirmed" : "unconfirmed",
                        rs.getDouble("period_days"),
                        (int) Math.round(rs.getDouble("depth_ppm"))))
                .list();
    }

    /** 이 별에서 인정된 성과. 등급은 여기서 세지 않고 서비스가 count로 만든다(GRD-01). */
    public Achievement countAchievements(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT count(*) FILTER (WHERE a.achievement_type = 'confirmed') AS confirmed,
                               count(*) FILTER (WHERE a.achievement_type = 'unconfirmed') AS unconfirmed,
                               count(*) FILTER (WHERE a.achievement_type = 'fp') AS fp
                          FROM user_candidate_achievements a
                          JOIN candidates c ON c.id = a.candidate_id
                         WHERE a.user_id = :memberId AND c.tic_id = :ticId
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> {
                    int confirmed = rs.getInt("confirmed");
                    int unconfirmed = rs.getInt("unconfirmed");
                    int fp = rs.getInt("fp");
                    return new Achievement(confirmed + unconfirmed + fp, null,
                            new AchievementByType(confirmed, unconfirmed, fp));
                })
                .single();
    }

    /** 제출 이력이 있으면 결과 페이지가 열린다(RES-10). */
    public boolean hasSubmission(long memberId, long ticId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM submissions WHERE user_id = ? AND tic_id = ?)")
                .params(memberId, ticId)
                .query(Boolean.class).single();
    }

    /** 한 명이라도 발견했으면 게시판이 열린다(COM-01). 요청 회원 기준이 아니다. */
    public boolean isBoardOpen(long ticId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM star_unlocks WHERE tic_id = ?)")
                .param(ticId)
                .query(Boolean.class).single();
    }

    /** 이 별의 공식 신호 스레드 수. 숨김·삭제는 세지 않는다. */
    public int countThreads(long ticId) {
        return jdbc.sql("""
                        SELECT count(*) FROM posts
                         WHERE tic_id = ? AND kind = 'system_thread' AND status = 'visible'
                        """)
                .param(ticId)
                .query(Integer.class).single();
    }

    /** 튜토리얼이면 번호를 함께 준다. 챌린지는 번호가 없고 그 밖에는 null이다. */
    public Optional<SkyViews.Marker> findMarker(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT u.unlock_reason, t.seq AS tutorial_seq
                          FROM star_unlocks u
                     LEFT JOIN tutorial_stars t
                            ON t.tic_id = u.tic_id AND u.unlock_reason = 'tutorial'
                         WHERE u.user_id = :memberId AND u.tic_id = :ticId
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> {
                    String reason = rs.getString("unlock_reason");
                    if ("tutorial".equals(reason)) {
                        int seq = rs.getInt("tutorial_seq");
                        return rs.wasNull() ? null : new SkyViews.Marker("tutorial", seq);
                    }
                    return "challenge".equals(reason) ? new SkyViews.Marker("challenge", null) : null;
                })
                .optional()
                .filter(marker -> marker != null);
    }

    private static Double nullableDouble(java.sql.ResultSet rs, String column)
            throws java.sql.SQLException {
        double value = rs.getDouble(column);
        return rs.wasNull() ? null : value;
    }

    private static String prefixed(String prefix, Object value) {
        return value == null ? null : prefix + value;
    }
}
