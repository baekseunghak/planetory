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

    /** 완료 조건 (4): 대용량 float32 배열이 유한값·null을 그대로 유지한다. */
    @Test
    void 곡선과_주기도_배열이_유한값과_null을_유지한다() {
        long ticId = insertStar();
        long bundleId = insertBundle(ticId, "current");

        Float[] flux = new Float[20_000];
        for (int i = 0; i < flux.length; i++) {
            flux[i] = (i % 997 == 0) ? null : 1.0f - (i % 31) * 1.0e-4f;
        }
        Float[] power = new Float[5_000];
        for (int i = 0; i < power.length; i++) {
            power[i] = (i % 613 == 0) ? null : (float) Math.log1p(i);
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

    /** ERD 3장이 요구하는 여덟 항목을 모두 갖춘 최소 manifest. */
    static final String VALID_MANIFEST = """
            {
              "segment_ids": [1],
              "array_checksums": {"flux": "sha256:0000", "power": "sha256:1111"},
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
}
