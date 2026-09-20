package com.planetory.backend.domain.exploration.service;

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

import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobRequest;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.TargetRequest;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 계산 기반이 아직 연결되지 않았을 때 (탐사 API 7.1절) [S15P21C206-147].
 *
 * <p>Worker 어댑터({@code S15P21C206-88})가 없는 지금의 실제 동작이다. <b>작업을 만들지 않는다.</b>
 * 만들어 두면 아무도 진행시키지 않는 QUEUED가 쌓이고 화면은 계산이 도는 줄 안다.
 */
@ActiveProfiles("local")
@SpringBootTest
class ResidualJobUnavailableTest {

    private static final String SCHEMA = "residual_none_" + UUID.randomUUID().toString().replace("-", "");

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

    @Autowired ResidualJobService jobs;
    @Autowired ResidualJobStore store;
    @Autowired ResidualResultReader residuals;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;

    private long member;
    private long ticId;
    private long bundleId;
    private long candidateId;
    private AnalysisViews.CurveContext target;

    @BeforeEach
    void seed() {
        jdbc.execute("TRUNCATE users, stars CASCADE");
        String unique = UUID.randomUUID().toString();
        member = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
        ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", ticId);
        var position = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, 0)",
                member, ticId, position.depthZ(), position.worldX(), position.worldY(), position.layoutVersion());
        long segmentId = jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id, sector, binning_revision,"
                        + " start_btjd, bin_minutes, n_points, flux, gaps)"
                        + " VALUES (?, 14, '10m-v1', 1683.35, 10, 2, ?, '[]'::jsonb) RETURNING id",
                Long.class, ticId, new Float[] {1.0f, 0.999f});
        String manifest = """
                {"segment_ids": [%d], "array_checksums": {},
                 "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
                 "binning": {"minutes": 10}, "period_grid": {"spacing": "log"},
                 "fine_tune": {"half_width_cells": 3}, "curve_steps": {}}
                """.formatted(segmentId);
        bundleId = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest,"
                        + " fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1683.4231, 81.4) RETURNING id",
                Long.class, ticId, "pv1-" + UUID.randomUUID(), manifest);
        candidateId = jdbc.queryForObject("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step,"
                        + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,"
                        + " discoverable, is_confirmed)"
                        + " VALUES (?, 'active', ?, 1, 3.0, 1684.0, 2.0, 900, 10.0, '{}'::jsonb, true, false)"
                        + " RETURNING id", Long.class, ticId, bundleId);
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind, curve_step,"
                        + " removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.0, 0.1, 0.2, 1683.4231,"
                        + " 'LIKELY_PLANET', '[]'::jsonb, 'matched', ?, 'recognized', 'rm-1', 'pg-1', 'rule-0')",
                member, ticId, bundleId, UUID.randomUUID().toString(), candidateId);
        target = new AnalysisViews.CurveContext("b-" + bundleId, 1, List.of("c-" + candidateId), "rm-1", "pg-1");
    }

    @Test
    void 계산_기반이_없으면_503이고_작업도_만들지_않는다() {
        JobRequest request = new JobRequest(new TargetRequest("b-" + bundleId, List.of("c-" + candidateId),
                "rm-1", "pg-1"));

        BusinessException refused = assertThrows(BusinessException.class,
                () -> jobs.request(member, ticId, request));

        assertEquals(ErrorCode.DEPENDENCY_UNAVAILABLE, refused.getErrorCode());
        assertTrue(store.active(ResidualJobStore.cacheKey(ticId, target)).isEmpty(), "작업을 만들지 않는다");
        // 조회도 가짜 상태를 만들지 않는다(D-14).
        ResidualResultReader.Lookup lookup = residuals.lookup(ticId, target);
        assertNull(lookup.status());
        assertNull(lookup.jobId());
    }

    /** 요청이 거절돼도 목표 검증은 먼저 돈다. 잘못된 목표를 503으로 덮지 않는다. */
    @Test
    void 잘못된_목표는_계산_기반_여부보다_먼저_거절한다() {
        JobRequest original = new JobRequest(new TargetRequest("b-" + bundleId, List.of(), "rm-1", "pg-1"));

        BusinessException refused = assertThrows(BusinessException.class,
                () -> jobs.request(member, ticId, original));

        assertEquals(ErrorCode.VALIDATION_FAILED, refused.getErrorCode());
    }
}
