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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.planetory.backend.domain.exploration.service.AnalysisViews;
import com.planetory.backend.domain.exploration.service.BundleActivationService;
import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.ResidualJobStore;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 판 전환 후처리 [S15P21C206-150].
 *
 * <p>탐사 API 9.3·10장을 따른다. 알림은 늦게 오거나 두 번 올 수 있으므로 같은 판을 다시
 * 처리해도 결과가 같아야 한다. 실행마다 별도 스키마를 쓴다.
 */
@ActiveProfiles("local")
@SpringBootTest
@Testcontainers
class BundleActivationTest {

    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");

    private static final String SCHEMA =
            "bundle_activation_" + UUID.randomUUID().toString().replace("-", "");

    private static final long TIC = 4001;

    /** Gold 판 manifest 필수 키(V3). 값은 이 테스트와 무관하다. */
    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", DB::getJdbcUrl);
        registry.add("spring.datasource.username", DB::getUsername);
        registry.add("spring.datasource.password", DB::getPassword);
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired BundleActivationService activation;
    @Autowired ResidualJobStore residualJobs;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    private long bundleId;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", TIC);
        bundleId = insertBundle("current");
    }

    /** 완료한 별에 탐색 가능한 미매칭 후보가 생기면 다시 열고 사건을 남긴다(9.3절). */
    @Test
    void 새_탐색가능_후보가_생기면_완료한_별을_재개하고_사건을_남긴다() {
        long member = member();
        complete(member, "undiscoverable_only");
        insertCandidate(true);

        var result = activation.onBundleActivated(bundleId);

        assertTrue(result.applied());
        assertEquals(TIC, result.ticId());
        assertEquals(1, result.reopened());
        assertEquals(0, result.completed());
        assertEquals("in_progress", stage(member));
        assertNotNull(column(member, "reopened_at"));
        assertFalse(jdbc.queryForObject("SELECT reopen_pending FROM user_star_progress WHERE user_id = ?",
                Boolean.class, member));
        // 튜토리얼 완료와 챌린지 자격이 completed_at으로 유지된다(4.3절). 재개가 거둬들이면 안 된다.
        assertNotNull(column(member, "completed_at"));
        assertEquals(1, reopenEvents(member));
        assertEquals(1, jdbc.queryForObject("SELECT (payload ->> 'newDiscoverableCount')::int FROM notifications"
                + " WHERE user_id = ? AND type = 'reopen'", Integer.class, member));
        assertEquals(String.valueOf(bundleId), jdbc.queryForObject(
                "SELECT payload ->> 'bundleId' FROM notifications WHERE user_id = ?", String.class, member));
        // 근거 없는 사유는 담지 않는다. candidate_status_history를 남길 Publisher(-87)가 아직 없다.
        assertFalse(jdbc.queryForObject("SELECT jsonb_exists(payload, 'reason') FROM notifications"
                + " WHERE user_id = ?", Boolean.class, member));
    }

    /** 같은 판의 알림이 다시 와도 재개 사건은 하나다(150 완료 조건). */
    @Test
    void 같은_판을_다시_처리해도_재개_사건은_하나다() {
        long member = member();
        complete(member, "undiscoverable_only");
        insertCandidate(true);

        activation.onBundleActivated(bundleId);
        var again = activation.onBundleActivated(bundleId);

        // 두 번째 실행에는 이미 in_progress라 재개 대상이 아니고, 완료 판정도 바뀌지 않는다.
        assertEquals(0, again.reopened());
        assertEquals(0, again.completed());
        assertEquals("in_progress", stage(member));
        assertEquals(1, reopenEvents(member));
        assertEquals(1, (int) jdbc.queryForObject("SELECT count(*) FROM notifications", Integer.class));
    }

    /** 탐색 불가 후보만 늘어난 전환은 재개 사유가 아니다. */
    @Test
    void 탐색불가_후보만_생기면_재개하지_않는다() {
        long member = member();
        complete(member, "all_found");
        insertCandidate(false);

        var result = activation.onBundleActivated(bundleId);

        assertEquals(0, result.reopened());
        assertEquals("completed", stage(member));
        assertNull(column(member, "reopened_at"));
        assertEquals(0, reopenEvents(member));
    }

    /** 늦게 도착한 지난 판의 알림. 정본은 DB의 current다(10장). */
    @Test
    void 지난_판의_알림은_아무것도_바꾸지_않는다() {
        long member = member();
        complete(member, "undiscoverable_only");
        insertCandidate(true);
        long stale = insertBundle("archived");

        var result = activation.onBundleActivated(stale);

        assertFalse(result.applied());
        assertEquals("completed", stage(member));
        assertEquals(0, reopenEvents(member));
    }

    /**
     * 진행 중인 별은 완료 재판정만 받는다(9.3절 (c)).
     *
     * <p>같은 실행에서 완료로 바꾼 회원을 다시 열지 않는다. 한 번의 전환이 완료와 재개를
     * 함께 만들면 안 된다.
     */
    @Test
    void 진행_중인_별은_완료_재판정만_하고_재개하지_않는다() {
        long member = member();
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage) VALUES (?, ?, 'in_progress')",
                member, TIC);
        // 탐색 가능한 후보는 이미 매칭했고 탐색 불가 후보만 남았다.
        submit(member, insertCandidate(true));
        insertCandidate(false);

        var result = activation.onBundleActivated(bundleId);

        assertEquals(1, result.completed());
        assertEquals(0, result.reopened());
        assertEquals("completed", stage(member));
        assertEquals("undiscoverable_only", jdbc.queryForObject(
                "SELECT completion_reason FROM user_star_progress WHERE user_id = ?", String.class, member));
        assertNull(column(member, "reopened_at"));
        assertEquals(0, reopenEvents(member));
    }

    /** 탈퇴 회원은 후처리 대상이 아니다. */
    @Test
    void 탈퇴한_회원은_후처리하지_않는다() {
        long member = member();
        complete(member, "undiscoverable_only");
        insertCandidate(true);
        jdbc.update("UPDATE users SET status = 'withdrawn', withdrawn_at = now() WHERE id = ?", member);

        var result = activation.onBundleActivated(bundleId);

        assertEquals(0, result.reopened());
        assertEquals("completed", stage(member));
        assertEquals(0, reopenEvents(member));
    }

    /** 배포 계정이 쓰는 planetory_app 역할로도 재개와 사건 기록이 된다(V22). */
    @Test
    void 앱_역할로도_재개와_사건_기록이_된다() {
        long member = member();
        complete(member, "undiscoverable_only");
        insertCandidate(true);

        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            assertEquals(1, activation.onBundleActivated(bundleId).reopened());
        });

        assertEquals("in_progress", stage(member));
        assertEquals(1, reopenEvents(member));
    }

    // ---------- 9.5 외부 라벨 표식 ----------

    /** 라벨이 바뀌면 표식만 남기고 성과·등급·발견 별·통계는 건드리지 않는다(9.5절, GRD-06). */
    @Test
    void 라벨이_바뀐_성과에_표식을_남기고_성과_자체는_바꾸지_않는다() {
        long member = member();
        long candidate = insertCandidate(true);
        long achievement = recognize(member, candidate, "unconfirmed");
        var before = achievementSnapshot();
        var relabeledAt = disposition(candidate, "confirmed");

        var result = activation.onBundleActivated(bundleId);

        assertEquals(1, result.relabeled());
        assertEquals(relabeledAt, jdbc.queryForObject(
                "SELECT relabeled_at FROM user_candidate_achievements WHERE id = ?",
                java.time.OffsetDateTime.class, achievement));
        assertEquals("confirmed", jdbc.queryForObject(
                "SELECT relabel_disposition FROM user_candidate_achievements WHERE id = ?",
                String.class, achievement));
        // 성과 유형·인정 근거·인정 시각은 그대로다. 등급은 이 값들로 계산하므로 함께 보존된다.
        assertEquals(before, achievementSnapshot());
        assertEquals(0, (int) jdbc.queryForObject("SELECT count(*) FROM star_unlocks", Integer.class));
        assertEquals(0, (int) jdbc.queryForObject("SELECT count(*) FROM stats_snapshots", Integer.class));
    }

    /** 같은 이력을 다시 받아도 표식이 늘거나 바뀌지 않는다(150 완료 조건). */
    @Test
    void 같은_라벨_이력을_다시_받아도_표식은_그대로다() {
        long member = member();
        long candidate = insertCandidate(true);
        recognize(member, candidate, "unconfirmed");
        disposition(candidate, "fp");

        assertEquals(1, activation.onBundleActivated(bundleId).relabeled());
        var marked = relabelSnapshot();
        assertEquals(0, activation.onBundleActivated(bundleId).relabeled());
        assertEquals(marked, relabelSnapshot());
    }

    /** 라벨이 그대로면 표식을 남기지 않는다. pc↔none은 회원에게 같은 미확정이다(6.4절). */
    @Test
    void 회원에게_보이는_판정이_같으면_표식을_남기지_않는다() {
        long member = member();
        long unchanged = insertCandidate(true);
        long invisible = insertCandidate(true);
        recognize(member, unchanged, "fp");
        recognize(member, invisible, "unconfirmed");
        disposition(unchanged, "fp");
        disposition(invisible, "none");

        var result = activation.onBundleActivated(bundleId);

        assertEquals(0, result.relabeled());
        assertEquals(0, (int) jdbc.queryForObject(
                "SELECT count(*) FROM user_candidate_achievements WHERE relabeled_at IS NOT NULL", Integer.class));
    }

    /** 인정보다 먼저 적용된 판정은 이번 전환이 바꾼 것이 아니다. */
    @Test
    void 인정보다_오래된_판정은_표식_대상이_아니다() {
        long member = member();
        long candidate = insertCandidate(true);
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id, disposition, answer_class, rule_version,"
                + " applied_at, source_refs) VALUES (?, 'confirmed', 'graded', 'rule-0', now() - interval '1 day',"
                + " '{}'::jsonb)", candidate);
        recognize(member, candidate, "unconfirmed");

        assertEquals(0, activation.onBundleActivated(bundleId).relabeled());
        assertEquals(0, (int) jdbc.queryForObject(
                "SELECT count(*) FROM user_candidate_achievements WHERE relabeled_at IS NOT NULL", Integer.class));
    }

    // ---------- 10장 (1) 이전 판 캐시 정리 ----------

    /** 이전 판 키만 버리고 현재 판 키는 남긴다. 다시 실행하면 버릴 것이 없다. */
    @Test
    void 이전_판_잔차_캐시만_정리한다() {
        long previous = insertBundle("archived");
        // 회원당 진행 작업은 하나다(planetory.residual.per-member). 두 작업을 함께 두려면 회원도 둘이다.
        String stale = enqueue(member(), previous);
        String fresh = enqueue(member(), bundleId);

        var result = activation.onBundleActivated(bundleId);

        assertEquals(1, result.evicted());
        assertTrue(residualJobs.active(stale).isEmpty(), "이전 판 작업은 남지 않는다");
        assertTrue(residualJobs.active(fresh).isPresent(), "현재 판 작업은 그대로다");
        assertEquals(0, activation.onBundleActivated(bundleId).evicted());
    }

    // ---------- 도우미 ----------

    private long member() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long insertBundle(String status) {
        return jdbc.queryForObject("INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest,"
                + " fold_reference_time_btjd, base_days) VALUES (?, ?, ?, ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, TIC, "v-" + UUID.randomUUID(), status, MANIFEST);
    }

    private long insertCandidate(boolean discoverable) {
        return jdbc.queryForObject("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step,"
                + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model, discoverable,"
                + " is_confirmed) VALUES (?, 'active', ?, 1, 3.5, 1501.0, 2.8, 400, 12.5, '{}'::jsonb, ?, false)"
                + " RETURNING id", Long.class, TIC, bundleId, discoverable);
    }

    /** 후보 하나를 매칭한 제출. 완료 판정이 보는 것은 matched_candidate_id뿐이다. */
    private long submit(long member, long candidate) {
        return jdbc.queryForObject("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end, user_judgment,"
                + " fold_reference_time_btjd, evidence_checks, match_result, matched_candidate_id,"
                + " achievement_result, residual_model_version, periodogram_config_version, rule_version)"
                + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.5, 0.4, 0.6, 'LIKELY_PLANET', 1500.5,"
                + " '[]'::jsonb, 'matched', ?, 'recognized', 'rm-1', 'pg-1', 'rule-0') RETURNING id",
                Long.class, member, TIC, bundleId, UUID.randomUUID().toString(), candidate);
    }

    private void complete(long member, String reason) {
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason,"
                + " reopen_pending, completed_at) VALUES (?, ?, 'completed', ?, ?, now())",
                member, TIC, reason, "undiscoverable_only".equals(reason));
    }

    private String stage(long member) {
        return jdbc.queryForObject("SELECT progress_stage FROM user_star_progress WHERE user_id = ?",
                String.class, member);
    }

    private Object column(long member, String name) {
        return jdbc.queryForObject("SELECT " + name + " FROM user_star_progress WHERE user_id = ?",
                Object.class, member);
    }

    private int reopenEvents(long member) {
        return jdbc.queryForObject("SELECT count(*) FROM notifications WHERE user_id = ? AND type = 'reopen'",
                Integer.class, member);
    }

    /** 성과 한 건을 인정된 상태로 넣는다. 인정 경로(9.2절)의 부작용은 이 테스트의 관심이 아니다. */
    private long recognize(long member, long candidate, String type) {
        return jdbc.queryForObject("INSERT INTO user_candidate_achievements(user_id, candidate_id,"
                + " achievement_type, recognized_submission_id, recognized_at) VALUES (?, ?, ?, ?, now())"
                + " RETURNING id", Long.class, member, candidate, type, submit(member, candidate));
    }

    /** 배치가 적재한 현재 판정. 적용 시각이 표식의 relabeled_at이 된다. */
    private java.time.OffsetDateTime disposition(long candidate, String value) {
        return jdbc.queryForObject("INSERT INTO candidate_dispositions(candidate_id, disposition, answer_class,"
                + " rule_version, applied_at, source_refs) VALUES (?, ?, 'graded', 'rule-0', now(), '{}'::jsonb)"
                + " RETURNING applied_at", java.time.OffsetDateTime.class, candidate, value);
    }

    /** 표식 외의 성과 열. 라벨 갱신이 이 값을 바꾸면 안 된다. */
    private String achievementSnapshot() {
        return jdbc.queryForObject("SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'type', achievement_type,"
                + " 'submission', recognized_submission_id, 'analysis', recognized_analysis_id,"
                + " 'at', recognized_at) ORDER BY id), '[]'::jsonb)::text"
                + " FROM user_candidate_achievements", String.class);
    }

    private String relabelSnapshot() {
        return jdbc.queryForObject("SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', relabeled_at,"
                + " 'disposition', relabel_disposition) ORDER BY id), '[]'::jsonb)::text"
                + " FROM user_candidate_achievements", String.class);
    }

    /** 잔차 작업 하나를 등록하고 캐시 키를 돌려준다. */
    private String enqueue(long member, long bundle) {
        var target = new AnalysisViews.CurveContext(ExplorationIds.bundle(bundle), 0, List.of(), "rm-1", "pg-1");
        String key = ResidualJobStore.cacheKey(TIC, target);
        residualJobs.enqueue(member, TIC, target, key);
        return key;
    }
}
