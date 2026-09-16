package com.planetory.backend.domain.exploration;

import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.StarViews.PlanetItem;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 선택한 별·내 행성 상세 계약 [S15P21C206-138].
 *
 * <p>탐사 API 4.2절과 HOME-05 표시 조건을 따른다. 실행마다 별도 스키마를 만들고 끝나면 지운다.
 */
@ActiveProfiles("local")
@SpringBootTest
class StarDetailTest {

    private static final String SCHEMA =
            "star_detail_" + UUID.randomUUID().toString().replace("-", "");

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired StarService stars;
    @Autowired SkyService sky;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

    private long memberId;
    private long otherMemberId;
    private long ticId;
    private long bundleId;

    @BeforeEach
    void seed() {
        memberId = insertMember();
        otherMemberId = insertMember();
        ticId = insertStar(9.8, 5600.0, 0.95);
        bundleId = insertBundle(ticId);
        unlock(memberId, ticId, 0);
        // submissions.rule_version이 operation_settings를 참조한다.
        jdbc.update("INSERT INTO operation_settings(rule_version, \"values\", applied_at, note)"
                + " VALUES ('rule-0', '{}'::jsonb, now(), 'test') ON CONFLICT DO NOTHING");
    }

    // ---------- 접근 ----------

    /** 발견하지 않은 별은 존재를 숨기지 않고 잠겼다고만 알린다(NFR-06, AT-64). */
    @Test
    void 발견하지_않은_별은_STAR_LOCKED다() {
        long lockedTic = insertStar(10.1, null, null);

        var thrown = assertThrows(BusinessException.class, () -> stars.detail(memberId, lockedTic));

        assertEquals(ErrorCode.STAR_LOCKED, thrown.getErrorCode());
    }

    /** 다른 회원의 발견으로 내 상세가 열리지 않는다. */
    @Test
    void 타인이_발견한_별도_내게는_잠겨_있다() {
        long otherTic = insertStar(10.1, null, null);
        unlock(otherMemberId, otherTic, 0);

        assertThrows(BusinessException.class, () -> stars.detail(memberId, otherTic));
    }

    // ---------- planets.items 표시 조건 (HOME-05) ----------

    /**
     * 확정 행성은 판단이 틀렸어도 넣는다. 미확정은 최신 판단이 LIKELY_PLANET일 때만 넣는다.
     * FP는 어느 경우에도 넣지 않는다.
     */
    @Test
    void 내_행성은_확정과_LIKELY_판단만_담는다() {
        long confirmed = insertCandidate(true, 3.0021, 1450, null);
        long likely = insertCandidate(false, 11.8, 380, "pc");
        long unlikely = insertCandidate(false, 5.5, 200, "pc");
        long unsure = insertCandidate(false, 7.7, 150, "pc");
        long falsePositive = insertCandidate(false, 1.1, 90, "fp");

        // 확정인데 판단은 틀렸다. 그래도 내 행성이다.
        submit(memberId, confirmed, "UNLIKELY_PLANET");
        submit(memberId, likely, "LIKELY_PLANET");
        submit(memberId, unlikely, "UNLIKELY_PLANET");
        submit(memberId, unsure, "UNSURE");
        submit(memberId, falsePositive, "LIKELY_PLANET");

        var planets = stars.detail(memberId, ticId).planets();

        assertEquals(List.of("c-" + confirmed, "c-" + likely),
                planets.items().stream().map(PlanetItem::candidateId).sorted().toList());
        assertEquals("confirmed", itemOf(planets.items(), confirmed).kind());
        assertEquals("unconfirmed", itemOf(planets.items(), likely).kind());
    }

    /** 같은 후보에 제출이 여러 건이면 가장 최근 판단만 본다. */
    @Test
    void 판단을_바꾸면_최신_제출만_반영된다() {
        long candidate = insertCandidate(false, 4.2, 300, "pc");
        submit(memberId, candidate, "LIKELY_PLANET");
        submit(memberId, candidate, "UNSURE");   // 마음을 바꿨다

        assertTrue(stars.detail(memberId, ticId).planets().items().isEmpty(),
                "최신 판단이 UNSURE면 표시하지 않는다");

        submit(memberId, candidate, "LIKELY_PLANET");   // 다시 바꿨다

        assertEquals(1, stars.detail(memberId, ticId).planets().items().size());
    }

