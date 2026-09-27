package com.planetory.backend.domain.exploration;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.core.io.support.PropertiesLoaderUtils;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import com.planetory.backend.domain.exploration.service.OperationRule;
import com.planetory.backend.domain.exploration.service.OperationRuleRepository;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 운영 규칙 버전·튜토리얼·챌린지 설정 검증 [S15P21C206-151].
 *
 * <p>운영 화면 없이 SQL로 넣는 설정을 DB가 저장 순간 거절하는지 본다(AT-41, OPS-04·07·08). 규칙 행은
 * 지울 수 없으므로 이 클래스가 넣는 규칙은 모두 되돌리는 트랜잭션 안에서 넣는다. 실행마다 별도 스키마를 쓴다.
 */
@ActiveProfiles("local")
@SpringBootTest
class OperationRulesTest {

    private static final String SCHEMA =
            "operation_rules_" + UUID.randomUUID().toString().replace("-", "");

    /** 마이그레이션 적용·되돌림 시나리오가 따로 만드는 스키마. */
    private static final List<String> SCENARIO_SCHEMAS = new ArrayList<>();

    private static final String INIT_SQLS = "spring.flyway.init-sqls";
    /** 배포처럼 설정이 없는 연결. 풀 연결에는 앞선 마이그레이션이 준 설정이 남아 있을 수 있어 지운다. */
    private static final String NO_SETTING = "RESET planetory.tutorial_skip_after";
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private static final long PUBLISHED = 7001;
    private static final long HIDDEN = 7002;
    private static final long MISSING = 7999;

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @AfterAll
    static void dropOnlyTestSchemas(@Autowired DataSource dataSource) {
        JdbcTemplate template = new JdbcTemplate(dataSource);
        for (String schema : SCENARIO_SCHEMAS) {
            template.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
        template.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired OperationRuleRepository rules;
    @Autowired JdbcTemplate jdbc;
    @Autowired DataSource dataSource;
    @Autowired PlatformTransactionManager transactionManager;

    @BeforeEach
    void reset() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
    }

    // ---------- 초기 규칙·환경 ----------

    @Test
    void 초기_규칙_rule_0이_현재_규칙이고_개발_환경은_건너뛰기가_3이다() {
        OperationRule current = rules.findCurrent().orElseThrow();

        assertEquals("rule-0", current.ruleVersion());
        assertEquals(new OperationRule.Selection(0.25, 3, false), current.selection());
        assertEquals(new OperationRule.Matching(List.of(1.0, 2.0, 0.5), null, 0.5, 2, 1, 0.5, 0.1, 0.1),
                current.matching());
        assertEquals(new OperationRule.Peaks(10), current.peaks());
        assertEquals(new OperationRule.Discovery(1, "hash-user-achievement-seq-v1"), current.discovery());
        assertEquals(new OperationRule.Tutorial(3), current.tutorial());
        assertTrue(current.tutorial().skipEnabled());
        assertEquals(new OperationRule.Ai(null, null), current.ai());
        assertEquals(current, rules.find("rule-0").orElseThrow());
    }

    /**
     * 배포 이미지는 설정이 없어 0(끔)으로, 로컬은 {@code spring.flyway.init-sqls}로 3을 넣는다. 설정은 V9가 처음
     * 적용될 때만 쓰이고 파일 내용은 환경마다 같으므로, 설정이 달라도 이미 적용된 DB의 체크섬 검증은 깨지지 않는다.
     */
    @Test
    void 배포_설정은_건너뛰기를_끄고_로컬_설정은_3을_넣으며_체크섬은_같다() throws IOException {
        String production = PropertiesLoaderUtils.loadProperties(new ClassPathResource("application.properties"))
                .getProperty(INIT_SQLS);
        String local = PropertiesLoaderUtils.loadProperties(new ClassPathResource("application-local.properties"))
                .getProperty(INIT_SQLS);
        assertTrue(production == null || !production.contains("planetory.tutorial_skip_after"), production);
        assertEquals("SET planetory.tutorial_skip_after = 3", local);

        String deployed = scenarioSchema();
        flyway(deployed, NO_SETTING, null).migrate();
        assertEquals(0, skipAfterIn(deployed));
        assertTrue(flyway(deployed, local, null).validateWithResult().validationSuccessful);

        String developed = scenarioSchema();
        flyway(developed, local, null).migrate();
        assertEquals(3, skipAfterIn(developed));
    }

    /**
     * 마이그레이션 SQL에는 Flyway 전용 문법을 쓰지 않는다. Gold 적재 왕복 도구(experiments/gold-roundtrip)는 파일을
     * Flyway 없이 그대로 한 트랜잭션에서 실행하므로 placeholder 같은 문법이 들어가면 그 도구가 멈춘다.
     */
    @Test
    void 마이그레이션_SQL은_Flyway_없이_그대로_실행해도_적용되고_설정이_없으면_건너뛰기는_0이다() throws IOException {
        Resource[] files = new PathMatchingResourcePatternResolver().getResources("classpath:db/migration/V*__*.sql");
        Arrays.sort(files, Comparator.comparingInt(OperationRulesTest::versionOf));
        List<String> migrations = new ArrayList<>();
        for (Resource file : files) {
            migrations.add(file.getContentAsString(StandardCharsets.UTF_8));
        }
        assertTrue(migrations.size() >= 9, "V1~V9가 모두 읽혀야 한다");
        String schema = "operation_rules_raw_" + UUID.randomUUID().toString().replace("-", "");

        inRolledBackTransaction(() -> {
            jdbc.execute((ConnectionCallback<Void>) connection -> {
                try (Statement statement = connection.createStatement()) {
                    statement.execute(NO_SETTING);
                    statement.execute("CREATE SCHEMA " + schema);
                    statement.execute("SET LOCAL search_path TO " + schema + ", public");
                    for (String migration : migrations) {
                        statement.execute(migration);
                    }
                }
                return null;
            });
            assertEquals(0, skipAfterIn(schema));
        });
    }

    /** 어긋난 기존 행이 있으면 V9는 무엇이 틀렸는지 알리고 통째로 되돌아간다. 고친 뒤 다시 적용하면 된다. */
    @Test
    void V9는_어긋난_기존_설정이_있으면_되돌아가고_고친_뒤_다시_적용된다() {
        String schema = scenarioSchema();
        flyway(schema, NO_SETTING, "8").migrate();
        jdbc.update("INSERT INTO " + schema + ".operation_settings(rule_version, \"values\", applied_at, note)"
                + " VALUES ('r-old', '{}'::jsonb, now(), '형식 이전 행')");
        jdbc.update("INSERT INTO " + schema + ".stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'hidden')",
                HIDDEN);
        jdbc.update("INSERT INTO " + schema + ".tutorial_stars(seq, tic_id, intent, active) VALUES (1, ?, 'fp', true)",
                HIDDEN);
        jdbc.update("INSERT INTO " + schema + ".challenge_rounds(round_no, starts_on, ends_on, target_tic_id,"
                + " description, status) VALUES (1, DATE '2026-09-21', DATE '2026-09-14', ?, '뒤집힌 기간', 'planned')",
                HIDDEN);

        assertMigrationRejected(schema, "r-old (operation_settings.values.format_version: 키가 없다)");
        assertEquals("8", flyway(schema, NO_SETTING, null).info().current().getVersion().getVersion());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM pg_proc p JOIN pg_namespace n"
                + " ON n.oid = p.pronamespace WHERE n.nspname = ? AND p.proname = 'operation_rules_valid'",
                Integer.class, schema), "실패한 V9의 함수가 남지 않는다");

