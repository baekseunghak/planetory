package com.planetory.backend.domain.exploration.service;

import com.sun.net.httpserver.HttpServer;
import com.planetory.backend.global.error.BusinessException;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.*;

/** 격리 PostgreSQL + 로컬 HTTP fixture. NASA 실조회나 공유 DB에 의존하지 않는다. */
@Testcontainers
class NasaPlanetInfoTest {

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withDatabaseName("planetory_poc").withUsername("planetory").withPassword("test-only-placeholder");

    private static final LinkedBlockingQueue<Reply> REPLIES = new LinkedBlockingQueue<>();
    private static final AtomicInteger CALLS = new AtomicInteger();
    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;
    private static HttpServer server;
    private static ExecutorService serverPool;
    private static JdbcTemplate jdbc;
    private static NasaPlanetInfoRepository repository;
    private static NasaPlanetInfoService service;
    private long tic;
    private long member;
    private long bundle;

    @BeforeAll
    static void setup() throws IOException {
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").load().migrate();
        var dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
        jdbc = new JdbcTemplate(dataSource);
        repository = new NasaPlanetInfoRepository(JdbcClient.create(dataSource));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverPool = Executors.newCachedThreadPool();
        server.setExecutor(serverPool);
        server.createContext("/TAP/sync", exchange -> {
            CALLS.incrementAndGet();
            Reply reply;
            try {
                reply = REPLIES.poll(3, TimeUnit.SECONDS);
                if (reply == null) {
                    reply = new Reply(500, "missing fixture", null);
                }
                if (reply.release() != null && !reply.headersFirst()) {
                    reply.release().await(3, TimeUnit.SECONDS);
                }
                byte[] body = reply.body().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(reply.status(), body.length);
                if (reply.release() != null && reply.headersFirst()) {
                    reply.release().await(3, TimeUnit.SECONDS);
                }
                exchange.getResponseBody().write(body);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (IOException closedByTimeout) {
                // timeout 사례에서는 client가 먼저 연결을 닫는다.
            } finally {
                exchange.close();
            }
        });
        server.start();
        service = newService(Duration.ofSeconds(2));
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            server.stop(0);
        }
        if (serverPool != null) {
            serverPool.shutdownNow();
        }
    }

