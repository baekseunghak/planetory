package com.planetory.backend.domain.exploration.service;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import javax.sql.DataSource;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;
import com.planetory.backend.domain.exploration.service.ResidualJobStore.Job;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobAccepted;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobRequest;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.TargetRequest;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Worker 실행기 [S15P21C206-88]: current Gold로 요청을 조립하고 잔차 → 주기도 결과를 채택한다.
 *
 * <p>Worker 자리에는 가짜 HTTP 서버를 둔다. 계산 자체는 {@code apps/derived-compute}의 테스트가 본다.
 * 여기서는 Backend가 계약대로 보내고, 응답을 계약대로 가려 채택·실패시키는지만 본다.
 */
@ActiveProfiles("local")
@SpringBootTest
class WorkerResidualComputeRunnerTest {

    private static final String SCHEMA = "residual_worker_" + UUID.randomUUID().toString().replace("-", "");
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final HttpServer WORKER;
    /** 받은 요청 본문. */
    private static final List<JsonNode> RECEIVED = new CopyOnWriteArrayList<>();
    /** 요청 → (HTTP 상태, 본문). 테스트마다 바꾼다. */
    private static volatile Function<JsonNode, Reply> behavior = WorkerResidualComputeRunnerTest::echo;

    /** {@code body}가 문자열이면 그대로 보낸다(깨진 JSON 시험용). 아니면 JSON으로 쓴다. */
    record Reply(int status, Object body) {
    }