        // 개발 DB 안내: 형식 이전 행은 비우고 다시 적용한다. 대상 별·기간 검사가 이어서 멈춘다.
        jdbc.update("DELETE FROM " + schema + ".operation_settings WHERE rule_version = 'r-old'");
        assertMigrationRejected(schema, "공개되지 않은 튜토리얼 별 1건, 공개되지 않은 챌린지 대상 1건, 기간이 뒤집힌 회차 1건");

        jdbc.update("UPDATE " + schema + ".stars SET service_status = 'published' WHERE tic_id = ?", HIDDEN);
        jdbc.update("UPDATE " + schema + ".challenge_rounds SET ends_on = DATE '2026-09-28' WHERE round_no = 1");
        // V9까지만 센다. 뒤 번호 마이그레이션이 추가돼도 이 시나리오의 기대값은 같다.
        assertEquals(1, flyway(schema, NO_SETTING, "9").migrate().migrationsExecuted);
        assertEquals(0, skipAfterIn(schema));
    }

    // ---------- 값 검증 (AT-41) ----------

    /** 잘못된 값은 어느 키가 왜 틀렸는지와 함께 저장 전에 거절된다. 합친 값은 JSON merge patch로 적는다. */
    @Test
    void 잘못된_규칙_값은_키_경로와_함께_저장_전에_거절된다() {
        record Case(String path, String patch) {
        }
        List<Case> cases = List.of(
                // AT-41 음수 오차
                new Case("values.matching.min_score_gap", "{'matching': {'min_score_gap': -0.1}}"),
                new Case("values.matching.overlap_ratio_tolerance", "{'matching': {'overlap_ratio_tolerance': -0.1}}"),
                new Case("values.matching.duration_ratio_min", "{'matching': {'duration_ratio_min': 0}}"),
                // AT-41 하한 ≥ 상한
                new Case("values.matching.duration_ratio_min", "{'matching': {'duration_ratio_min': 2}}"),
                new Case("values.ai", "{'ai': {'lower_threshold': 0.8, 'upper_threshold': 0.2}}"),
                new Case("values.ai", "{'ai': {'lower_threshold': 0.2}}"),
                // AT-41 미지원 배율
                new Case("values.matching.harmonic_multipliers", "{'matching': {'harmonic_multipliers': [1, 3]}}"),
                new Case("values.matching.harmonic_multipliers", "{'matching': {'harmonic_multipliers': [2, 0.5]}}"),
                new Case("values.matching.harmonic_multipliers", "{'matching': {'harmonic_multipliers': [1, 1.0]}}"),
                new Case("values.matching.harmonic_multipliers", "{'matching': {'harmonic_multipliers': []}}"),
                new Case("values.matching.harmonic_multipliers", "{'matching': {'harmonic_multipliers': 1}}"),
                // AT-41 음수 열림 수
                new Case("values.discovery.stars_per_achievement", "{'discovery': {'stars_per_achievement': -1}}"),
                new Case("values.discovery.stars_per_achievement", "{'discovery': {'stars_per_achievement': 1.0}}"),
                new Case("values.tutorial.skip_after", "{'tutorial': {'skip_after': -1}}"),
                // 그 밖의 범위·자료형
                new Case("values.peaks.top_n", "{'peaks': {'top_n': 0}}"),
                new Case("values.peaks.top_n", "{'peaks': {'top_n': '10'}}"),
                new Case("values.peaks.top_n", "{'peaks': {'top_n': 3000000000}}"),
                new Case("values.matching.n_transits_cap", "{'matching': {'n_transits_cap': 0}}"),
                new Case("values.matching.min_overlap_transits", "{'matching': {'min_overlap_transits': 0}}"),
                new Case("values.matching.dominance_ratio", "{'matching': {'dominance_ratio': 1.5}}"),
                new Case("values.selection.phase_width_max", "{'selection': {'phase_width_max': 1}}"),
                new Case("values.selection.max_duration_multiple_of_suggested",
                        "{'selection': {'max_duration_multiple_of_suggested': 0}}"),
                new Case("values.selection.allow_empty_phase_span", "{'selection': {'allow_empty_phase_span': 'false'}}"),
                new Case("values.discovery.seed_policy", "{'discovery': {'seed_policy': 'random'}}"),
                // 형식: 오타 난 키·빠진 키·모르는 형식
                new Case("values.matching.tolerance", "{'matching': {'tolerance': 0.1}}"),
                new Case("values.discovery.seed_policy", "{'discovery': {'seed_policy': null}}"),
                new Case("values.format_version", "{'format_version': 2}"),
                new Case("values.bls", "{'bls': {}}"),
                new Case("values", "[]"));

        ObjectNode template = template();
        assertAll(cases.stream().map(c -> (Executable) () -> assertRejected(DataIntegrityViolationException.class,
                "operation_settings." + c.path() + ":",
                () -> insertRolledBack("rule-bad", patched(template, c.patch()), "now()"))));

        // 거절된 것은 바꾼 부분이다. 원래 값은 새 버전으로 넣을 수 있다.
        insertRolledBack("rule-good", template, "now()");
    }

    // ---------- 버전 이력 ----------

    /** 값을 바꾸면 새 버전이 현재가 되고, 이전 버전은 제출이 참조한 판정 근거로 그대로 읽힌다. */
    @Test
    void 값을_바꾼_새_버전이_현재가_되고_예약_버전은_적용_시각_전까지_현재가_아니다() {
        inRolledBackTransaction(() -> {
            insertRule("rule-1", patched(template(), "{'peaks': {'top_n': 5}}"), "now()");
            insertRule("rule-2", patched(template(), "{'peaks': {'top_n': 7}}"), "now() + interval '1 day'");

            OperationRule current = rules.findCurrent().orElseThrow();
            assertEquals("rule-1", current.ruleVersion());
            assertEquals(5, current.peaks().topN());
            assertEquals(10, rules.find("rule-0").orElseThrow().peaks().topN());
            assertEquals(7, rules.find("rule-2").orElseThrow().peaks().topN());
        });
    }

    @Test
    void 지난_적용_시각이나_다른_버전과_같은_적용_시각으로는_넣을_수_없다() {
        assertRejected(DataIntegrityViolationException.class, "rule-1의 적용 시각",
                () -> insertRolledBack("rule-1", template(), "now() - interval '1 minute'"));
        assertRejected(DuplicateKeyException.class, "uq_operation_settings_applied_at",
                () -> inRolledBackTransaction(() -> {
                    insertRule("rule-1", template(), "now() + interval '1 hour'");
                    insertRule("rule-2", template(), "now() + interval '1 hour'");
                }));
    }

    @Test
    void 적용된_버전은_고치거나_지우거나_비울_수_없고_예약_버전은_지울_수_있다() {
        assertRejected(DataIntegrityViolationException.class, "고치거나 지울 수 없습니다(rule-0)",
                () -> inRolledBackTransaction(() ->
                        jdbc.update("UPDATE operation_settings SET note = '고침' WHERE rule_version = 'rule-0'")));
        assertRejected(DataIntegrityViolationException.class, "고치거나 지울 수 없습니다(rule-0)",
                () -> inRolledBackTransaction(() ->
                        jdbc.update("DELETE FROM operation_settings WHERE rule_version = 'rule-0'")));
        assertRejected(DataIntegrityViolationException.class, "운영 규칙 이력은 비울 수 없습니다",
                () -> inRolledBackTransaction(() -> jdbc.execute("TRUNCATE operation_settings CASCADE")));
        // 예약 버전도 고칠 수는 없다. 지우고 다시 넣는다.
        assertRejected(DataIntegrityViolationException.class, "고치거나 지울 수 없습니다(rule-1)",
                () -> inRolledBackTransaction(() -> {
                    insertRule("rule-1", template(), "now() + interval '1 day'");
                    jdbc.update("UPDATE operation_settings SET applied_at = now() WHERE rule_version = 'rule-1'");
                }));

        inRolledBackTransaction(() -> {
            insertRule("rule-1", template(), "now() + interval '1 day'");
            assertEquals(1, jdbc.update("DELETE FROM operation_settings WHERE rule_version = 'rule-1'"));
        });
        assertEquals(new OperationRule.Peaks(10), rules.find("rule-0").orElseThrow().peaks());
    }

    // ---------- 튜토리얼·챌린지 대상 (OPS-07·08) ----------

    /** 공개 대상이 아닌 별은 발견에서 빠지므로(OPS-08) 튜토리얼·챌린지 대상으로도 넣을 수 없다. */
    @Test
    void 튜토리얼과_챌린지_대상은_공개된_별이어야_한다() {
        insertStar(PUBLISHED, "published");
        insertStar(HIDDEN, "hidden");

        assertRejected(DataIntegrityViolationException.class, "tutorial_stars.tic_id에 넣을 수 있습니다. TIC " + HIDDEN,
                () -> insertTutorial(1, HIDDEN));
        assertRejected(DataIntegrityViolationException.class, "TIC " + MISSING + "는 없거나",
                () -> insertTutorial(1, MISSING));
        assertRejected(DataIntegrityViolationException.class, "challenge_rounds.target_tic_id",
                () -> insertRound(1, HIDDEN, "2026-09-14", "2026-09-21"));

        insertTutorial(1, PUBLISHED);
        long round = insertRound(1, PUBLISHED, "2026-09-14", "2026-09-21");
        assertRejected(DataIntegrityViolationException.class, "tutorial_stars.tic_id",
                () -> jdbc.update("UPDATE tutorial_stars SET tic_id = ? WHERE seq = 1", HIDDEN));
        assertRejected(DataIntegrityViolationException.class, "challenge_rounds.target_tic_id",
                () -> jdbc.update("UPDATE challenge_rounds SET target_tic_id = ? WHERE id = ?", HIDDEN, round));
        assertRejected(DataIntegrityViolationException.class, "challenge_round_extra_targets.tic_id",
                () -> jdbc.update("INSERT INTO challenge_round_extra_targets(round_id, tic_id) VALUES (?, ?)",
                        round, HIDDEN));

        // 대상 별이 나중에 숨겨져도 회차를 닫거나 튜토리얼을 끄는 운영은 막지 않는다.
        jdbc.update("UPDATE stars SET service_status = 'hidden' WHERE tic_id = ?", PUBLISHED);
        assertEquals(1, jdbc.update("UPDATE challenge_rounds SET status = 'closed' WHERE id = ?", round));
        assertEquals(1, jdbc.update("UPDATE tutorial_stars SET active = false WHERE seq = 1"));
    }

    @Test
    void 챌린지_회차는_기간이_뒤집힐_수_없고_진행_회차는_하나다() {
        insertStar(PUBLISHED, "published");

        assertRejected(DataIntegrityViolationException.class, "ck_challenge_rounds_period",
                () -> insertRound(1, PUBLISHED, "2026-09-21", "2026-09-14"));
        insertRound(1, PUBLISHED, "2026-09-14", "2026-09-14");
        insertRound(2, PUBLISHED, "2026-09-21", "2026-09-28");
        assertRejected(DataIntegrityViolationException.class, "ck_challenge_rounds_period",
                () -> jdbc.update("UPDATE challenge_rounds SET ends_on = DATE '2026-09-20' WHERE round_no = 2"));

        jdbc.update("UPDATE challenge_rounds SET status = 'active' WHERE round_no = 1");
        assertRejected(DuplicateKeyException.class, "uq_challenge_rounds_active",
                () -> jdbc.update("UPDATE challenge_rounds SET status = 'active' WHERE round_no = 2"));
    }

    // ---------- 도우미 ----------

    private ObjectNode template() {
        return (ObjectNode) JSON.readTree(jdbc.queryForObject(
                "SELECT \"values\"::text FROM operation_settings WHERE rule_version = 'rule-0'", String.class));
    }

    /** JSON merge patch(RFC 7386). null은 키를 지우고, 객체는 안으로 들어가 합친다. 배열 patch는 값 전체를 바꾼다. */
    private static JsonNode patched(ObjectNode template, String patch) {
        JsonNode change = JSON.readTree(patch.replace('\'', '"'));
        if (!change.isObject()) {
            return change;
        }
        ObjectNode result = template.deepCopy();
        merge(result, (ObjectNode) change);
        return result;
    }

    private static void merge(ObjectNode target, ObjectNode change) {
        for (Map.Entry<String, JsonNode> entry : change.properties()) {
            JsonNode value = entry.getValue();
            if (value.isNull()) {
                target.remove(entry.getKey());
            } else if (value.isObject() && target.get(entry.getKey()) instanceof ObjectNode inner) {
                merge(inner, (ObjectNode) value);
            } else {
                target.set(entry.getKey(), value);
            }
        }
    }

    private void insertRule(String ruleVersion, JsonNode values, String appliedAtSql) {
        jdbc.update("INSERT INTO operation_settings(rule_version, \"values\", applied_at, note)"
                + " VALUES (?, ?::jsonb, " + appliedAtSql + ", '테스트')", ruleVersion, JSON.writeValueAsString(values));
    }

    private void insertRolledBack(String ruleVersion, JsonNode values, String appliedAtSql) {
        inRolledBackTransaction(() -> insertRule(ruleVersion, values, appliedAtSql));
    }

    private void inRolledBackTransaction(Runnable body) {
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            status.setRollbackOnly();
            body.run();
        });
    }

    private void insertStar(long ticId, String serviceStatus) {
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, ?)", ticId, serviceStatus);
    }

    private void insertTutorial(int seq, long ticId) {
        jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (?, ?, 'fp', true)", seq, ticId);
    }

    private long insertRound(int roundNo, long targetTicId, String startsOn, String endsOn) {
        return jdbc.queryForObject("INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id,"
                + " description, status) VALUES (?, ?::date, ?::date, ?, '테스트 회차', 'planned') RETURNING id",
                Long.class, roundNo, startsOn, endsOn, targetTicId);
    }

    private String scenarioSchema() {
        String schema = "operation_rules_scenario_" + UUID.randomUUID().toString().replace("-", "");
        SCENARIO_SCHEMAS.add(schema);
        return schema;
    }

    /** {@code initSql}은 마이그레이션 연결을 여는 즉시 실행된다. 앱에서는 {@code spring.flyway.init-sqls}가 준다. */
    private Flyway flyway(String schema, String initSql, String target) {
        FluentConfiguration configuration = Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .defaultSchema(schema)
                .locations("classpath:db/migration")
                .initSql(initSql)
                .cleanDisabled(true);
        if (target != null) {
            configuration.target(MigrationVersion.fromVersion(target));
        }
        return configuration.load();
    }

    private static int versionOf(Resource migration) {
        String name = migration.getFilename();
        return Integer.parseInt(name.substring(1, name.indexOf("__")));
    }

    private int skipAfterIn(String schema) {
        return jdbc.queryForObject("SELECT (\"values\" -> 'tutorial' ->> 'skip_after')::int FROM " + schema
                + ".operation_settings WHERE rule_version = 'rule-0'", Integer.class);
    }

    private void assertMigrationRejected(String schema, String expected) {
        assertRejected(FlywayException.class, expected, () -> flyway(schema, NO_SETTING, null).migrate());
    }

    private static void assertRejected(Class<? extends Throwable> type, String expected, Executable action) {
        Throwable thrown = assertThrows(type, action);
        String messages = allMessages(thrown);
        assertTrue(messages.contains(expected), () -> "메시지에 '" + expected + "'가 없다:\n" + messages);
    }

    private static String allMessages(Throwable throwable) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = throwable; c != null; c = c.getCause()) {
            sb.append(c.getMessage()).append('\n');
            if (c instanceof SQLException sqlException) {
                for (Throwable next : sqlException) {
                    sb.append(next.getMessage()).append('\n');
                }
            }
        }
        return sb.toString();
    }
}