    @BeforeEach
    void seed() {
        REPLIES.clear();
        CALLS.set(0);
        String unique = UUID.randomUUID().toString();
        tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        member = jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status)"
                + " VALUES (?,0,'published')", tic);
        bundle = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,"
                + "manifest,fold_reference_time_btjd,base_days)"
                + " VALUES (?,?,'current',?::jsonb,1500.5,27) RETURNING id", Long.class,
                tic, unique, MANIFEST);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,"
                + "world_x,world_y,layout_version,layout_ordinal)"
                + " VALUES (?,?,'tutorial',0,now(),0,0,'test',0)", member, tic);
    }

    @Test
    void V25는_앱에_새_테이블_읽기와_갱신만_허용한다() {
        for (String privilege : new String[]{"SELECT", "INSERT", "UPDATE"}) {
            assertTrue(jdbc.queryForObject("SELECT has_table_privilege('planetory_app',"
                    + "'nasa_planet_info',?)", Boolean.class, privilege), privilege);
        }
        assertFalse(jdbc.queryForObject("SELECT has_table_privilege('planetory_app',"
                + "'nasa_planet_info','DELETE')", Boolean.class));
    }

    @Test
    void 복수_행성에서_요청한_후보만_저장하고_정규화_변경을_감지한다() {
        long b = candidate("TOI-700 b");
        long c = candidate("TOI-700 c");
        reply(200, rows(row("TOI-700 b", "9.0", "Published Confirmed", 0),
                row("TOI-700 c", "12.0", "Published Confirmed", 0)));

        var first = service.lookup(member, b);
        assertEquals("ready", first.status());
        assertEquals("TOI-700 b", first.planet().planetName());
        assertEquals("9", first.planet().periodDays().value().toPlainString());
        assertEquals("days", first.planet().periodDays().unit());
        assertEquals("Paper A", first.planet().periodDays().reference());
        assertEquals("-0.2", first.planet().periodDays().errorMinus().toPlainString());
        assertEquals(-1, first.planet().radiusEarth().limit());
        assertNull(first.planet().massEarth().value());
        assertEquals("Discovery paper", first.planet().discoveryReference());
        assertEquals(1, CALLS.get());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM nasa_planet_info WHERE tic_id=?",
                Integer.class, tic));
        assertEquals(first.sourceHash(), service.lookup(member, b).sourceHash());
        assertEquals(1, CALLS.get(), "7일 안에는 외부 호출을 재사용한다");

        reply(200, rows(row("TOI-700 b", "9.0", "Published Confirmed", 0),
                row("TOI-700 c", "12.0", "Published Confirmed", 0)));
        assertEquals("TOI-700 c", service.lookup(member, c).planet().planetName());
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM nasa_planet_info WHERE tic_id=?",
                Integer.class, tic));

        expire(b);
        reply(200, rows(row("TOI-700 b", "9.00", "Published Confirmed", 0)));
        var unchanged = service.lookup(member, b);
        assertEquals(first.sourceHash(), unchanged.sourceHash(), "소수 표기만 바뀌면 원본 버전은 유지한다");
        assertEquals(first.changedAt(), unchanged.changedAt());
        expire(b);
        reply(200, rows(row("TOI-700 b", "10.0", "Published Confirmed", 0)));
        var changed = service.lookup(member, b);
        assertNotEquals(first.sourceHash(), changed.sourceHash());
        assertNotEquals(first.changedAt(), changed.changedAt());
    }

    @Test
    void 검증된_행성명이_없거나_중복되면_추측하지_않는다() {
        long unauthorized = candidate("TOI-700 a");
        String unique = UUID.randomUUID().toString();
        long stranger = jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname)"
                + " VALUES ('test',?,?) RETURNING id", Long.class, unique, "n-" + unique);
        assertThrows(BusinessException.class, () -> service.lookup(stranger, unauthorized));
        jdbc.update("UPDATE candidates SET is_confirmed=false WHERE id=?", unauthorized);
        assertThrows(BusinessException.class, () -> service.lookup(member, unauthorized));
        assertEquals(0, CALLS.get(), "미매칭·미확정 대상은 NASA에 전송하지 않는다");

        long missing = candidate(null);
        assertEquals("identity_unresolved", service.lookup(member, missing).status());
        assertEquals(0, CALLS.get());

        long ambiguous = candidate("TOI-700 b");
        jdbc.update("INSERT INTO external_signal_references(candidate_id,source,external_id,"
                + "fetched_on,tic_id) VALUES (?,'archive','TOI-700 c',current_date,?)", ambiguous, tic);
        assertEquals("identity_unresolved", service.lookup(member, ambiguous).status());
        assertEquals(0, CALLS.get());

        long exact = candidate("TOI-700 d");
        reply(200, rows(row("TOI-700 d", "20", "Published Confirmed", 0),
                row("TOI-700 d", "21", "Published Confirmed", 0)));
        assertEquals("identity_unresolved", service.lookup(member, exact).status());
        assertNull(repository.find(exact).orElseThrow().planet());
        assertEquals(1, CALLS.get());
    }

    @Test
    void 은퇴한_후보의_Archive_참조는_현재_후보를_막지_않는다() {
        long previous = candidate("TOI-700 b");
        long current = candidate("TOI-700 b");
        assertEquals("identity_unresolved", service.lookup(member, current).status());
        assertEquals(0, CALLS.get(), "활성 후보끼리 이름을 공유하면 NASA를 호출하지 않는다");

        jdbc.update("UPDATE candidates SET status='retired' WHERE id=?", previous);
        reply(200, rows(row("TOI-700 b", "9", "Published Confirmed", 0)));
        assertEquals("ready", service.lookup(member, current).status());
        assertEquals(1, CALLS.get(), "지난 판의 은퇴 후보는 현재 후보의 연결을 막지 않는다");
    }

    @Test
    void 빈_결과와_논쟁_상태를_보존하고_429_5xx_timeout에_이전_정상값을_유지한다() {
        long empty = candidate("TOI-700 e");
        reply(200, "[]");
        assertEquals("not_found", service.lookup(member, empty).status());
        assertEquals("not_found", service.lookup(member, empty).status());
        assertEquals(1, CALLS.get(), "빈 결과는 1일 재확인 전까지 재사용한다");

        long b = candidate("TOI-700 b");
        reply(200, rows(row("TOI-700 b", "9", "Published Confirmed", 1)));
        var ready = service.lookup(member, b);
        assertTrue(ready.planet().controversial(), "논쟁 표식을 확정 판정과 별개로 보존한다");
        expire(b);
        reply(429, "rate limited"); reply(429, "rate limited");
        var limited = service.lookup(member, b);
        assertEquals("ready", limited.status());
        assertEquals("rate_limited", limited.refreshStatus());
        assertEquals(ready.sourceHash(), limited.sourceHash());

        expire(b);
        reply(503, "unavailable"); reply(503, "unavailable");
        assertEquals("upstream_error", service.lookup(member, b).refreshStatus());
        expire(b);
        CountDownLatch slow = new CountDownLatch(1);
        REPLIES.add(new Reply(200, "[]", slow));
        REPLIES.add(new Reply(200, "[]", slow, true));
        var shortTimeout = newService(Duration.ofMillis(150));
        assertEquals("timeout", shortTimeout.lookup(member, b).refreshStatus());
        slow.countDown();
        assertEquals(ready.sourceHash(), repository.find(b).orElseThrow().hash());

        expire(b);
        reply(200, rows(row("TOI-700 b", "9", "Published Confirmed", 1)
                .replace("\"pl_radelim\":-1", "\"pl_radelim\":7")));
        assertEquals("invalid_response", service.lookup(member, b).refreshStatus());
        assertEquals(ready.sourceHash(), repository.find(b).orElseThrow().hash());

        expire(b);
        reply(200, "[]");
        var noLongerPresent = service.lookup(member, b);
        assertEquals("not_found", noLongerPresent.status());
        assertNull(noLongerPresent.planet(), "이전 JSON을 새 정상 자료처럼 노출하지 않는다");
        assertNotNull(repository.find(b).orElseThrow().planet(), "이전 정상 JSON은 DB에 보존한다");
    }

    @Test
    void 동시_요청은_하나만_조회하고_늦은_응답이_새_자료를_덮지_못한다() throws Exception {
        long b = candidate("TOI-700 b");
        CountDownLatch firstRelease = new CountDownLatch(1);
        REPLIES.add(new Reply(200, rows(row("TOI-700 b", "9", "Published Confirmed", 0)), firstRelease));
        var pool = Executors.newSingleThreadExecutor();
        try {
            var first = pool.submit(() -> service.lookup(member, b));
            while (CALLS.get() == 0) {
                Thread.sleep(10);
            }
            assertEquals("refreshing", service.lookup(member, b).status());
            assertEquals(1, CALLS.get());
            jdbc.update("UPDATE nasa_planet_info SET in_flight_until=now()-interval '1 second',"
                    + " next_refresh_at=now()-interval '1 second' WHERE candidate_id=?", b);
            reply(200, rows(row("TOI-700 b", "10", "Published Confirmed", 0)));
            assertEquals("10", service.lookup(member, b).planet().periodDays().value().toPlainString());
            firstRelease.countDown();
            assertEquals("10", first.get(3, TimeUnit.SECONDS).planet().periodDays().value().toPlainString());
            assertEquals("10", repository.find(b).orElseThrow().planet().periodDays().value().toPlainString());
        } finally {
            firstRelease.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void Gold_식별자_정정은_기존_자료와_진행_중인_옛_시도를_무효화한다() {
        long candidateId = candidate("TOI-700 b");
        reply(200, rows(row("TOI-700 b", "9", "Published Confirmed", 0)));
        var old = service.lookup(member, candidateId);
        expire(candidateId);
        OffsetDateTime now = OffsetDateTime.now();
        long oldGeneration = repository.claim(candidateId, tic, "TOI-700 b", now,
                now.plusSeconds(15)).orElseThrow();

        String repairSql = """
                WITH verified AS (
                    SELECT c.id, c.tic_id, MIN(e.external_id) AS archive_planet_name
                      FROM candidates c
                      JOIN external_signal_references e
                        ON e.candidate_id=c.id AND e.tic_id=c.tic_id AND e.source='archive'
                     WHERE c.id=? AND c.status='active' AND c.is_confirmed
                     GROUP BY c.id, c.tic_id
                    HAVING COUNT(DISTINCT e.external_id)=1 AND MIN(e.external_id) !~ '^[[:space:]]*$'
                )
                UPDATE nasa_planet_info n
                   SET tic_id=v.tic_id, archive_planet_name=v.archive_planet_name,
                       status='pending', normalized=NULL, source_hash=NULL, source_version=NULL,
                       fetched_at=NULL, changed_at=NULL, next_refresh_at=now(),
                       in_flight_until=NULL, attempt_generation=n.attempt_generation+1,
                       last_refresh_status='identity_corrected'
                  FROM verified v
                 WHERE n.candidate_id=v.id
                   AND n.tic_id=? AND n.archive_planet_name=?
                   AND (n.tic_id,n.archive_planet_name) IS DISTINCT FROM (v.tic_id,v.archive_planet_name)
                   AND NOT EXISTS (
                       SELECT 1 FROM external_signal_references other
                       JOIN candidates other_candidate
                         ON other_candidate.id=other.candidate_id
                        AND other_candidate.status='active'
                        WHERE other.source='archive' AND other.tic_id=v.tic_id
                          AND other.external_id=v.archive_planet_name AND other.candidate_id<>v.id
                   )
                RETURNING n.attempt_generation
                """;
        for (String blankName : new String[]{" ", "\t"}) {
            jdbc.update("UPDATE external_signal_references SET external_id=?"
                    + " WHERE candidate_id=? AND source='archive'", blankName, candidateId);
            assertEquals("identity_unresolved", service.lookup(member, candidateId).status());
            assertTrue(jdbc.queryForList(repairSql, Long.class,
                    candidateId, tic, "TOI-700 b").isEmpty());
        }

        jdbc.update("UPDATE external_signal_references SET external_id='TOI-700 c'"
                + " WHERE candidate_id=? AND source='archive'", candidateId);
        assertEquals("identity_changed", service.lookup(member, candidateId).refreshStatus());
        var correctedGenerations = jdbc.queryForList(repairSql, Long.class,
                candidateId, tic, "TOI-700 b");
        assertEquals(1, correctedGenerations.size());
        long correctedGeneration = correctedGenerations.getFirst();
        assertEquals(oldGeneration + 1, correctedGeneration);

        repository.ready(candidateId, oldGeneration, old.planet(), old.sourceHash(),
                now, now.plusDays(7));
        var corrected = repository.find(candidateId).orElseThrow();
        assertEquals("pending", corrected.status());
        assertNull(corrected.planet());
        assertNull(corrected.hash());
        assertNull(corrected.fetchedAt());

        reply(200, rows(row("TOI-700 c", "12", "Published Confirmed", 0)));
        var refreshed = service.lookup(member, candidateId);
        assertEquals("ready", refreshed.status());
        assertEquals("TOI-700 c", refreshed.planet().planetName());
    }

    private static NasaPlanetInfoService newService(Duration timeout) {
        URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/TAP/sync");
        return new NasaPlanetInfoService(repository,
                new NasaTapClient(endpoint, Duration.ofSeconds(1), timeout, 2), Clock.systemUTC(),
                true, Duration.ofDays(7), Duration.ofDays(1), Duration.ofMinutes(5));
    }

    private long candidate(String name) {
        long id = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,"
                + "removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,"
                + "transit_model,discoverable,is_confirmed)"
                + " VALUES (?,'active',?,1,9,1501,2,1000,12,'{}'::jsonb,true,true) RETURNING id",
                Long.class, tic, bundle);
        jdbc.update("INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,"
                + "curve_step,removed_candidate_ids,submitted_period,phase_start,phase_end,"
                + "fold_reference_time_btjd,user_judgment,evidence_checks,match_result,"
                + "matched_candidate_id,achievement_result,residual_model_version,"
                + "periodogram_config_version,rule_version)"
                + " VALUES (?,?,?,?::uuid,'candidate',0,'{}',9,0.1,0.2,1500.5,'LIKELY_PLANET',"
                + "'[]'::jsonb,'matched',?,'recognized','rm-1','pg-1','rule-0')",
                member, tic, bundle, UUID.randomUUID().toString(), id);
        if (name != null) {
            jdbc.update("INSERT INTO external_signal_references(candidate_id,source,external_id,"
                    + "fetched_on,tic_id) VALUES (?,'archive',?,current_date,?)", id, name, tic);
        }
        return id;
    }

    private void expire(long candidateId) {
        jdbc.update("UPDATE nasa_planet_info SET next_refresh_at=now()-interval '1 second'"
                + " WHERE candidate_id=?", candidateId);
    }

    private static void reply(int status, String body) {
        REPLIES.add(new Reply(status, body, null));
    }

    private static String rows(String... values) {
        return "[" + String.join(",", values) + "]";
    }

    private String row(String name, String period, String solution, int controversial) {
        return """
                {"tic_id":"TIC %d","hostname":"TOI-700","pl_name":"%s","default_flag":1,
                "soltype":"%s","pl_controv_flag":%d,"pl_refname":"Paper A",
                "pl_orbper":%s,"pl_orbpererr1":0.1,"pl_orbpererr2":-0.2,"pl_orbperlim":0,
                "pl_rade":1.2,"pl_radeerr1":null,"pl_radeerr2":null,"pl_radelim":-1,
                "pl_masse":null,"pl_masseerr1":null,"pl_masseerr2":null,"pl_masselim":null,
                "discoverymethod":"Transit","disc_year":2020,"disc_refname":"Discovery paper"}
                """.formatted(tic, name, solution, controversial, period);
    }

    private record Reply(int status, String body, CountDownLatch release, boolean headersFirst) {
        Reply(int status, String body, CountDownLatch release) {
            this(status, body, release, false);
        }
    }
}