    static {
        try {
            WORKER = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        WORKER.createContext(WorkerResidualComputeRunner.PATH, exchange -> {
            JsonNode request = JSON.readTree(exchange.getRequestBody().readAllBytes());
            RECEIVED.add(request);
            Reply reply = behavior.apply(request);
            String text = reply.body() instanceof String raw ? raw : JSON.writeValueAsString(reply.body());
            byte[] body = text.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(reply.status(), body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        WORKER.start();
    }

    @DynamicPropertySource
    static void isolatedSchemaAndWorker(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
        registry.add("planetory.residual.worker-url",
                () -> "http://127.0.0.1:" + WORKER.getAddress().getPort() + "/");
        // 시간 초과 시험을 120초 기다리지 않게 줄인다. 다른 시험의 가짜 응답은 즉시 온다.
        registry.add("planetory.residual.operation-timeout-seconds", () -> 1);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        WORKER.stop(0);
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired ResidualJobService jobs;
    @Autowired InMemoryResidualJobStore store;
    @Autowired ResidualResultReader residuals;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;
    @Autowired WorkerResidualComputeRunner runner;

    private long member;
    private long ticId;
    private long bundleId;
    private long segmentLate;
    private long segmentEarly;
    private long first;
    private long second;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        store.clear();
        RECEIVED.clear();
        behavior = WorkerResidualComputeRunnerTest::echo;
        member = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, UUID.randomUUID().toString(),
                "n-" + UUID.randomUUID());
        ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, tmag, confirmed_count, service_status) VALUES (?, 9.8, 0, 'published')",
                ticId);
        var position = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, 0)",
                member, ticId, position.depthZ(), position.worldX(), position.worldY(), position.layoutVersion());
        // 삽입 순서와 계약 정렬(섹터 오름차순)을 일부러 어긋나게 둔다.
        segmentLate = insertSegment(15, 1700.0, new Float[] {1.0f, null, 0.9991f});
        segmentEarly = insertSegment(14, 1683.35, new Float[] {1.0001f, 0.9998f});
        bundleId = insertBundle("current", List.of(segmentLate, segmentEarly));
        jdbc.update("INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power)"
                + " VALUES (?, 0.5, 40.0, 3, ?)", bundleId, new Float[] {0.1f, 0.9f, 0.2f});
        // first의 id가 더 작다. 요청은 (second, first)로 보내 정렬을 확인한다.
        first = insertCandidate(2.0);
        second = insertCandidate(3.0);
        match(first);
        match(second);
    }

    // ---------- 성공 ----------

    @Test
    void assemblesContractRequestsAndAdoptsTheResult() {
        String jobId = request(List.of(second, first));
        Job job = awaitFinished(jobId);
        assertEquals(ResidualJobStore.COMPLETED, job.status(), () -> String.valueOf(job.failure()));

        JsonNode residual = RECEIVED.get(0);
        assertEquals("residual", residual.get("operation").asString());
        assertEquals(1, residual.get("attempt").asInt());
        assertEquals("b-" + bundleId, residual.get("publication_bundle_id").asString());
        assertEquals(String.valueOf(ticId), residual.get("tic_id").asString());
        // 섹터 순으로 정렬하고, 시작 시각은 옮기지 않으며, float32 값을 그대로 보낸다.
        JsonNode segments = residual.get("curve_segments");
        assertEquals("seg-" + segmentEarly, segments.get(0).get("segment_id").asString());
        assertEquals(1683.35, segments.get(0).get("start_btjd").asDouble());
        assertEquals((double) 1.0001f, segments.get(0).get("flux").get(0).asDouble());
        assertTrue(segments.get(1).get("flux").get(1).isNull());
        // 후보는 id 오름차순이고 transit_model.candidate_id를 c-<id>로 채운다.
        JsonNode removed = residual.get("removed_candidates");
        assertEquals("c-" + first, removed.get(0).get("candidate_id").asString());
        assertEquals("c-" + first, removed.get(0).get("transit_model").get("candidate_id").asString());
        assertEquals("box", removed.get(0).get("transit_model").get("shape").asString());

        JsonNode periodogram = RECEIVED.get(1);
        assertEquals("periodogram", periodogram.get("operation").asString());
        assertEquals(List.of("c-" + first, "c-" + second),
                JSON.convertValue(periodogram.get("removed_candidate_ids"), List.class));
        // 격자: 범위·점 수는 periodograms 열, 간격은 manifest.
        JsonNode grid = periodogram.get("period_grid");
        assertEquals(0.5, grid.get("min_days").asDouble());
        assertEquals(40.0, grid.get("max_days").asDouble());
        assertEquals(3, grid.get("count").asInt());
        assertEquals("log", grid.get("spacing").asString());
        assertEquals(scaled(segments.get(0).get("flux")),
                periodogram.get("residual_segments").get(0).get("flux"));

        ResidualResultReader.Lookup lookup = residuals.lookup(ticId, job.target());
        assertEquals(ResidualResultReader.Lookup.COMPLETED, lookup.status());
        assertArrayEquals(new Float[] {(float) (1.0001f * 2.0), (float) (0.9998f * 2.0)},
                lookup.segmentFlux().get(segmentEarly));
        assertNull(lookup.segmentFlux().get(segmentLate)[1]);
        assertArrayEquals(new Float[] {0.5f, 0.25f, 0.125f}, lookup.power());
    }

    // ---------- 실패 ----------

    @Test
    void workerErrorEndsTheJobWithoutRetry() {
        behavior = request -> new Reply(200, error(request, "invalid_parameter"));
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertEquals(new ResidualJobStore.Failure("RESIDUAL", "COMPUTE_ERROR", "계산하지 못했습니다.", false),
                job.failure());
    }

    @Test
    void busyWorkerIsRetryable() {
        behavior = request -> new Reply(503, JSON.createObjectNode().put("error", "busy"));
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertEquals("RESIDUAL", job.failure().stage());
        assertTrue(job.failure().retryable());
    }

    @Test
    void periodogramFailureNamesItsStage() {
        behavior = request -> "periodogram".equals(request.get("operation").asString())
                ? new Reply(200, error(request, "insufficient_observations"))
                : echo(request);
        Job job = awaitFinished(request(List.of(first)));
        assertEquals("PERIODOGRAM", job.failure().stage());
        assertFalse(job.failure().retryable());
    }

    @Test
    void slowWorkerTimesOutAsRetryable() {
        behavior = request -> {
            try {
                Thread.sleep(1_500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return echo(request);
        };
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertEquals("RESIDUAL", job.failure().stage());
        assertTrue(job.failure().retryable());
    }

    @Test
    void nonNumericResultIsNotAdopted() {
        behavior = request -> {
            Reply reply = echo(request);
            if ("periodogram".equals(request.get("operation").asString())) {
                ((ArrayNode) ((ObjectNode) reply.body()).get("result").get("power")).set(1, "0.25");
            }
            return reply;
        };
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertEquals("PERIODOGRAM", job.failure().stage());
        assertFalse(job.failure().retryable());
    }

    @Test
    void unreadablePeriodogramResponseNamesItsStage() {
        behavior = request -> "periodogram".equals(request.get("operation").asString())
                ? new Reply(200, "{not json")
                : echo(request);
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertEquals("PERIODOGRAM", job.failure().stage());
        assertFalse(job.failure().retryable());
    }

    @Test
    void mismatchedAttemptIsNotAdopted() {
        behavior = request -> {
            Reply reply = echo(request);
            ((ObjectNode) reply.body()).put("attempt", 99);
            return reply;
        };
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertFalse(job.failure().retryable());
    }

    @Test
    void newBundleDuringComputationDiscardsTheResult() {
        behavior = request -> {
            // 계산하는 사이에 새 판이 current가 된다.
            jdbc.update("UPDATE publication_bundles SET status = 'archived' WHERE id = ?", bundleId);
            insertBundle("current", List.of(segmentEarly));
            return echo(request);
        };
        Job job = awaitFinished(request(List.of(first)));
        assertEquals(ResidualJobStore.FAILED, job.status());
        assertEquals("BUNDLE_ARCHIVED", job.failure().stage());
        assertEquals(1, RECEIVED.size(), "잔차에서 멈추고 주기도를 부르지 않는다");
        CurveContext target = job.target();
        assertNull(residuals.lookup(ticId, target).status());
    }

    /**
     * 요청 검증을 통과한 뒤 후보가 Gold에서 사라진 경우. 요청 API로는 이 순간을 만들 수 없어 저장소에
     * 작업을 직접 넣고 실행기를 부른다.
     */
    @Test
    void missingCandidateFailsBeforeCallingTheWorker() {
        Job job = enqueue(new CurveContext("b-" + bundleId, 2, List.of("c-" + first, "c-999999999"),
                "box-divide-v0", "pg-log5000-v1"));
        runner.start(job);
        Job finished = awaitFinished(job.jobId());
        assertEquals(ResidualJobStore.FAILED, finished.status());
        assertEquals(new ResidualJobStore.Failure("RESIDUAL", "CANDIDATE_NOT_FOUND",
                "제거할 후보를 찾지 못했습니다. 최신 정보를 다시 불러와 주세요.", false), finished.failure());
        assertTrue(RECEIVED.isEmpty(), "Worker를 부르지 않는다");
    }

    /** 판 행 자체가 없는 경우. current가 아니라는 것과 같은 실패로 끝내고 Worker를 부르지 않는다. */
    @Test
    void missingBundleFailsBeforeCallingTheWorker() {
        Job job = enqueue(new CurveContext("b-999999999", 1, List.of("c-" + first),
                "box-divide-v0", "pg-log5000-v1"));
        runner.start(job);
        Job finished = awaitFinished(job.jobId());
        assertEquals(ResidualJobStore.FAILED, finished.status());
        assertEquals("BUNDLE_ARCHIVED", finished.failure().stage());
        assertEquals("BUNDLE_CHANGED", finished.failure().code());
        assertFalse(finished.failure().retryable());
        assertTrue(RECEIVED.isEmpty(), "Worker를 부르지 않는다");
    }

    private Job enqueue(CurveContext target) {
        var created = (ResidualJobStore.Enqueued.Created) store.enqueue(member, ticId, target,
                ResidualJobStore.cacheKey(ticId, target));
        return created.job();
    }

    // ---------- 가짜 Worker ----------

    /** 계약대로 답한다. 잔차는 flux × 2, 주기도는 0.5·0.25·0.125. */
    private static Reply echo(JsonNode request) {
        ObjectNode response = correlation(request);
        response.put("ok", true);
        response.putObject("runtime").put("worker_image", "fake");
        ObjectNode result = response.putObject("result");
        if ("residual".equals(request.get("operation").asString())) {
            ArrayNode out = result.putArray("residual_segments");
            request.get("curve_segments").forEach(segment -> out.addObject()
                    .put("segment_id", segment.get("segment_id").asString())
                    .put("n_points", segment.get("n_points").asInt())
                    .set("flux", scaled(segment.get("flux"))));
        } else {
            result.put("n_periods", request.get("period_grid").get("count").asInt());
            result.putArray("power").add(0.5).add(0.25).add(0.125);
        }
        return new Reply(200, response);
    }

    private static ArrayNode scaled(JsonNode flux) {
        ArrayNode out = JSON.createArrayNode();
        flux.forEach(value -> {
            if (value.isNull()) {
                out.addNull();
            } else {
                out.add(value.asDouble() * 2.0);
            }
        });
        return out;
    }

    private static ObjectNode error(JsonNode request, String code) {
        ObjectNode response = correlation(request);
        response.put("ok", false);
        response.putObject("error").put("stage", "RESIDUAL").put("code", code).put("retryable", false)
                .put("message", "fake failure");
        return response;
    }

    private static ObjectNode correlation(JsonNode request) {
        ObjectNode response = JSON.createObjectNode();
        for (String key : List.of("schema_version", "operation", "job_id", "attempt", "publication_bundle_id",
                "tic_id")) {
            response.set(key, request.get(key));
        }
        ArrayNode ids = response.putArray("removed_candidate_ids");
        if ("residual".equals(request.get("operation").asString())) {
            request.get("removed_candidates").forEach(candidate -> ids.add(candidate.get("candidate_id")));
        } else {
            request.get("removed_candidate_ids").forEach(ids::add);
        }
        return response;
    }

    // ---------- 준비 ----------

    private String request(List<Long> removed) {
        JobAccepted accepted = jobs.request(member, ticId, new JobRequest(new TargetRequest("b-" + bundleId,
                removed.stream().map(id -> "c-" + id).toList(), "box-divide-v0", "pg-log5000-v1"))).body();
        assertNotNull(accepted.jobId());
        return accepted.jobId();
    }

    private Job awaitFinished(String jobId) {
        Instant deadline = Instant.now().plus(Duration.ofSeconds(15));
        while (Instant.now().isBefore(deadline)) {
            Job job = store.find(jobId).orElseThrow();
            if (ResidualJobStore.COMPLETED.equals(job.status()) || ResidualJobStore.FAILED.equals(job.status())) {
                return job;
            }
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            }
        }
        throw new AssertionError(jobId + " 작업이 끝나지 않았습니다");
    }

    private long insertSegment(int sector, double start, Float[] flux) {
        return jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd,"
                        + " bin_minutes, n_points, flux, gaps) VALUES (?, ?, '10m-v1', ?, 10, ?, ?, '[]'::jsonb)"
                        + " RETURNING id",
                Long.class, ticId, sector, start, flux.length, flux);
    }

    private long insertBundle(String status, List<Long> segmentIds) {
        String manifest = """
                {"segment_ids": %s, "array_checksums": {},
                 "residual_model_version": "box-divide-v0", "periodogram_config_version": "pg-log5000-v1",
                 "binning": {"minutes": 10}, "period_grid": {"period_min_days": 0.5, "spacing": "log"},
                 "fine_tune": {"half_width_cells": 3}, "curve_steps": {}}
                """.formatted(segmentIds);
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, ?, ?::jsonb, 1683.4231, 81.4) RETURNING id",
                Long.class, ticId, "pv1-" + UUID.randomUUID(), status, manifest);
    }

    private long insertCandidate(double period) {
        String model = """
                {"shape": "box", "parameters": {"period_days": %s, "epoch_btjd": 1684.0, "duration_hours": 2.0,
                 "depth_ppm": 900}, "baseline": {"kind": "unity"}, "residual_model_version": "box-divide-v0"}
                """.formatted(period);
        return jdbc.queryForObject("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step,"
                        + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,"
                        + " discoverable, is_confirmed)"
                        + " VALUES (?, 'active', ?, 1, ?, 1684.0, 2.0, 900, 10.0, ?::jsonb, true, false)"
                        + " RETURNING id", Long.class, ticId, bundleId, period, model);
    }

    private void match(long candidateId) {
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.0, 0.1, 0.2, 1683.4231,"
                        + " 'LIKELY_PLANET', '[]'::jsonb, 'matched', ?, 'recognized', 'box-divide-v0',"
                        + " 'pg-log5000-v1', 'rule-0')",
                member, ticId, bundleId, UUID.randomUUID().toString(), candidateId);
    }
}
