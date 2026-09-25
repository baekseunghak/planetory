package com.planetory.backend.domain.exploration.service;

import com.sun.net.httpserver.HttpServer;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Measurement;
import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/** 일회용 DB와 NASA·모델 stub. 실제 외부 호출과 기존 DB 변경은 없다. */
@Testcontainers
class NasaStarPlanetTest {

    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withDatabaseName("planetory_poc").withUsername("planetory")
            .withPassword("test-only-placeholder");

    private static final String MANIFEST = """
            {"segment_ids":[1],"array_checksums":{},"residual_model_version":"rm-1",
             "periodogram_config_version":"pg-1","binning":{},"period_grid":{},
             "fine_tune":{},"curve_steps":{}}
            """;
    private static JdbcTemplate jdbc;
    private static DataSourceTransactionManager transactions;
    private static NasaStarPlanetRepository repository;
    private static NasaPlanetInfoRepository normalized;

    private NasaTapClient tap;
    private NasaPlanetExplanationGenerator generator;
    private NasaExplanationQuota quota;
    private NasaStarPlanetService service;
    private long tic;
    private long member;
    private long stranger;
    private long bundle;

    @BeforeAll
    static void migrate() {
        Flyway.configure().dataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword())
                .locations("classpath:db/migration").load().migrate();
        var dataSource = new DriverManagerDataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword());
        jdbc = new JdbcTemplate(dataSource);
        transactions = new DataSourceTransactionManager(dataSource);
        JdbcClient client = JdbcClient.create(dataSource);
        repository = new NasaStarPlanetRepository(client, transactions);
        normalized = new NasaPlanetInfoRepository(client);
    }

    @BeforeEach
    void seed() {
        String unique = UUID.randomUUID().toString();
        tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        member = jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname)"
                + " VALUES ('test',?,?) RETURNING id", Long.class, unique, "n-" + unique);
        stranger = jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname)"
                + " VALUES ('test',?,?) RETURNING id", Long.class, unique + "-other", "n-other-" + unique);
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status)"
                + " VALUES (?,0,'published')", tic);
        bundle = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,"
                + "manifest,fold_reference_time_btjd,base_days)"
                + " VALUES (?,?,'current',?::jsonb,1500.5,27) RETURNING id", Long.class,
                tic, unique, MANIFEST);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,"
                + "world_x,world_y,layout_version,layout_ordinal)"
                + " VALUES (?,?,'tutorial',0,now(),0,0,'test',0)", member, tic);
        tap = mock(NasaTapClient.class);
        when(tap.leaseDuration()).thenReturn(Duration.ofSeconds(10));
        generator = mock(NasaPlanetExplanationGenerator.class);
        quota = new NasaExplanationQuota(JdbcClient.create(jdbc.getDataSource()), transactions, 2);
        service = service(false);
    }

    @Test
    void 답_제출과_active_회원만_목록을_열고_skipped는_정답을_노출하지_않는다() throws Exception {
        notFound(() -> service.read(member, tic));
        submission(member, "skipped", "skipped");
        notFound(() -> service.requestCatalog(member, tic));
        submission(stranger, "no_candidate", "none_wrong");
        notFound(() -> service.read(member, tic));
        notFound(() -> service.read(stranger, tic + 1));
        verify(tap, never()).fetch(anyLong());

        candidateSubmission(member);
        assertEquals("not_requested", service.read(member, tic).status());
        jdbc.update("UPDATE users SET status='withdrawn' WHERE id=?", member);
        notFound(() -> service.read(member, tic));
        notFound(() -> service.requestCatalog(member, tic));
        verify(tap, never()).fetch(anyLong());
    }

    @Test
    void 정상_빈_목록과_내부_후보없는_복수_행성은_개별_ID로_재사용한다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        assertEquals("not_requested", service.read(member, tic).status());
        verify(tap, never()).fetch(anyLong());

        when(tap.fetch(tic)).thenReturn(List.of(), List.of(planet("TOI-700 b", "9.00"),
                planet("TOI-700 c", "12")));
        var empty = service.requestCatalog(member, tic);
        assertEquals("empty", empty.status());
        assertTrue(empty.complete());
        assertTrue(empty.planets().isEmpty());
        assertEquals("empty", service.requestCatalog(member, tic).status());
        verify(tap, times(1)).fetch(tic);

        expire();
        var multi = service.requestCatalog(member, tic);
        assertEquals("ready", multi.status());
        assertTrue(multi.complete());
        assertEquals(2, multi.planets().size());
        assertEquals(List.of("TOI-700 b", "TOI-700 c"),
                multi.planets().stream().map(NasaStarPlanetService.Item::name).toList());
        var b = multi.planets().getFirst();
        assertEquals("np-" + NasaPlanetInfoService.sha256(tic + ":TOI-700 b"), b.planetId());
        assertEquals("9.00", b.facts().orbitalPeriod().value());
        assertEquals("0.1", b.facts().orbitalPeriod().errorPlus());
        assertEquals("-0.2", b.facts().orbitalPeriod().errorMinus());
        assertEquals(-1, b.facts().radius().limit());
        assertNull(b.facts().mass().value());
        assertEquals("disabled", b.explanationStatus());
        assertEquals(multi.planets(), service.read(member, tic).planets());
        assertEquals(multi.planets(), service.requestCatalog(member, tic).planets());
        verify(tap, times(2)).fetch(tic);
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM candidates WHERE tic_id=?",
                Integer.class, tic));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements"
                + " WHERE user_id=?", Integer.class, member));
    }

    @Test
    void 중복_기본해는_부분상태이고_정상_행성을_유지하며_삭제된_행성은_숨긴다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        Planet published = planet("TOI-700 b", "9");
        Planet unconfirmed = new Planet(published.sourceTable(), published.planetName(),
                published.hostName(), published.ticId(), "Candidate", published.controversial(),
                published.periodDays(), published.radiusEarth(), published.massEarth(),
                published.discoveryMethod(), published.discoveryYear(), published.discoveryReference());
        when(tap.fetch(tic)).thenReturn(List.of(planet("TOI-700 b", "9"), planet("TOI-700 c", "12")),
                List.of(planet("TOI-700 b", "9"), planet("TOI-700 b", "10"),
                        planet("TOI-700 c", "12")),
                List.of(published, unconfirmed, planet("TOI-700 c", "12")),
                List.of(planet("TOI-700 b", "11")));
        assertEquals(2, service.requestCatalog(member, tic).planets().size());
        expire();
        var partial = service.requestCatalog(member, tic);
        assertEquals("partial", partial.status());
        assertFalse(partial.complete());
        assertEquals(2, partial.planets().size());
        assertEquals("identity_unresolved", partial.planets().getFirst().sourceStatus());
        assertNull(partial.planets().getFirst().facts());
        assertEquals("ready", partial.planets().get(1).sourceStatus());
        assertEquals("12", partial.planets().get(1).facts().orbitalPeriod().value());
        expire();
        var stalePartial = service.read(member, tic);
        assertEquals("stale", stalePartial.status());
        assertFalse(stalePartial.complete());
        assertEquals("partial", stalePartial.refreshStatus());
        var mixed = service.requestCatalog(member, tic);
        assertEquals("partial", mixed.status());
        assertEquals("identity_unresolved", mixed.planets().getFirst().sourceStatus());
        expire();
        var corrected = service.requestCatalog(member, tic);
        assertEquals("ready", corrected.status());
        assertEquals(List.of("TOI-700 b"), corrected.planets().stream()
                .map(NasaStarPlanetService.Item::name).toList());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM nasa_star_planet"
                + " WHERE tic_id=? AND NOT active", Integer.class, tic));
        verify(tap, times(4)).fetch(tic);
    }

    @Test
    void 한_행성의_잘못된_수치는_다른_행성을_지우지_않는다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        Planet valid = planet("TOI-700 b", "9");
        Planet bad = new Planet(valid.sourceTable(), valid.planetName(), valid.hostName(),
                valid.ticId(), valid.solutionType(), valid.controversial(),
                new Measurement(new BigDecimal("9"), new BigDecimal("-0.1"),
                        null, 0, "days", null), valid.radiusEarth(), valid.massEarth(),
                valid.discoveryMethod(), valid.discoveryYear(), valid.discoveryReference());
        when(tap.fetch(tic)).thenReturn(List.of(bad, planet("TOI-700 c", "12")));

        var partial = service.requestCatalog(member, tic);
        assertEquals("partial", partial.status());
        assertFalse(partial.complete());
        assertEquals("invalid_source", partial.planets().getFirst().sourceStatus());
        assertNull(partial.planets().getFirst().facts());
        assertEquals("ready", partial.planets().get(1).sourceStatus());
        assertEquals("12", partial.planets().get(1).facts().orbitalPeriod().value());
    }

    @Test
    void 재확인_장애는_기존_행성을_보존하되_완전한_최신_목록으로_표시하지_않는다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        when(tap.fetch(tic)).thenReturn(List.of(planet("TOI-700 b", "9")))
                .thenThrow(new NasaTapClient.FetchFailure("rate_limited"));
        var first = service.requestCatalog(member, tic);
        assertEquals(1, first.planets().size());
        expire();
        var stale = service.requestCatalog(member, tic);
        assertFalse(stale.complete());
        assertEquals("rate_limited", stale.refreshStatus());
        assertEquals(first.fetchedAt(), stale.fetchedAt());
        assertEquals(first.planets().getFirst().facts(), stale.planets().getFirst().facts());
        assertEquals("stale", stale.status());
    }

    @Test
    void 상한을_넘은_NASA_응답은_기존_완전_목록을_줄이지_않는다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        when(tap.fetch(tic)).thenReturn(List.of(planet("TOI-700 b", "9")));
        var first = service.requestCatalog(member, tic);
        expire();

        byte[] rows = ("[" + "{},".repeat(64) + "{}]").getBytes(StandardCharsets.UTF_8);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/TAP/sync", exchange -> {
            exchange.sendResponseHeaders(200, rows.length);
            try (var body = exchange.getResponseBody()) { body.write(rows); }
        });
        server.start();
        try {
            tap = new NasaTapClient(URI.create("http://127.0.0.1:"
                    + server.getAddress().getPort() + "/TAP/sync"),
                    Duration.ofSeconds(1), Duration.ofSeconds(1), 1);
            service = service(false);
            var stale = service.requestCatalog(member, tic);
            assertFalse(stale.complete());
            assertEquals("invalid_response", stale.refreshStatus());
            assertEquals(first.fetchedAt(), stale.fetchedAt());
            assertEquals(first.planets().getFirst().planetId(), stale.planets().getFirst().planetId());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void 한_행성의_모델실패는_다른_행성설명과_원천을_훼손하지_않는다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        when(tap.fetch(tic)).thenReturn(List.of(planet("TOI-700 b", "9"), planet("TOI-700 c", "12")));
        var catalog = service.requestCatalog(member, tic);
        service = service(true);
        var b = catalog.planets().getFirst();
        var c = catalog.planets().get(1);
        when(generator.generate(any(), anyString())).thenAnswer(call -> {
            Planet source = call.getArgument(0);
            if (source.planetName().equals("TOI-700 c")) throw new IllegalArgumentException("bad draft");
            return draft(call.getArgument(1));
        });

        var ready = service.requestExplanation(member, tic, b.planetId());
        assertEquals("ready", ready.planets().getFirst().explanationStatus());
        assertNotNull(ready.planets().getFirst().explanation().name());
        assertEquals("not_requested", ready.planets().get(1).explanationStatus());
        var failed = service.requestExplanation(member, tic, c.planetId());
        assertEquals("ready", failed.planets().getFirst().explanationStatus());
        assertEquals("failed", failed.planets().get(1).explanationStatus());
        assertEquals("invalid_output", failed.planets().get(1).failure());
        assertNotNull(failed.planets().get(1).facts());
        assertNull(failed.planets().get(1).explanation());
        var disabled = service(false).read(member, tic);
        assertEquals("ready", disabled.planets().getFirst().explanationStatus());
        assertEquals("disabled", disabled.planets().get(1).explanationStatus());
        service.requestExplanation(member, tic, b.planetId());
        verify(generator, times(2)).generate(any(), anyString());
        assertEquals(2, jdbc.queryForObject("SELECT attempt_count FROM nasa_explanation_daily_total",
                Integer.class));

        expire();
        when(tap.fetch(tic)).thenReturn(List.of(planet("TOI-700 b", "10"),
                planet("TOI-700 c", "12")));
        var changed = service.requestCatalog(member, tic);
        assertEquals("not_requested", changed.planets().getFirst().explanationStatus());
        assertEquals("failed", changed.planets().get(1).explanationStatus());
        assertEquals("ready", service.requestExplanation(member, tic, b.planetId())
                .planets().getFirst().explanationStatus());
        verify(generator, times(3)).generate(any(), anyString());
        jdbc.update("UPDATE nasa_star_planet_explanation SET status='pending'"
                + " WHERE tic_id=? AND planet_id=?", tic, c.planetId());
        assertEquals("disabled", service(false).read(member, tic).planets().get(1).explanationStatus());
    }

    @Test
    void 동시_조회와_만료_임대에서_늦은_응답은_새_목록을_덮지_못한다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        when(tap.fetch(tic)).thenAnswer(call -> {
            if (calls.incrementAndGet() == 1) {
                entered.countDown();
                if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("fixture wait expired");
                return List.of(planet("TOI-700 b", "9"));
            }
            return List.of(planet("TOI-700 b", "10"));
        });
        var pool = Executors.newSingleThreadExecutor();
        try {
            var first = pool.submit(() -> service.requestCatalog(member, tic));
            assertTrue(entered.await(10, TimeUnit.SECONDS));
            assertFalse(service.requestCatalog(member, tic).complete());
            assertEquals(1, calls.get());
            jdbc.update("UPDATE nasa_star_catalog SET in_flight_until=now()-interval '1 second',"
                    + " next_refresh_at=now()-interval '1 second' WHERE tic_id=?", tic);
            assertEquals("10", service.requestCatalog(member, tic).planets().getFirst()
                    .facts().orbitalPeriod().value());
            release.countDown();
            assertEquals("10", first.get(10, TimeUnit.SECONDS).planets().getFirst()
                    .facts().orbitalPeriod().value());
            assertEquals(2, calls.get());
            assertEquals(2L, jdbc.queryForObject("SELECT attempt_generation FROM nasa_star_catalog"
                    + " WHERE tic_id=?", Long.class, tic));
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void 만료된_설명_임대의_늦은_모델응답은_새_세대_설명을_덮지_못한다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        when(tap.fetch(tic)).thenReturn(List.of(planet("TOI-700 b", "9")));
        String planetId = service.requestCatalog(member, tic).planets().getFirst().planetId();
        service = service(true);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        when(generator.generate(any(), anyString())).thenAnswer(call -> {
            String hash = call.getArgument(1);
            if (calls.incrementAndGet() == 1) {
                entered.countDown();
                if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("fixture wait expired");
                return draft(hash);
            }
            var second = draft(hash);
            return new NasaPlanetExplanationText.Draft(hash, second.planetName(),
                    "{{name}}에 대해 함께 알아볼까요?", second.orbitalPeriod(), second.radius(),
                    second.mass(), second.discovery());
        });
        var pool = Executors.newSingleThreadExecutor();
        try {
            var first = pool.submit(() -> service.requestExplanation(member, tic, planetId));
            assertTrue(entered.await(10, TimeUnit.SECONDS));
            assertEquals("pending", service.read(member, tic).planets().getFirst().explanationStatus());
            jdbc.update("UPDATE nasa_star_planet_explanation"
                    + " SET in_flight_until=now()-interval '1 second'"
                    + " WHERE tic_id=? AND planet_id=?", tic, planetId);
            var newer = service.requestExplanation(member, tic, planetId);
            assertEquals("ready", newer.planets().getFirst().explanationStatus());
            assertEquals("TOI-700 b에 대해 함께 알아볼까요?",
                    newer.planets().getFirst().explanation().name());
            release.countDown();
            first.get(10, TimeUnit.SECONDS);
            assertEquals("TOI-700 b에 대해 함께 알아볼까요?",
                    service.read(member, tic).planets().getFirst().explanation().name());
            assertEquals(2L, jdbc.queryForObject("SELECT attempt_generation"
                    + " FROM nasa_star_planet_explanation WHERE tic_id=? AND planet_id=?",
                    Long.class, tic, planetId));
            assertEquals(2, calls.get());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void NASA_호출_중_회원이_탈퇴하면_목록을_저장하거나_반환하지_않는다() throws Exception {
        submission(member, "no_candidate", "none_wrong");
        when(tap.fetch(tic)).thenAnswer(call -> {
            jdbc.update("UPDATE users SET status='withdrawn' WHERE id=?", member);
            return List.of(planet("TOI-700 b", "9"));
        });
        notFound(() -> service.requestCatalog(member, tic));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM nasa_star_planet WHERE tic_id=?",
                Integer.class, tic));
    }

    private NasaStarPlanetService service(boolean explanationEnabled) {
        return new NasaStarPlanetService(repository, normalized, tap, generator, quota,
                Clock.systemUTC(), transactions, true, Duration.ofDays(7), Duration.ofDays(1),
                Duration.ofMinutes(5), explanationEnabled, "gpt-5.4-mini", Duration.ofSeconds(8),
                Duration.ofHours(1), 10, 100);
    }

    private void submission(long user, String kind, String result) {
        jdbc.update("INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,"
                + "curve_step,removed_candidate_ids,fold_reference_time_btjd,evidence_checks,"
                + "match_result,achievement_result,residual_model_version,periodogram_config_version,rule_version)"
                + " VALUES (?,?,?,?::uuid,?,0,'{}',1500.5,'[]'::jsonb,?,'none','rm-1','pg-1','rule-0')",
                user, tic, bundle, UUID.randomUUID().toString(), kind, result);
    }

    private void candidateSubmission(long user) {
        jdbc.update("INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,"
                + "curve_step,removed_candidate_ids,submitted_period,phase_start,phase_end,"
                + "fold_reference_time_btjd,user_judgment,evidence_checks,match_result,"
                + "achievement_result,residual_model_version,periodogram_config_version,rule_version)"
                + " VALUES (?,?,?,?::uuid,'candidate',0,'{}',9,0.1,0.2,1500.5,'UNSURE',"
                + "'[]'::jsonb,'not_matched','none','rm-1','pg-1','rule-0')",
                user, tic, bundle, UUID.randomUUID().toString());
    }

    private void expire() {
        jdbc.update("UPDATE nasa_star_catalog SET next_refresh_at=now()-interval '1 second'"
                + " WHERE tic_id=?", tic);
    }

    private Planet planet(String name, String period) {
        return new Planet("ps", name, "TOI-700", "TIC " + tic, "Published Confirmed", null,
                new Measurement(new BigDecimal(period), new BigDecimal("0.1"),
                        new BigDecimal("-0.2"), 0, "days", "Paper A"),
                new Measurement(new BigDecimal("1.2"), null, null, -1, "earth_radius", "Paper A"),
                new Measurement(null, null, null, null, "earth_mass", null), "Transit", 2020, null);
    }

    private static NasaPlanetExplanationText.Draft draft(String hash) {
        return new NasaPlanetExplanationText.Draft(hash, "{{name}}",
                "이번에는 {{name}}에 대해 살펴볼까요?",
                "이 행성은 별 주위를 한 바퀴 도는 데 {{value}}.",
                "반지름을 살펴보면, {{value}}.",
                "질량은 이번 NASA 자료에서 확인할 수 없어요.", "이 행성은 {{value}}.");
    }

    private static void notFound(org.junit.jupiter.api.function.Executable action) {
        assertEquals(ErrorCode.RESOURCE_NOT_FOUND,
                assertThrows(BusinessException.class, action).getErrorCode());
    }
}
