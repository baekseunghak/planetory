package com.planetory.backend.domain.exploration;

import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 탐사 도메인 제약 인수 조건 [S15P21C206-135].
 *
 * <p>실행마다 별도 스키마를 만들고 끝나면 지운다. 권한 검증은 클러스터 전역 상태라
 * {@link ExplorationDomainPermissionTest}에서 따로 한다.
 */
@ActiveProfiles("local")
@SpringBootTest
class ExplorationDomainSchemaTest {

    private static final String SCHEMA =
            "exploration_test_" + UUID.randomUUID().toString().replace("-", "");

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

    @Autowired JdbcTemplate jdbc;

    private long userId;
    private long ticId;
    private long bundleId;
    private long candidateId;

    @BeforeEach
    void seed() {
        String unique = UUID.randomUUID().toString();
        userId = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);

        ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published')", ticId);

        bundleId = jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, "v-" + unique, MANIFEST);

        candidateId = jdbc.queryForObject("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, 3.0, 1501.0, 2.8, 900, 12.5, '{}'::jsonb, true, true)"
                + " RETURNING id", Long.class, ticId, bundleId);

        jdbc.update("INSERT INTO operation_settings(rule_version, \"values\", applied_at, note)"
                + " VALUES ('r-1', '{}'::jsonb, now(), 'test') ON CONFLICT DO NOTHING");
    }

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

    // ---------- submissions ----------

    /** 위상 선택이 없는 제출에는 서버 파생값도 없어야 한다. */
    @Test
    void 선택이_없는_제출에_파생값이_있으면_거절된다() {
        assertDoesNotThrow(() -> insertSkipped(builder -> builder));

        assertThrows(DataIntegrityViolationException.class,
                () -> insertSkipped(b -> b.epochBtjd("1501.0")),
                "건너뛰기 제출에 epoch가 있을 수 없다");
        assertThrows(DataIntegrityViolationException.class,
                () -> insertSkipped(b -> b.durationHours("2.8")),
                "건너뛰기 제출에 duration이 있을 수 없다");
        assertThrows(DataIntegrityViolationException.class,
                () -> insertSkipped(b -> b.matchedPeriod("3.0")),
                "건너뛰기 제출에 정정 주기가 있을 수 없다");
    }

    /** 성과 결과는 매칭 결과와 함께 성립한다(GRD-02·03·04, SUB-06). */
    @Test
    void 매칭하지_못한_제출에_성과가_인정되면_거절된다() {
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("not_matched").matchedCandidate(null)
                        .achievementResult("recognized")),
                "매칭 실패에 성과를 인정할 수 없다");
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("ambiguous_match").matchedCandidate(null)
                        .achievementResult("judgment_mismatch")));
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("matched").achievementResult("already_recognized")),
                "already_recognized는 duplicate에서만 나온다");
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("duplicate").achievementResult("none")),
                "duplicate는 already_recognized여야 한다");

        assertDoesNotThrow(() -> insertCandidate(b -> b.matchResult("matched")
                .achievementResult("recognized")));
        assertDoesNotThrow(() -> insertCandidate(b -> b.matchResult("duplicate")
                .achievementResult("already_recognized")));
        assertDoesNotThrow(() -> insertCandidate(b -> b.matchResult("not_matched")
                .matchedCandidate(null).achievementResult("none")));
    }

    /** 고조파 정정 기록은 실제로 정정했을 때만 남긴다(SUB-04·05). */
    @Test
    void 정정하지_않은_제출에_정정_기록이_있으면_거절된다() {
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("matched").achievementResult("recognized")
                        .matchedPeriod("6.0")),
                "정정이 없는데 정정 주기가 있을 수 없다");
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("matched").achievementResult("recognized")
                        .harmonicMultiplier("2")));
        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("matched").achievementResult("recognized")
                        .correctionReason("P/2 alias")));

        assertThrows(DataIntegrityViolationException.class,
                () -> insertCandidate(b -> b.matchResult("matched_harmonic")
                        .achievementResult("recognized")),
                "고조파 정정이면 정정 주기와 배율이 있어야 한다");

        assertDoesNotThrow(() -> insertCandidate(b -> b.matchResult("matched_harmonic")
                .achievementResult("recognized").matchedPeriod("6.0").harmonicMultiplier("2")
                .correctionReason("P/2 alias")));
    }

    // ---------- star_unlocks ----------

    /** 회원 안에서 배치 순번은 겹칠 수 없다. 겹치면 두 별이 같은 자리에 놓인다. */
    @Test
    void 같은_회원의_배치_순번은_중복될_수_없다() {
        long otherTic = insertStar();
        insertUnlock(ticId, 0);

        assertThrows(DataIntegrityViolationException.class, () -> insertUnlock(otherTic, 0));

        assertDoesNotThrow(() -> insertUnlock(otherTic, 1));
        assertEquals(2, jdbc.queryForObject(
                "SELECT count(*) FROM star_unlocks WHERE user_id = ?", Integer.class, userId));
    }

    @Test
    void 배치_순번은_음수일_수_없다() {
        assertThrows(DataIntegrityViolationException.class, () -> insertUnlock(ticId, -1));
    }

    // ---------- challenge_rounds ----------

    /** 퀘스트 패널과 챌린지 별 발견이 진행 회차 하나를 전제한다(HOME-02·07). */
    @Test
    void 진행_중인_챌린지_회차는_하나뿐이다() {
        insertRound(1, "active");

        assertThrows(DataIntegrityViolationException.class, () -> insertRound(2, "active"));

        assertDoesNotThrow(() -> insertRound(3, "planned"));
        assertDoesNotThrow(() -> insertRound(4, "planned"));
        assertDoesNotThrow(() -> insertRound(5, "closed"));
        assertDoesNotThrow(() -> insertRound(6, "closed"));
    }

    // ---------- 완료 조건 (4) ----------

    /** 은퇴 후보·보관 판을 참조하는 과거 제출이 그대로 남아야 한다. */
    @Test
    void 후보가_은퇴하고_판이_보관돼도_과거_제출이_유지된다() {
        long submissionId = insertCandidate(b -> b.matchResult("matched")
                .achievementResult("recognized"));

        jdbc.update("UPDATE candidates SET status = 'retired' WHERE id = ?", candidateId);
        jdbc.update("UPDATE publication_bundles SET status = 'archived' WHERE id = ?", bundleId);

        assertEquals(1, jdbc.queryForObject(
                "SELECT count(*) FROM submissions WHERE id = ?", Integer.class, submissionId));
        assertEquals(candidateId, jdbc.queryForObject(
                "SELECT matched_candidate_id FROM submissions WHERE id = ?", Long.class, submissionId));
    }

    // ---------- 픽스처 ----------

    private long insertStar() {
        long id = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published')", id);
        return id;
    }

    private void insertUnlock(long unlockedTicId, int layoutOrdinal) {
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', 0.0, now(), 1.0, 2.0, 'personal-spiral-v1', ?)",
                userId, unlockedTicId, layoutOrdinal);
    }

    private void insertRound(int roundNo, String status) {
        jdbc.update("INSERT INTO challenge_rounds"
                        + "(round_no, starts_on, ends_on, target_tic_id, description, status)"
                        + " VALUES (?, '2026-09-01', '2026-09-07', ?, 'test', ?)",
                roundNo, ticId, status);
    }

    private long insertSkipped(java.util.function.UnaryOperator<Submission> customize) {
        return insert(customize.apply(new Submission()
                .kind("skipped").matchResult("skipped").achievementResult("none")));
    }

    private long insertCandidate(java.util.function.UnaryOperator<Submission> customize) {
        return insert(customize.apply(new Submission().kind("candidate")
                .judgment("LIKELY_PLANET").submittedPeriod("3.0")
                .phase("0.10", "0.20").epochBtjd("1501.0").durationHours("2.4")
                .matchResult("matched").matchedCandidate(candidateId)
                .achievementResult("recognized")));
    }

    private long insert(Submission s) {
        return jdbc.queryForObject("INSERT INTO submissions"
                        + "(user_id, tic_id, bundle_id, request_id, submission_kind, curve_step,"
                        + " removed_candidate_ids, submitted_period, matched_period, harmonic_multiplier,"
                        + " correction_reason, phase_start, phase_end, fold_reference_time_btjd,"
                        + " epoch_btjd, duration_hours, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, ?, 1, '{}', ?::numeric, ?::numeric, ?::numeric, ?,"
                        + " ?::numeric, ?::numeric, 1500.5, ?::numeric, ?::numeric, ?, '{}'::jsonb, ?, ?,"
                        + " ?, 'rm-1', 'pg-1', 'r-1') RETURNING id",
                Long.class, userId, ticId, bundleId, UUID.randomUUID().toString(), s.kind,
                s.submittedPeriod, s.matchedPeriod, s.harmonicMultiplier, s.correctionReason,
                s.phaseStart, s.phaseEnd, s.epochBtjd, s.durationHours, s.judgment,
                s.matchResult, s.matchedCandidateId, s.achievementResult);
    }

    /** 제약별로 한 열만 바꿔 넣기 위한 가변 픽스처. */
    private static final class Submission {
        String kind;
        String judgment;
        String submittedPeriod;
        String matchedPeriod;
        String harmonicMultiplier;
        String correctionReason;
        String phaseStart;
        String phaseEnd;
        String epochBtjd;
        String durationHours;
        String matchResult;
        Long matchedCandidateId;
        String achievementResult;

        Submission kind(String v) { this.kind = v; return this; }
        Submission judgment(String v) { this.judgment = v; return this; }
        Submission submittedPeriod(String v) { this.submittedPeriod = v; return this; }
        Submission matchedPeriod(String v) { this.matchedPeriod = v; return this; }
        Submission harmonicMultiplier(String v) { this.harmonicMultiplier = v; return this; }
        Submission correctionReason(String v) { this.correctionReason = v; return this; }
        Submission phase(String start, String end) { this.phaseStart = start; this.phaseEnd = end; return this; }
        Submission epochBtjd(String v) { this.epochBtjd = v; return this; }
        Submission durationHours(String v) { this.durationHours = v; return this; }
        Submission matchResult(String v) { this.matchResult = v; return this; }
        Submission matchedCandidate(Long v) { this.matchedCandidateId = v; return this; }
        Submission achievementResult(String v) { this.achievementResult = v; return this; }
    }

    /** 사용하지 않는 경고를 막기 위한 참조. */
    @SuppressWarnings("unused")
    private static final List<String> DOCUMENTED_TABLES = List.of(
            "submissions", "star_unlocks", "challenge_rounds");
}
