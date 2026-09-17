package com.planetory.backend.domain.gold;

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

import com.planetory.backend.domain.gold.GoldCatalogViews.Bundle;
import com.planetory.backend.domain.gold.GoldCatalogViews.Candidate;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.domain.gold.GoldCatalogViews.Periodogram;

import static org.junit.jupiter.api.Assertions.*;

/** Gold 카탈로그 읽기 전용 조회 모델 [S15P21C206-134]. */
@ActiveProfiles("local")
@SpringBootTest
class GoldCatalogRepositoryTest {

    private static final String SCHEMA =
            "gold_repo_test_" + UUID.randomUUID().toString().replace("-", "");

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

    @Autowired GoldCatalogRepository repository;
    @Autowired JdbcTemplate jdbc;

    private long ticId;
    private long currentBundleId;
    private long previousBundleId;
    private long segmentId;

    @BeforeEach
    void seedOneStar() {
        ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 1, 'published')", ticId);

        segmentId = jdbc.queryForObject("INSERT INTO light_curve_segments"
                        + "(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps)"
                        + " VALUES (?, 7, 'bin-10m-v1', 1500.0, 10, 4, ?, '[2]'::jsonb) RETURNING id",
                Long.class, ticId, new Float[] {1.0f, null, 0.98f, 1.0f});

        previousBundleId = insertBundle("archived");
        currentBundleId = insertBundle("current");

        jdbc.update("INSERT INTO periodograms"
                        + "(bundle_id, period_min_days, period_max_days, n_periods, power)"
                        + " VALUES (?, 0.5, 40.0, 3, ?)",
                currentBundleId, new Float[] {0.1f, null, 0.9f});

        jdbc.update("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, 3.0021, 1501.2, 2.8, 900, 12.5,"
                + " '{\"shape\":\"trapezoid\"}'::jsonb, true, true)", ticId, currentBundleId);
        jdbc.update("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'retired', ?, 2, 6.0, 1502.0, 3.0, 400, 8.0,"
                + " '{}'::jsonb, false, false)", ticId, previousBundleId);
    }

    private long insertBundle(String status) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, ?, ?::jsonb, 1510.25, 27.4) RETURNING id",
                Long.class, ticId, "v-" + UUID.randomUUID(), status,
                GoldCatalogSchemaTest.VALID_MANIFEST.replace("[1]", "[" + segmentId + "]"));
    }

    @Test
    void 현재_판과_manifest를_읽는다() {
        Bundle bundle = repository.findCurrentBundle(ticId).orElseThrow();

        assertEquals(currentBundleId, bundle.id());
        assertEquals(Bundle.Status.CURRENT, bundle.status());
        assertEquals(1510.25, bundle.foldReferenceTimeBtjd());
        assertEquals(List.of(segmentId), bundle.manifest().segmentIds());
        assertEquals("rm-1", bundle.manifest().residualModelVersion());
        assertEquals("pg-1", bundle.manifest().periodogramConfigVersion());
        assertEquals(10, bundle.manifest().binning().get("minutes").asInt());
        assertEquals(3, bundle.manifest().fineTune().get("half_width_cells").asInt());
    }

    /** 진행 중 분석은 current를 쓰지만, 과거 제출이 참조하는 archived 판은 id로 읽혀야 한다. */
    @Test
    void 교체된_판도_id로_읽힌다() {
        Bundle archived = repository.findBundle(previousBundleId).orElseThrow();

        assertEquals(Bundle.Status.ARCHIVED, archived.status());
        assertNotEquals(currentBundleId, archived.id());
    }

    @Test
    void 곡선_세그먼트의_결측이_null로_보존된다() {
        Bundle bundle = repository.findCurrentBundle(ticId).orElseThrow();

        List<LightCurveSegment> segments = repository.findSegments(bundle.manifest().segmentIds());

        assertEquals(1, segments.size());
        LightCurveSegment segment = segments.get(0);
        assertEquals("bin-10m-v1", segment.binningRevision());
        assertEquals(4, segment.nPoints());
        assertArrayEquals(new Float[] {1.0f, null, 0.98f, 1.0f}, segment.flux());
        assertEquals(2, segment.gaps().get(0).asInt());
    }

    @Test
    void 참조할_세그먼트가_없으면_빈_목록을_준다() {
        assertTrue(repository.findSegments(List.of()).isEmpty());
    }

    @Test
    void 주기도의_결측이_null로_보존된다() {
        Periodogram periodogram = repository.findPeriodogram(currentBundleId).orElseThrow();

        assertEquals(3, periodogram.nPeriods());
        assertArrayEquals(new Float[] {0.1f, null, 0.9f}, periodogram.power());
        assertTrue(repository.findPeriodogram(previousBundleId).isEmpty(), "교체된 판의 주기도는 지운다");
    }

    /** 은퇴 후보도 과거 제출 재현에 필요하므로 조회에서 걸러내지 않는다. */
    @Test
    void 후보를_제거_순번대로_주며_은퇴_후보도_포함한다() {
        List<Candidate> candidates = repository.findCandidates(ticId);

        assertEquals(2, candidates.size());
        assertEquals(Candidate.Status.ACTIVE, candidates.get(0).status());
        assertTrue(candidates.get(0).discoverable());
        assertEquals("trapezoid", candidates.get(0).transitModel().get("shape").asText());
        assertEquals(Candidate.Status.RETIRED, candidates.get(1).status());
    }

    @Test
    void 없는_별은_빈_결과를_준다() {
        assertTrue(repository.findCurrentBundle(1L).isEmpty());
        assertTrue(repository.findCandidates(1L).isEmpty());
    }
}
