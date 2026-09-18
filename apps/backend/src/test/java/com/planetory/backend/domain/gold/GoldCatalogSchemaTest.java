package com.planetory.backend.domain.gold;

import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
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
 * Gold 카탈로그(B 묶음) 스키마 인수 조건 [S15P21C206-134].
 *
 * <p>실행마다 별도 스키마를 만들고 끝나면 지운다. 개발용 public 스키마는 건드리지 않는다.
 * 역할·권한 검증은 클러스터 전역 상태라 {@link GoldRolePermissionTest}에서 따로 한다.
 */
@ActiveProfiles("local")
@SpringBootTest
class GoldCatalogSchemaTest {

    private static final String SCHEMA = newSchemaName();
    private static final List<String> SCENARIO_SCHEMAS = new java.util.ArrayList<>();

    private static String newSchemaName() {
        return "gold_test_" + UUID.randomUUID().toString().replace("-", "");
    }

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @AfterAll
    static void dropOnlyThisTestSchemas(@Autowired DataSource dataSource) {
        JdbcTemplate template = new JdbcTemplate(dataSource);
        template.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
        for (String schema : SCENARIO_SCHEMAS) {
            template.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    private Flyway flywayFor(String schema) {
        SCENARIO_SCHEMAS.add(schema);
        return Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .defaultSchema(schema)
                .locations("classpath:db/migration")
                .cleanDisabled(true)
                .load();
    }

    /** 완료 조건 (1) 앞쪽: 빈 DB에 V1부터 전부 적용되고, 다시 실행해도 중복 적용되지 않는다. */
    @Test
    void 빈_스키마에_전체_마이그레이션이_적용되고_재실행시_추가_적용이_없다() {
        Flyway flyway = flywayFor(newSchemaName());

        int executed = flyway.migrate().migrationsExecuted;

        assertTrue(executed >= 2, "V1과 V2가 적용되어야 한다");
        assertEquals(0, flyway.info().pending().length);
        assertEquals(0, flyway.migrate().migrationsExecuted, "재실행은 아무것도 적용하지 않는다");
    }

    /** 완료 조건 (1) 뒤쪽: V1만 적용된 기준 DB에 후속 마이그레이션만 얹어도 성공한다. */
    @Test
    void V1만_적용된_스키마에_후속_마이그레이션이_적용된다() {
        String schema = newSchemaName();

        Flyway onlyV1 = Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .defaultSchema(schema)
                .locations("classpath:db/migration")
                .target(org.flywaydb.core.api.MigrationVersion.fromVersion("1"))
                .cleanDisabled(true)
                .load();
        SCENARIO_SCHEMAS.add(schema);

        assertEquals(1, onlyV1.migrate().migrationsExecuted, "V1만 적용된 기준 상태를 만든다");

        Flyway rest = flywayFor(schema);
        assertTrue(rest.info().pending().length >= 1, "V2 이후가 대기 중이어야 한다");
        assertTrue(rest.migrate().migrationsExecuted >= 1, "후속 마이그레이션이 적용된다");
        assertEquals(0, rest.info().pending().length);
    }

    /** 완료 조건 (2): 같은 별에 current 판이 둘일 수 없다. */
    @Test
    void 같은_TIC에_current_판_두_개는_거절된다() {
        long ticId = insertStar();
        insertBundle(ticId, "current");

        assertThrows(DataIntegrityViolationException.class, () -> insertBundle(ticId, "current"));

        // 같은 별의 staging·archived는 제약 대상이 아니다.
        assertDoesNotThrow(() -> insertBundle(ticId, "staging"));
        assertDoesNotThrow(() -> insertBundle(ticId, "archived"));
    }

    /**
     * Publisher 멱등 키 [S15P21C206-230]. 같은 키가 두 행이면 "같은 키의 판을
     * 확인한다"는 조회가 여러 건을 돌려줘 어느 bundleId를 반환할지가 정해지지 않는다.
     */
    @Test
    void 같은_TIC에_같은_판_버전은_두_번_들어가지_않는다() {
        long ticId = insertStar();
        insertBundleAtVersion(ticId, "v2", "current");

        assertThrows(DataIntegrityViolationException.class,
                () -> insertBundleAtVersion(ticId, "v2", "staging"),
                "status가 달라도 같은 키면 거절된다");
        assertThrows(DataIntegrityViolationException.class,
                () -> insertBundleAtVersion(ticId, "v2", "archived"));

        // 판 버전이 다르면 한 TIC에 여러 행이 남는다. 과거 제출이 그 행들을 참조한다.
        assertDoesNotThrow(() -> insertBundleAtVersion(ticId, "v3", "archived"));
        assertDoesNotThrow(() -> insertBundleAtVersion(ticId, "v4", "archived"));
        assertEquals(3, jdbc.queryForObject(
                "SELECT count(*) FROM publication_bundles WHERE tic_id = ?", Integer.class, ticId));

        // 다른 별은 같은 버전 문자열을 써도 서로 무관하다.
        assertDoesNotThrow(() -> insertBundleAtVersion(insertStar(), "v2", "current"));
    }

    /** 완료 조건 (3): 세그먼트 revision 중복은 거절되고 다른 revision은 공존한다. */
    @Test
    void 세그먼트는_같은_revision이_중복되지_않고_다른_revision은_공존한다() {
        long ticId = insertStar();
        insertSegment(ticId, (short) 1, "bin-10m-v1", 3);

        assertThrows(DataIntegrityViolationException.class,
                () -> insertSegment(ticId, (short) 1, "bin-10m-v1", 3));

        assertDoesNotThrow(() -> insertSegment(ticId, (short) 1, "bin-10m-v2", 3));
        assertEquals(2, jdbc.queryForObject(
                "SELECT count(*) FROM light_curve_segments WHERE tic_id = ?", Integer.class, ticId));
    }

    /**
     * 완료 조건 (4): 대용량 float32 배열이 값을 그대로 유지한다. 곡선의 빈 bin은 null로 남는다.
     * 주기도는 격자 전 점에 값이 있어야 하므로 null을 넣지 않는다 [S15P21C206-140].
     */
    @Test
    void 대용량_곡선과_주기도_배열이_값을_그대로_유지한다() {
        long ticId = insertStar();
        long bundleId = insertBundle(ticId, "current");

        Float[] flux = new Float[20_000];
        for (int i = 0; i < flux.length; i++) {
            flux[i] = (i % 997 == 0) ? null : 1.0f - (i % 31) * 1.0e-4f;
        }
        Float[] power = new Float[5_000];
        for (int i = 0; i < power.length; i++) {
            power[i] = (float) Math.log1p(i);
        }

        jdbc.update("INSERT INTO light_curve_segments"
                        + "(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
                ticId, (short) 7, "bin-10m-v1", 1500.0, 10, flux.length, flux, "[]");
        jdbc.update("INSERT INTO periodograms"
                        + "(bundle_id, period_min_days, period_max_days, n_periods, power)"
                        + " VALUES (?, ?, ?, ?, ?)",
                bundleId, 0.5, 40.0, power.length, power);

        assertArrayEquals(flux, readFloatArray(
                "SELECT flux FROM light_curve_segments WHERE tic_id = ? AND sector = 7", ticId));
        assertArrayEquals(power, readFloatArray(
                "SELECT power FROM periodograms WHERE bundle_id = ?", bundleId));
    }

    /**
     * V10: 곡선은 유한수 또는 NULL(빈 bin), 주기도는 유한수만 담는다. NULL 자리의 NaN은 제안된 배열
     * checksum에서 NULL과 같은 바이트라 checksum으로 걸리지 않으므로 DB가 막는다 [S15P21C206-140].
     */
    @Test
    void 곡선의_NaN_무한대와_주기도의_NULL_NaN_무한대는_거절된다() {
        long ticId = insertStar();
        long bundleId = insertBundle(ticId, "staging");

        for (Float bad : new Float[] {Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY}) {
            assertThrows(DataIntegrityViolationException.class,
                    () -> insertFlux(ticId, new Float[] {1.0f, null, bad}),
                    "flux에 " + bad + "가 들어가면 안 된다");
        }
        assertDoesNotThrow(() -> insertFlux(ticId, new Float[] {1.0f, null, 0.98f}),
                "곡선의 빈 bin은 NULL로 둔다");

        for (Float bad : new Float[] {null, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY}) {
            assertThrows(DataIntegrityViolationException.class,
                    () -> insertPower(bundleId, new Float[] {0.1f, bad}),
                    "power에 " + bad + "가 들어가면 안 된다");
        }
        assertDoesNotThrow(() -> insertPower(bundleId, new Float[] {0.1f, 0.9f}));
    }

    /** manifest 최소 스키마: 여덟 항목 중 하나라도 빠지면 판을 만들 수 없다. */
    @Test
    void manifest에_필수_항목이_빠지면_판이_거절된다() {
        long ticId = insertStar();

        assertThrows(DataIntegrityViolationException.class,
                () -> insertBundle(ticId, "staging", "{}"),
                "빈 manifest는 거절되어야 한다");

        for (String key : List.of("segment_ids", "array_checksums", "residual_model_version",
                "periodogram_config_version", "binning", "period_grid", "fine_tune", "curve_steps")) {
            String withoutKey = VALID_MANIFEST.replaceFirst("\"" + key + "\"", "\"_" + key + "\"");
            assertThrows(DataIntegrityViolationException.class,
                    () -> insertBundle(ticId, "staging", withoutKey),
                    key + "가 빠진 manifest는 거절되어야 한다");
        }
    }

    /** 자료형이 계약과 다르면 거절한다. 값의 범위는 rule_version이 관리하므로 보지 않는다. */
    @Test
    void manifest_항목의_자료형이_다르면_거절된다() {
        long ticId = insertStar();

        assertThrows(DataIntegrityViolationException.class,
                () -> insertBundle(ticId, "staging",
                        VALID_MANIFEST.replace("\"segment_ids\": [1]", "\"segment_ids\": 1")),
                "segment_ids는 배열이어야 한다");

        assertThrows(DataIntegrityViolationException.class,
                () -> insertBundle(ticId, "staging",
                        VALID_MANIFEST.replace("\"segment_ids\": [1]", "\"segment_ids\": []")),
                "참조 세그먼트가 없는 판은 조립할 수 없다");

        assertThrows(DataIntegrityViolationException.class,
                () -> insertBundle(ticId, "staging",
                        VALID_MANIFEST.replace("\"residual_model_version\": \"rm-1\"",
                                "\"residual_model_version\": 1")),
                "계산 버전은 문자열이어야 한다");
    }

    private Float[] readFloatArray(String sql, Object arg) {
        return jdbc.queryForObject(sql, (rs, rowNum) -> (Float[]) rs.getArray(1).getArray(), arg);
    }

    private long insertStar() {
        long ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published')", ticId);
        return ticId;
    }

    /**
     * ERD 3장이 요구하는 여덟 항목을 모두 갖춘 최소 manifest. checksum 키는 Gold 게시 계약의
     * {@code segment:<id>:flux}·{@code periodogram:<bundleId>:power} 표기를 따른다.
     */
    static final String VALID_MANIFEST = """
            {
              "segment_ids": [1],
              "array_checksums": {"segment:1:flux": "sha256:0000", "periodogram:1:power": "sha256:1111"},
              "residual_model_version": "rm-1",
              "periodogram_config_version": "pg-1",
              "binning": {"minutes": 10},
              "period_grid": {"min_days": 0.5, "max_days": 40.0, "spacing": "log"},
              "fine_tune": {"half_width_cells": 3},
              "curve_steps": {"max": 8}
            }
            """;

    private long insertBundle(long ticId, String status) {
        return insertBundle(ticId, status, VALID_MANIFEST);
    }

    /** 판 버전을 직접 정해 멱등 키 중복을 만든다. 기본 헬퍼는 매번 다른 버전을 쓴다. */
    private long insertBundleAtVersion(long ticId, String bundleVersion, String status) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, ?, ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, bundleVersion, status, VALID_MANIFEST);
    }

