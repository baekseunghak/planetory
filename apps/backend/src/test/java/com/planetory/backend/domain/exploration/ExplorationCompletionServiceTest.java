package com.planetory.backend.domain.exploration;

import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.ExplorationCompletionPolicy.Decision;
import com.planetory.backend.domain.exploration.service.ExplorationCompletionService;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 완료 판정의 DB 집계와 진행 행 전환 [S15P21C206-149]. */
@ActiveProfiles("local")
@SpringBootTest
@Transactional
class ExplorationCompletionServiceTest {

    private static final String SCHEMA =
            "completion_test_" + UUID.randomUUID().toString().replace("-", "");

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

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
    @Autowired ExplorationCompletionService completion;
    @Autowired PlatformTransactionManager transactionManager;

    private long memberId;
    private long ticId;
    private long bundleId;

    @BeforeEach
    void seed() {
        // operation_settings는 비우지 않는다. V9가 넣은 rule-0을 제출이 참조한다.
        jdbc.execute("TRUNCATE users, stars CASCADE");

        String unique = UUID.randomUUID().toString();
        memberId = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
        ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published')", ticId);
        bundleId = jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, "v-" + unique, MANIFEST);
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage)"
                + " VALUES (?, ?, 'in_progress')", memberId, ticId);
    }

    @Test
    void 활성_후보가_없으면_무신호_별을_완료하지_않는다() {
        assertEquals(Decision.NOT_APPLICABLE, evaluate());
        assertProgress("in_progress", null, false);
    }

    @Test
    void 탐색_가능한_미매칭_후보가_남으면_진행_상태를_유지한다() {
        insertCandidate("active", true);
        insertCandidate("active", false);

        assertEquals(Decision.KEEP_IN_PROGRESS, evaluate());
        assertProgress("in_progress", null, false);
    }

    @Test
    void 마지막_신호의_판단이_틀리거나_보류여도_매칭했으면_완료한다() {
        long wrong = insertCandidate("active", true);
        long unsure = insertCandidate("active", true);
        insertMatchedSubmission(wrong, "UNLIKELY_PLANET", "matched");
        insertMatchedSubmission(unsure, "UNSURE", "matched");

        assertEquals(Decision.COMPLETE_ALL_FOUND, evaluate());
        assertProgress("completed", "all_found", false);
        assertNotNull(jdbc.queryForObject("SELECT completed_at FROM user_star_progress"
                + " WHERE user_id = ? AND tic_id = ?", OffsetDateTime.class, memberId, ticId));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements",
                Integer.class));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM star_unlocks", Integer.class));
    }

    @Test
    void 탐색_불가능한_후보만_남으면_완료하고_재개를_기다린다() {
        insertCandidate("active", false);

        assertEquals(Decision.COMPLETE_UNDISCOVERABLE_ONLY, evaluate());
        assertProgress("completed", "undiscoverable_only", true);
    }

    @Test
    void 은퇴한_미매칭_후보는_완료를_막지_않는다() {
        long active = insertCandidate("active", true);
        insertCandidate("retired", true);
        insertMatchedSubmission(active, "LIKELY_PLANET", "matched");

        assertEquals(Decision.COMPLETE_ALL_FOUND, evaluate());
        assertProgress("completed", "all_found", false);
    }

    @Test
    void 이전_판에서_매칭한_후보도_누적_발견으로_인정한다() {
        long candidate = insertCandidate("active", true);
        insertMatchedSubmission(candidate, "LIKELY_PLANET", "matched");

        jdbc.update("UPDATE publication_bundles SET status = 'archived' WHERE id = ?", bundleId);
        jdbc.update("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4)",
                ticId, "v-next-" + UUID.randomUUID(), MANIFEST);

        assertEquals(Decision.COMPLETE_ALL_FOUND, evaluate());
        assertProgress("completed", "all_found", false);
    }

    @Test
    void 배음과_중복_매칭도_누적_발견으로_인정한다() {
        long harmonic = insertCandidate("active", true);
        long duplicate = insertCandidate("active", true);
        insertMatchedSubmission(harmonic, "LIKELY_PLANET", "matched_harmonic");
        insertMatchedSubmission(duplicate, "LIKELY_PLANET", "duplicate");

        assertEquals(Decision.COMPLETE_ALL_FOUND, evaluate());
        assertProgress("completed", "all_found", false);
    }

    @Test
    void 현재_판이_없으면_활성_후보가_있어도_완료하지_않는다() {
        insertCandidate("active", true);
        jdbc.update("UPDATE publication_bundles SET status = 'archived' WHERE id = ?", bundleId);

        assertEquals(Decision.NOT_APPLICABLE, evaluate());
        assertProgress("in_progress", null, false);
    }

    @Test
    void 이미_완료한_진행_행은_다시_판정하지_않는다() {
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'completed',"
                + " completion_reason = 'skipped', completed_at = now()"
                + " WHERE user_id = ? AND tic_id = ?", memberId, ticId);
        insertCandidate("active", true);

        assertTrue(completion.evaluateAndApply(memberId, ticId).isEmpty());
        assertProgress("completed", "skipped", false);
    }

    @Test
    void 재개한_별을_다시_완료해도_최초_완료_시각을_보존한다() {
        OffsetDateTime firstCompletedAt = OffsetDateTime.parse("2026-09-01T00:00:00+09:00");
        jdbc.update("UPDATE user_star_progress SET completed_at = ?, reopened_at = now()"
                + " WHERE user_id = ? AND tic_id = ?", firstCompletedAt, memberId, ticId);
        long candidate = insertCandidate("active", true);
        insertMatchedSubmission(candidate, "LIKELY_PLANET", "matched");

        assertEquals(Decision.COMPLETE_ALL_FOUND, evaluate());
        assertProgress("completed", "all_found", false);
        OffsetDateTime stored = jdbc.queryForObject("SELECT completed_at FROM user_star_progress"
                + " WHERE user_id = ? AND tic_id = ?", OffsetDateTime.class, memberId, ticId);
        assertEquals(firstCompletedAt.toInstant(), stored.toInstant());
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void 같은_회원과_별을_동시에_판정해도_한_번만_완료한다() throws Exception {
        long candidate = insertCandidate("active", true);
        insertMatchedSubmission(candidate, "LIKELY_PLANET", "matched");

        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        Callable<Optional<Decision>> task = () -> {
            if (!start.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("동시 실행 시작 신호를 받지 못했습니다");
            }
            return transaction.execute(status -> completion.evaluateAndApply(memberId, ticId));
        };

        try {
            Future<Optional<Decision>> first = pool.submit(task);
            Future<Optional<Decision>> second = pool.submit(task);
            start.countDown();

            Optional<Decision> firstResult = first.get(10, TimeUnit.SECONDS);
            Optional<Decision> secondResult = second.get(10, TimeUnit.SECONDS);
            long completedCalls = java.util.stream.Stream.of(firstResult, secondResult)
                    .filter(Optional::isPresent)
                    .count();

            assertEquals(1, completedCalls);
            assertTrue(firstResult.isEmpty() || secondResult.isEmpty());
            assertProgress("completed", "all_found", false);
            assertNotNull(jdbc.queryForObject("SELECT completed_at FROM user_star_progress"
                    + " WHERE user_id = ? AND tic_id = ?", OffsetDateTime.class, memberId, ticId));
        } finally {
            pool.shutdownNow();
        }
    }

    private Decision evaluate() {
        Optional<Decision> result = completion.evaluateAndApply(memberId, ticId);
        assertTrue(result.isPresent());
        return result.orElseThrow();
    }

    private long insertCandidate(String status, boolean discoverable) {
        return jdbc.queryForObject("INSERT INTO candidates"
                        + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                        + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                        + " VALUES (?, ?, ?, 1, 3.0, 1501.0, 2.4, 900, 12.5, '{}'::jsonb, ?, true)"
                        + " RETURNING id",
                Long.class, ticId, status, bundleId, discoverable);
    }

    private void insertMatchedSubmission(long candidateId, String judgment, String matchResult) {
        Double matchedPeriod = "matched_harmonic".equals(matchResult) ? 6.0 : null;
        Double harmonicMultiplier = "matched_harmonic".equals(matchResult) ? 2.0 : null;
        String achievementResult = "duplicate".equals(matchResult)
                ? "already_recognized"
                : "judgment_mismatch";
        jdbc.update("INSERT INTO submissions"
                        + "(user_id, tic_id, bundle_id, request_id, submission_kind, curve_step,"
                        + " removed_candidate_ids, submitted_period, matched_period, harmonic_multiplier,"
                        + " phase_start, phase_end,"
                        + " fold_reference_time_btjd, epoch_btjd, duration_hours, user_judgment,"
                        + " evidence_checks, match_result, matched_candidate_id, achievement_result,"
                        + " residual_model_version, periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', 1, '{}', 3.0, ?, ?, 0.1, 0.2,"
                        + " 1500.5, 1501.0, 2.4, ?, '{}'::jsonb, ?, ?, ?, 'rm-1', 'pg-1', 'rule-0')",
                memberId, ticId, bundleId, UUID.randomUUID().toString(), matchedPeriod,
                harmonicMultiplier, judgment, matchResult, candidateId, achievementResult);
    }

    private void assertProgress(String stage, String reason, boolean reopenPending) {
        ProgressRow row = jdbc.queryForObject(
                "SELECT progress_stage, completion_reason, reopen_pending"
                        + " FROM user_star_progress WHERE user_id = ? AND tic_id = ?",
                (rs, rowNum) -> new ProgressRow(rs.getString("progress_stage"),
                        rs.getString("completion_reason"), rs.getBoolean("reopen_pending")),
                memberId, ticId);
        assertNotNull(row);
        assertEquals(stage, row.stage());
        assertEquals(reason, row.reason());
        assertEquals(reopenPending, row.reopenPending());
    }

    private record ProgressRow(String stage, String reason, boolean reopenPending) {
    }
}
