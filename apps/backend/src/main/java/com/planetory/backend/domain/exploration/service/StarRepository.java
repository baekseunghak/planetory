package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.domain.StarBoardVisibility;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.PublicAnalysisVisibility;
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

    /**
     * 공개 요약용 별 정보. {@code published}가 아니면 빈 값이다.
     *
     * <p>미공개 별과 없는 TIC을 구분하지 않는다. 호출자가 둘 다 같은 404로 덮는다(4.5절).
     */
    public Optional<StarViews.PublicStarInfo> findPublishedStar(long ticId) {
        return jdbc.sql("""
                        SELECT s.tmag::float8 AS tmag,
                               COALESCE((SELECT array_agg(DISTINCT o.sector::int ORDER BY o.sector::int)
                                           FROM observation_datasets o
                                          WHERE o.tic_id = s.tic_id), '{}') AS sectors
                          FROM stars s
                         WHERE s.tic_id = :ticId AND s.service_status = 'published'
                        """)
                .param("ticId", ticId)
                .query((rs, rowNum) -> {
                    Integer[] sectors = (Integer[]) rs.getArray("sectors").getArray();
                    return new StarViews.PublicStarInfo(sectors.length, List.of(sectors),
                            nullableDouble(rs, "tmag"));
                })
                .optional();
    }

    /** 이 별을 발견한 회원 수. 표시용이며 진행 상태나 후보 수는 함께 주지 않는다. */
    public int countDiscoveredMembers(long ticId) {
        return jdbc.sql("SELECT count(DISTINCT u.user_id) FROM star_unlocks u "
                        + "JOIN users m ON m.id=u.user_id AND m.status='active' WHERE u.tic_id = ?")
                .param(ticId)
                .query(Integer.class).single();
    }

    /**
     * 현재 판. published 별에는 있어야 하지만 없을 수도 있어 빈 값을 허용한다.
     *
     * <p>{@code uq_publication_bundles_current}가 한 TIC에 current를 하나로 묶는다.
     */
    public Optional<String> findCurrentBundleId(long ticId) {
        return jdbc.sql("SELECT id FROM publication_bundles WHERE tic_id = ? AND status = 'current'")
                .param(ticId)
                .query(Long.class).optional()
                .map(id -> "b-" + id);
    }

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
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM stars WHERE tic_id = ? AND board_open)")
                .param(ticId)
                .query(Boolean.class).single();
    }

    /**
     * 공개됐고 한 명이라도 발견한 별인지 [S15P21C206-158].
     *
     * <p>게시판 자격 판정만 한다. 요약 화면용 섹터 집계·발견 회원 수를 끌고 오지 않도록
     * 존재 확인 하나로 둔다.
     */
    public boolean isOpenPublishedStar(long ticId) {
        return jdbc.sql("SELECT " + StarBoardVisibility.OPEN.formatted("?"))
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

    /** 튜토리얼이면 번호를 준다. 그 밖에는 빈 값이다. 챌린지 느낌표는 싣지 않는다({@link SkyViews.Marker}). */
    public Optional<SkyViews.Marker> findMarker(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT u.unlock_reason, t.seq AS tutorial_seq
                          FROM star_unlocks u
                     LEFT JOIN tutorial_stars t
                            ON t.tic_id = u.tic_id AND u.unlock_reason = 'tutorial'
                         WHERE u.user_id = :memberId AND u.tic_id = :ticId
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> markerOf(rs))
                .optional()
                .filter(marker -> marker != null);
    }

    /**
     * 별 목록 한 페이지 (탐사 API 4.4).
     *
     * <p>{@code lastActivityAt}은 최근 제출·재개·발견 중 가장 늦은 시각이다. 셋 중 발견 시각은
     * 항상 있으므로 이 값은 NULL이 되지 않는다. 내림차순이고 동률은 {@code ticId}로 가른다.
     *
     * <p>이어읽기 조건이 두 열을 함께 본다. 시각만 비교하면 같은 시각의 별들이 통째로 밀리거나
     * 빠진다. 행 값 비교 {@code (a, b) < (x, y)}로 정렬과 같은 순서를 쓴다.
     *
     * <p>{@code submitted}는 제출 이력이 있는 별만, {@code discovered}는 발견한 별 전부다.
     * 성과로 막 발견해 아직 제출하지 않은 별도 분석에 들어갈 수 있어야 한다(지웅 리뷰 6).
     *
     * <p>{@code unpublishedSignalCount}는 호출자가 본인 조회일 때만 채운다. 여기서는 항상
     * 계산해 두고 서비스가 타인 조회에서 지운다. 질의를 둘로 나누면 정렬이 갈릴 수 있다.
     *
     * @param afterActivity 이어읽기 기준 시각. 첫 페이지는 null
     * @param limit         한 건 더 요청해 다음 페이지 유무를 판단한다
     */
    public List<StarViews.StarListItem> findStarList(long targetId, String scope,
                                                     StarViews.ListFilter filter,
                                                     java.time.OffsetDateTime afterActivity,
                                                     Long afterTicId, int limit) {
        int[] gradeRange = filter.grade() == null ? null : StarService.gradeRange(filter.grade());
        return jdbc.sql("""
                        WITH base AS (
                            SELECT u.tic_id,
                                   u.unlock_reason,
                                   GREATEST(
                                       u.unlocked_at,
                                       COALESCE(p.reopened_at, u.unlocked_at),
                                       COALESCE((SELECT max(s.created_at) FROM submissions s
                                                  WHERE s.user_id = u.user_id AND s.tic_id = u.tic_id),
                                                u.unlocked_at)
                                   ) AS last_activity_at,
                                   COALESCE(p.progress_stage, 'unexplored') AS progress_stage,
                                   COALESCE(p.planet_count, 0) AS planet_count,
                                   p.current_curve_step,
                                   COALESCE(p.reopen_pending, false) AS reopen_pending,
                                   (p.reopened_at IS NOT NULL AND NOT EXISTS (
                                        SELECT 1 FROM submissions s
                                         WHERE s.user_id = u.user_id AND s.tic_id = u.tic_id
                                           AND s.created_at > p.reopened_at)) AS reopened,
                                   t.seq AS tutorial_seq,
                                   EXISTS(SELECT 1 FROM submissions s
                                           WHERE s.user_id = u.user_id AND s.tic_id = u.tic_id) AS submitted,
                                   (SELECT count(*) FROM user_candidate_achievements a
                                      JOIN candidates c ON c.id = a.candidate_id
                                     WHERE a.user_id = u.user_id AND c.tic_id = u.tic_id)
                                       AS achievement_count,
                                   (SELECT count(DISTINCT s.matched_candidate_id)
                                      FROM submissions s
                                     WHERE s.user_id = u.user_id AND s.tic_id = u.tic_id
                                       AND s.matched_candidate_id IS NOT NULL
                                       AND NOT EXISTS (
                                           SELECT 1 FROM published_analyses pa
                                             JOIN posts p ON p.id = pa.post_id
                                            WHERE pa.user_id = s.user_id
                                              AND pa.candidate_id = s.matched_candidate_id
                                              AND %s))
                                       AS unpublished_signal_count
                              FROM star_unlocks u
                         LEFT JOIN user_star_progress p
                                ON p.user_id = u.user_id AND p.tic_id = u.tic_id
                         LEFT JOIN tutorial_stars t
                                ON t.tic_id = u.tic_id AND u.unlock_reason = 'tutorial'
                             WHERE u.user_id = :targetId
                        )
                        SELECT * FROM base
                         WHERE (:scope = 'discovered' OR submitted)
                           AND (CAST(:stage AS TEXT) IS NULL OR progress_stage = :stage)
                           AND (CAST(:ticId AS BIGINT) IS NULL OR tic_id = :ticId)
                           AND (CAST(:gradeMin AS INTEGER) IS NULL
                                OR achievement_count BETWEEN :gradeMin AND :gradeMax)
                           AND (CAST(:afterActivity AS TIMESTAMPTZ) IS NULL
                                OR (last_activity_at, -tic_id) < (:afterActivity, -CAST(:afterTicId AS BIGINT)))
                         ORDER BY last_activity_at DESC, tic_id
                         LIMIT :limit
                        """.formatted(PublicAnalysisVisibility.VISIBLE))
                .param("targetId", targetId)
                .param("scope", scope)
                .param("stage", filter.stage())
                .param("ticId", filter.ticId() == null ? null : Long.parseLong(filter.ticId()))
                .param("gradeMin", gradeRange == null ? null : gradeRange[0])
                .param("gradeMax", gradeRange == null ? null : gradeRange[1])
                .param("afterActivity", afterActivity)
                .param("afterTicId", afterTicId)
                .param("limit", limit)
                .query((rs, rowNum) -> {
                    int achievementCount = rs.getInt("achievement_count");
                    String stage = rs.getString("progress_stage");
                    int planetCount = rs.getInt("planet_count");
                    return new StarViews.StarListItem(
                            String.valueOf(rs.getLong("tic_id")),
                            stage,
                            planetCount,
                            "completed".equals(stage) && planetCount == 0,
                            achievementCount,
                            StarService.grade(achievementCount),
                            (Integer) rs.getObject("current_curve_step"),
                            rs.getBoolean("reopen_pending"),
                            rs.getBoolean("reopened"),
                            rs.getInt("unpublished_signal_count"),
                            rs.getObject("last_activity_at", java.time.OffsetDateTime.class),
                            rs.getString("unlock_reason"),
                            markerOf(rs));
                })
                .list();
    }

    /** 이 회원이 별 목록을 공개했는지. 설정 행이 없으면 기본값 공개다. */
    public boolean isStarListPublic(long targetId) {
        return jdbc.sql("SELECT COALESCE((SELECT star_list_public FROM user_settings"
                        + " WHERE user_id = ?), true)")
                .param(targetId)
                .query(Boolean.class).single();
    }

    /** 튜토리얼 번호만 싣는다. 발견 경로는 {@code unlockReason}이 따로 알린다. */
    private static SkyViews.Marker markerOf(java.sql.ResultSet rs) throws java.sql.SQLException {
        if (!"tutorial".equals(rs.getString("unlock_reason"))) {
            return null;
        }
        int seq = rs.getInt("tutorial_seq");
        return rs.wasNull() ? null : new SkyViews.Marker("tutorial", seq);
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