    private long insertBundle(long ticId, String status, String manifest) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, ?, ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, "v-" + UUID.randomUUID(), status, manifest);
    }

    private void insertSegment(long ticId, short sector, String revision, int points) {
        Float[] flux = new Float[points];
        java.util.Arrays.fill(flux, 1.0f);
        jdbc.update("INSERT INTO light_curve_segments"
                        + "(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps)"
                        + " VALUES (?, ?, ?, 1500.0, 10, ?, ?, '[]'::jsonb)",
                ticId, sector, revision, points, flux);
    }

    /** 표본은 모두 1번 자리가 빈 bin이므로 gaps도 그 위치를 가리킨다. */
    private void insertFlux(long ticId, Float[] flux) {
        jdbc.update("INSERT INTO light_curve_segments"
                        + "(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps)"
                        + " VALUES (?, 9, 'bin-10m-v1', 1500.0, 10, ?, ?, '[[1, 1]]'::jsonb)",
                ticId, flux.length, flux);
    }

    private void insertPower(long bundleId, Float[] power) {
        jdbc.update("INSERT INTO periodograms"
                        + "(bundle_id, period_min_days, period_max_days, n_periods, power)"
                        + " VALUES (?, 0.5, 40.0, ?, ?)",
                bundleId, power.length, power);
    }
}
