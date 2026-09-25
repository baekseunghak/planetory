package com.planetory.backend.domain.gold;

import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.*;

@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
class GoldReadCacheTest {
    private static final String SCHEMA = "gold_cache_test_" + UUID.randomUUID().toString().replace("-", "");
    private static final long TIC = 987654321L;
    @Container static final GenericContainer<?> SESSION =
            new GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);
    @Container static final GenericContainer<?> CACHE =
            new GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
        registry.add("planetory.session.redis.enabled", () -> "true");
        registry.add("planetory.redis.session.host", SESSION::getHost);
        registry.add("planetory.redis.session.port", () -> SESSION.getMappedPort(6379));
        registry.add("planetory.redis.cache.host", CACHE::getHost);
        registry.add("planetory.redis.cache.port", () -> CACHE.getMappedPort(6379));
        registry.add("planetory.gold.cache.enabled", () -> "true");
        registry.add("planetory.gold.cache.tic-ids", () -> Long.toString(TIC));
    }

    @AfterAll
    static void dropSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired GoldCatalogRepository gold;
    @Autowired StringRedisTemplate goldCacheRedisTemplate;

    @Test
    void selectedGoldIsPreloadedAndVersionedWithDatabaseFallback() {
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 1, 'published')", TIC);
        long segment = jdbc.queryForObject("INSERT INTO light_curve_segments"
                + "(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps)"
                + " VALUES (?, 7, 'bin-10m-v1', 1500, 10, 4, ?, '[[1,1]]'::jsonb) RETURNING id",
                Long.class, TIC, new Float[] {1f, null, .98f, 1f});
        long first = bundle(segment);
        periodogram(first, new Float[] {.1f, .5f, .9f});

        gold.preloadSelectedTic(TIC);
        jdbc.update("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, 3, 1501, 2, 900, 12, '{}'::jsonb, true, false)", TIC, first);
        String segmentsKey = GoldReadCache.segmentKey(List.of(segment));
        assertTrue(goldCacheRedisTemplate.hasKey(segmentsKey));
        assertTrue(goldCacheRedisTemplate.hasKey(GoldReadCache.periodogramKey(first)));
        assertArrayEquals(new Float[] {1f, null, .98f, 1f}, gold.findSegments(TIC, List.of(segment)).getFirst().flux());
        jdbc.update("UPDATE candidates SET status = 'retired' WHERE tic_id = ?", TIC);
        assertEquals(GoldCatalogViews.Candidate.Status.RETIRED, gold.findCandidates(TIC).getFirst().status(),
                "같은 판 안의 후보 정정은 DB에서 즉시 읽는다");

        jdbc.update("UPDATE light_curve_segments SET flux = ? WHERE id = ?",
                new Float[] {.8f, null, .8f, .8f}, segment);
        assertArrayEquals(new Float[] {1f, null, .98f, 1f}, gold.findSegments(TIC, List.of(segment)).getFirst().flux(),
                "선택한 별은 적재한 배열을 읽는다");
        goldCacheRedisTemplate.delete(segmentsKey);
        assertArrayEquals(new Float[] {.8f, null, .8f, .8f}, gold.findSegments(TIC, List.of(segment)).getFirst().flux(),
                "축출되면 DB에서 다시 읽어 채운다");

        jdbc.update("UPDATE publication_bundles SET status = 'archived' WHERE id = ?", first);
        jdbc.update("DELETE FROM periodograms WHERE bundle_id = ?", first);
        long next = bundle(segment);
        periodogram(next, new Float[] {.2f, .4f, .6f});
        assertEquals(next, gold.findCurrentBundle(TIC).orElseThrow().id());
        assertTrue(gold.findPeriodogram(TIC, first).isEmpty(), "이전 판의 캐시를 현재 판처럼 쓰지 않는다");
        assertArrayEquals(new Float[] {.2f, .4f, .6f}, gold.findPeriodogram(TIC, next).orElseThrow().power());
        assertTrue(goldCacheRedisTemplate.hasKey(GoldReadCache.periodogramKey(next)),
                "판 전환 알림이 없어도 조회가 새 판을 채운다");

        long otherTic = TIC + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 1, 'published')", otherTic);
        long otherSegment = jdbc.queryForObject("INSERT INTO light_curve_segments"
                + "(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps)"
                + " VALUES (?, 7, 'bin-10m-v1', 1500, 10, 4, ?, '[]'::jsonb) RETURNING id",
                Long.class, otherTic, new Float[] {1f, 1f, 1f, 1f});
        assertEquals(otherTic, gold.findSegments(otherTic, List.of(otherSegment)).getFirst().ticId());
        assertFalse(goldCacheRedisTemplate.hasKey(GoldReadCache.segmentKey(List.of(otherSegment))),
                "지정하지 않은 별도 DB에서 조회하며 캐시를 점유하지 않는다");

        CACHE.stop();
        assertArrayEquals(new Float[] {.8f, null, .8f, .8f}, gold.findSegments(TIC, List.of(segment)).getFirst().flux(),
                "Redis 장애 때도 DB 조회가 성공한다");
    }

    private long bundle(long segment) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                + " VALUES (?, ?, 'current', ?::jsonb, 1510.25, 27.4) RETURNING id",
                Long.class, TIC, "v-" + UUID.randomUUID(),
                GoldCatalogSchemaTest.VALID_MANIFEST.replace("[1]", "[" + segment + "]"));
    }

    private void periodogram(long bundle, Float[] power) {
        jdbc.update("INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power)"
                + " VALUES (?, 0.5, 40, 3, ?)", bundle, power);
    }
}
