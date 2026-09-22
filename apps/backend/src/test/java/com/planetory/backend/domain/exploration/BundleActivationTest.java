package com.planetory.backend.domain.exploration;

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

import com.planetory.backend.domain.exploration.service.BundleActivationService;

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
    private void submit(long member, long candidate) {
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind, curve_step,"
                + " removed_candidate_ids, submitted_period, phase_start, phase_end, user_judgment,"
                + " fold_reference_time_btjd, evidence_checks, match_result, matched_candidate_id,"
                + " achievement_result, residual_model_version, periodogram_config_version, rule_version)"
                + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.5, 0.4, 0.6, 'LIKELY_PLANET', 1500.5,"
                + " '[]'::jsonb, 'matched', ?, 'recognized', 'rm-1', 'pg-1', 'rule-0')",
                member, TIC, bundleId, UUID.randomUUID().toString(), candidate);
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
}