    /** 매칭하지 못한 제출은 행성이 아니다. 타인의 매칭도 내 목록에 오지 않는다. */
    @Test
    void 미매칭과_타인_매칭은_담기지_않는다() {
        long candidate = insertCandidate(true, 3.0, 1000, null);
        unlock(otherMemberId, ticId, 0);
        submit(otherMemberId, candidate, "LIKELY_PLANET");
        submitWithoutMatch(memberId);

        assertTrue(stars.detail(memberId, ticId).planets().items().isEmpty());
        assertEquals(1, stars.detail(otherMemberId, ticId).planets().items().size());
    }

    /** count는 items 길이와 같고 지도 planetCount와도 맞아야 한다. */
    @Test
    void 행성_수는_목록_길이와_지도_값과_일치한다() {
        long first = insertCandidate(true, 3.0, 1000, null);
        long second = insertCandidate(true, 9.0, 700, null);
        submit(memberId, first, "LIKELY_PLANET");
        submit(memberId, second, "LIKELY_PLANET");
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, planet_count, progress_stage)"
                + " VALUES (?, ?, 2, 'in_progress')", memberId, ticId);

        var detail = stars.detail(memberId, ticId);

        assertEquals(detail.planets().items().size(), detail.planets().count());
        assertEquals(2, detail.planets().count());
        assertEquals(2, jdbc.queryForObject("SELECT planet_count FROM user_star_progress"
                + " WHERE user_id = ? AND tic_id = ?", Integer.class, memberId, ticId));
    }

    /** 완료했는데 표시할 행성이 0개인 상태. 행성이 없다는 증거가 아니다. */
    @Test
    void 완료했는데_행성이_없으면_표식이_선다() {
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, planet_count, progress_stage,"
                + " completion_reason) VALUES (?, ?, 0, 'completed', 'all_found')", memberId, ticId);

        var planets = stars.detail(memberId, ticId).planets();

        assertEquals(0, planets.count());
        assertTrue(planets.items().isEmpty());
        assertTrue(planets.completedWithoutPlanets());
    }

    /** 진행 중이면 0개여도 표식이 서지 않는다. */
    @Test
    void 진행_중_0개는_완료_표식이_아니다() {
        var planets = stars.detail(memberId, ticId).planets();

        assertEquals(0, planets.count());
        assertFalse(planets.completedWithoutPlanets());
    }

    // ---------- 등급·행동 ----------

    /**
     * 등급은 성과 수에서 만드는 계산값이다(GRD-01). 0개는 등급이 없다.
     *
     * <p>순수 함수를 직접 부르지 않고 실제 경로로 잰다. 저장소 집계까지 함께 확인된다.
     */
    @Test
    void 등급은_성과_수로_정해지고_0개는_없다() {
        assertNull(stars.detail(memberId, ticId).achievement().grade(), "성과 0개는 등급이 없다");

        assertEquals("A", gradeAfterAchievements(1));
        assertEquals("S", gradeAfterAchievements(1));
        assertEquals("SS", gradeAfterAchievements(1));
        assertEquals("SSS", gradeAfterAchievements(1));
        assertEquals("SSS", gradeAfterAchievements(5), "4 이상은 모두 SSS다");
        assertEquals(9, stars.detail(memberId, ticId).achievement().count());
    }

    /** 성과를 {@code more}개 더 인정하고 그때의 등급을 돌려준다. */
    private String gradeAfterAchievements(int more) {
        for (int i = 0; i < more; i++) {
            long candidate = insertCandidate(true, 3.0 + i, 1000, null);
            submit(memberId, candidate, "LIKELY_PLANET");
            recognize(memberId, candidate, "confirmed");
        }
        return stars.detail(memberId, ticId).achievement().grade();
    }

    /** 성과 유형별 수를 나눠 센다. */
    @Test
    void 성과를_유형별로_나눠_센다() {
        long confirmed = insertCandidate(true, 3.0, 1000, null);
        long unconfirmed = insertCandidate(false, 9.0, 700, "pc");
        submit(memberId, confirmed, "LIKELY_PLANET");
        recognize(memberId, confirmed, "confirmed");
        submit(memberId, unconfirmed, "LIKELY_PLANET");
        recognize(memberId, unconfirmed, "unconfirmed");

        var achievement = stars.detail(memberId, ticId).achievement();

        assertEquals(2, achievement.count());
        assertEquals("S", achievement.grade());
        assertEquals(1, achievement.byType().confirmed());
        assertEquals(1, achievement.byType().unconfirmed());
        assertEquals(0, achievement.byType().fp());
    }

    /** 제출 이력이 있어야 결과 페이지가 열린다(RES-10). */
    @Test
    void 분석_버튼과_결과_열림이_진행_상태를_따른다() {
        var fresh = stars.detail(memberId, ticId).actions();
        assertEquals("start", fresh.analysis());
        assertFalse(fresh.resultAvailable());

        submitWithoutMatch(memberId);
        var started = stars.detail(memberId, ticId).actions();
        assertEquals("continue", started.analysis());
        assertTrue(started.resultAvailable());

        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, planet_count, progress_stage)"
                + " VALUES (?, ?, 0, 'completed')", memberId, ticId);
        assertEquals("review", stars.detail(memberId, ticId).actions().analysis());
    }

    // ---------- 좌표·물리값 ----------

    /** 상세의 좌표는 지도 타일이 준 값과 같아야 한다(별지도 표현 계약). */
    @Test
    void 좌표는_지도_타일과_같은_값이다() {
        var detail = stars.detail(memberId, ticId);
        var tile = sky.tiles(memberId, 2, -16384, -16384, 32768, 32768,
                sky.version(memberId), 100, null);
        var fromTile = tile.stars().stream()
                .filter(star -> star.ticId().equals(String.valueOf(ticId)))
                .findFirst().orElseThrow();

        assertEquals(fromTile.x(), detail.unlock().position().x());
        assertEquals(fromTile.y(), detail.unlock().position().y());
        assertEquals(fromTile.depthZ(), detail.unlock().position().depthZ());
        assertEquals(fromTile.layoutOrdinal(), detail.unlock().position().layoutOrdinal());
        assertEquals("personal-spiral-v1", detail.unlock().position().layoutVersion());
        assertEquals(detail.version(), tile.version(), "같은 지도 버전을 가리켜야 한다");
    }

    /** 카탈로그에 값이 없으면 필드를 빼지 않고 null을 준다(D-18). */
    @Test
    void 물리값이_없으면_필드를_빼지_않고_null이다() {
        long sparseTic = insertStar(11.2, null, null);
        unlock(memberId, sparseTic, 1);

        var star = stars.detail(memberId, sparseTic).star();

        assertEquals(11.2, star.tmag());
        assertNull(star.teffK(), "값이 없으면 null이다");
        assertNull(star.radiusRsun());
    }

    /** 관측 회차는 중복 없이 오름차순으로 준다. 같은 sector가 여러 판으로 들어올 수 있다. */
    @Test
    void 관측_회차는_중복_없이_오름차순이다() {
        insertObservation(ticId, 41, "v1");
        insertObservation(ticId, 14, "v1");
        insertObservation(ticId, 41, "v2");   // 같은 회차의 다른 판

        var star = stars.detail(memberId, ticId).star();

        assertEquals(List.of(14, 41), star.sectors());
        assertEquals(2, star.sectorCount());
    }

    /** 세 물리값을 모두 주고 확정 행성 보유 여부는 절대 넣지 않는다(HOME-04, AT-03). */
    @Test
    void 물리값_셋을_모두_주고_확정_보유_여부는_넣지_않는다() {
        var star = stars.detail(memberId, ticId).star();

        assertEquals(9.8, star.tmag());
        assertEquals(5600.0, star.teffK());
        assertEquals(0.95, star.radiusRsun());
        assertEquals(5, star.getClass().getRecordComponents().length,
                "확정 보유 여부·후보 수가 응답에 섞이면 안 된다");
    }

    // ---------- 공개 별 요약 (4.5) ----------

    /** 발견하지 않아도 부를 수 있다. 다만 분석은 잠겨 있다. */
    @Test
    void 공개_요약은_발견하지_않은_회원도_볼_수_있다() {
        var summary = stars.publicSummary(otherMemberId, ticId);

        assertEquals(String.valueOf(ticId), summary.ticId());
        assertTrue(summary.boardOpen());
        assertFalse(summary.unlockedForMe(), "이 회원은 아직 발견하지 않았다");
        assertFalse(summary.analysisAvailable());
        assertEquals(1, summary.discoveredMemberCount());
        assertEquals("b-" + bundleId, summary.currentBundleId());
    }

    /** 발견한 회원에게는 분석이 열린다. */
    @Test
    void 발견한_회원에게는_분석이_열린다() {
        var summary = stars.publicSummary(memberId, ticId);

        assertTrue(summary.unlockedForMe());
        assertTrue(summary.analysisAvailable());
    }

    /** 온도·반지름을 넣지 않는다. 감추는 게 아니라 이 화면에 자리가 없어서다(D-18). */
    @Test
    void 공개_요약은_밝기만_담는다() {
        var star = stars.publicSummary(otherMemberId, ticId).star();

        assertEquals(9.8, star.tmag());
        assertEquals(3, star.getClass().getRecordComponents().length,
                "온도·반지름이 섞이면 본인 상세와 구분이 사라진다");
    }

    /** 미공개 별과 없는 TIC을 같은 응답으로 덮는다. 구분되면 존재가 드러난다. */
    @Test
    void 미공개_별과_없는_TIC은_같은_404다() {
        long hidden = insertStar(10.0, null, null);
        jdbc.update("UPDATE stars SET service_status = 'hidden' WHERE tic_id = ?", hidden);
        unlock(memberId, hidden, 2);

        var forHidden = assertThrows(BusinessException.class,
                () -> stars.publicSummary(memberId, hidden));
        var forMissing = assertThrows(BusinessException.class,
                () -> stars.publicSummary(memberId, 999_999_999L));

        assertEquals(ErrorCode.STAR_NOT_PUBLISHED, forHidden.getErrorCode());
        assertEquals(forHidden.getErrorCode(), forMissing.getErrorCode(),
                "둘을 구분하면 있는 TIC과 없는 TIC을 가려낼 수 있게 된다");
    }

    /** 아무도 발견하지 않은 별은 게시판이 없으므로 같은 404다(AT-65). */
    @Test
    void 아무도_발견하지_않은_별도_404다() {
        long undiscovered = insertStar(10.0, null, null);

        var thrown = assertThrows(BusinessException.class,
                () -> stars.publicSummary(memberId, undiscovered));

        assertEquals(ErrorCode.STAR_NOT_PUBLISHED, thrown.getErrorCode());
    }

    /** 발견 회원 수는 사람 수로 센다. */
    @Test
    void 발견_회원_수는_사람_수다() {
        unlock(otherMemberId, ticId, 0);

        assertEquals(2, stars.publicSummary(memberId, ticId).discoveredMemberCount());
    }

    /** 후보 수·확정 보유 여부·타인 진행 상태는 어떤 경우에도 새지 않는다. */
    @Test
    void 공개_요약에_후보나_진행_정보가_섞이지_않는다() {
        long candidate = insertCandidate(true, 3.0, 1000, null);
        submit(memberId, candidate, "LIKELY_PLANET");
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, planet_count, progress_stage)"
                + " VALUES (?, ?, 1, 'in_progress')", memberId, ticId);

        var summary = stars.publicSummary(otherMemberId, ticId);

        assertEquals(7, summary.getClass().getRecordComponents().length,
                "필드가 늘면 무엇이 새는지 확인해야 한다");
        assertEquals(1, summary.discoveredMemberCount());
    }


    // ---------- 픽스처 ----------

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long insertStar(Double tmag, Double teffK, Double radiusRsun) {
        long id = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, teff_k, radius_rsun, tmag, confirmed_count,"
                + " service_status) VALUES (?, ?, ?, ?, 0, 'published')",
                id, teffK, radiusRsun, tmag);
        return id;
    }

    private void insertObservation(long star, int sector, String sourceVersion) {
        jdbc.update("INSERT INTO observation_datasets(tic_id, sector, start_btjd, end_btjd,"
                + " cadence, source_version, time_system)"
                + " VALUES (?, ?, 1500.0, 1527.0, '2min', ?, 'BTJD')", star, sector, sourceVersion);
    }

    private long insertBundle(long star) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, star, "v-" + UUID.randomUUID(), MANIFEST);
    }

    private void unlock(long member, long star, int ordinal) {
        var position = layout.place(ordinal);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                member, star, position.depthZ(), position.worldX(), position.worldY(),
                position.layoutVersion(), ordinal);
    }

    /** {@code disposition}이 null이면 판정 행을 만들지 않는다. 행이 없는 후보도 흔하다. */
    private long insertCandidate(boolean confirmed, double periodDays, int depthPpm,
                                 String disposition) {
        long id = jdbc.queryForObject("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, ?, 1501.0, 2.8, ?, 12.5, '{}'::jsonb, true, ?)"
                + " RETURNING id", Long.class, ticId, bundleId, periodDays, depthPpm, confirmed);
        if (disposition != null) {
            jdbc.update("INSERT INTO candidate_dispositions(candidate_id, disposition, answer_class,"
                    + " rule_version, applied_at, source_refs)"
                    + " VALUES (?, ?, 'graded', 'rule-0', now(), '{}'::jsonb)", id, disposition);
        }
        return id;
    }

    /**
     * 매칭한 제출. 성과 결과는 판단에 맞춰 고른다.
     *
     * <p>V5의 {@code ck_submissions_achievement_matches_result}가 matched 제출에 none을 허용하지
     * 않는다. 매칭했으면 성과 판정이 함께 나와야 한다는 규칙이다(GRD-02·03·04).
     */
    private void submit(long member, long candidateId, String judgment) {
        String achievement = "LIKELY_PLANET".equals(judgment) ? "recognized" : "judgment_mismatch";
        insertSubmission(member, "candidate", judgment, "matched", candidateId, achievement);
    }

    private void submitWithoutMatch(long member) {
        insertSubmission(member, "no_candidate", null, "not_matched", null, "none");
    }

    private void insertSubmission(long member, String kind, String judgment, String matchResult,
                                  Long candidateId, String achievementResult) {
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, ?, 0, '{}', ?, ?, ?, 1500.5, ?, '[]'::jsonb,"
                        + " ?, ?, ?, 'rm-1', 'pg-1', 'rule-0')",
                member, ticId, bundleId, UUID.randomUUID().toString(), kind,
                "candidate".equals(kind) ? 3.0 : null,
                "candidate".equals(kind) ? 0.1 : null,
                "candidate".equals(kind) ? 0.2 : null,
                judgment, matchResult, candidateId, achievementResult);
    }

    private void recognize(long member, long candidateId, String type) {
        long submissionId = jdbc.queryForObject(
                "SELECT id FROM submissions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
                Long.class, member);
        jdbc.update("INSERT INTO user_candidate_achievements(user_id, candidate_id,"
                        + " achievement_type, recognized_submission_id, recognized_at)"
                        + " VALUES (?, ?, ?, ?, now())",
                member, candidateId, type, submissionId);
    }

    private static PlanetItem itemOf(List<PlanetItem> items, long candidateId) {
        return items.stream()
                .filter(item -> item.candidateId().equals("c-" + candidateId))
                .findFirst().orElseThrow();
    }
}
