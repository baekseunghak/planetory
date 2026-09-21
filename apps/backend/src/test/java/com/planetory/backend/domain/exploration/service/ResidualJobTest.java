package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobAccepted;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobRequest;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobStatus;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.TargetRequest;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 온라인 잔차 작업 요청·조회 (탐사 API 7.1·7.2절) [S15P21C206-147].
 *
 * <p>계산 자체는 Worker 어댑터(S15P21C206-88)가 맡는다. 여기서는 계산을 시작시키는 자리에 기록만
 * 하는 실행기를 두고, 단계 전이는 저장소로 직접 만들어 계약을 본다. 실제 Redis·Worker 연동 검사는
 * I10 뒤에 한다.
 */
@ActiveProfiles("local")
@SpringBootTest
class ResidualJobTest {

    private static final String SCHEMA = "residual_job_" + UUID.randomUUID().toString().replace("-", "");

    @DynamicPropertySource
    static void isolatedSchemaAndSmallQueue(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
        // 상한을 작게 잡아야 429를 사람 수 셋으로 확인할 수 있다.
        registry.add("planetory.residual.max-running", () -> 1);
        registry.add("planetory.residual.max-queued", () -> 1);
        registry.add("planetory.residual.per-member", () -> 1);
        registry.add("planetory.residual.retry-after-seconds", () -> 7);
        registry.add("planetory.residual.poll-after-seconds", () -> 2);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    /** 계산을 시작시키는 자리. 실제 실행은 Worker 어댑터가 채운다. */
    static class RecordingRunner implements ResidualComputeRunner {
        final List<ResidualJobStore.Job> started = Collections.synchronizedList(new ArrayList<>());
        /** 워커 제출·실행기 등록이 동기로 실패하는 상황. */
        volatile RuntimeException failure;

        @Override
        public void start(ResidualJobStore.Job job) {
            started.add(job);
            if (failure != null) {
                throw failure;
            }
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Runners {
        @Bean
        RecordingRunner recordingRunner() {
            return new RecordingRunner();
        }
    }

    @Autowired ResidualJobService jobs;
    @Autowired InMemoryResidualJobStore store;
    @Autowired ResidualResultReader residuals;
    @Autowired AnalysisService analysis;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;
    @Autowired RecordingRunner runner;

    private long member;
    private long stranger;
    private long ticId;
    private long currentBundleId;
    private long archivedBundleId;
    private long segmentId;
    private long firstMatched;
    private long secondMatched;
    private long unmatched;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        // 저장소는 인스턴스 안에 있어 테스트끼리 남는다. 상한 검사가 앞 테스트의 작업에 걸린다.
        store.clear();
        runner.started.clear();
        runner.failure = null;
        member = insertMember();
        stranger = insertMember();
        ticId = insertStar("published");
        unlock(member, ticId);
        unlock(stranger, ticId);
        segmentId = insertSegment(ticId, 14);
        archivedBundleId = insertBundle("archived");
        currentBundleId = insertBundle("current");
        firstMatched = insertCandidate();
        secondMatched = insertCandidate();
        unmatched = insertCandidate();
        match(member, firstMatched);
        match(member, secondMatched);
    }

    // ---------- 7.1 요청 ----------

    @Test
    void 새_작업은_대기_상태로_만들어지고_계산을_시작시킨다() {
        JobAccepted accepted = request(member, firstMatched);

        assertFalse(accepted.cacheHit());
        assertEquals(ResidualJobStore.QUEUED, accepted.status());
        assertTrue(accepted.jobId().startsWith("rj-"));
        assertEquals(2, accepted.pollAfterSeconds(), "폴링 간격은 서버가 정한다(D-3)");
        assertNull(accepted.resultCurveContext(), "아직 쓸 수 있는 결과가 없다");
        assertEquals(1, runner.started.size());
        assertEquals(accepted.jobId(), runner.started.getFirst().jobId());
    }

    /** 완료 조건: 같은 키 동시 요청은 계산을 공유한다. 응답을 잃고 다시 보내도 같은 작업이다. */
    @Test
    void 같은_목표를_다시_요청하면_진행_중인_작업을_그대로_준다() {
        JobAccepted first = request(member, firstMatched);

        JobAccepted again = request(member, firstMatched);

        assertEquals(first.jobId(), again.jobId());
        assertFalse(again.cacheHit());
        assertEquals(1, runner.started.size(), "같은 키로 계산을 두 번 시작시키지 않는다");
    }

    /** 완료 조건: 제거 집합의 순서 차이만으로 작업이 늘지 않는다. */
    @Test
    void 제거_순서가_달라도_같은_작업이다() {
        JobAccepted first = request(member, List.of(firstMatched, secondMatched));

        JobAccepted reversed = request(member, List.of(secondMatched, firstMatched));

        assertEquals(first.jobId(), reversed.jobId());
        assertEquals(1, runner.started.size());
    }

    @Test
    void 계산이_끝난_목표는_작업을_만들지_않고_캐시로_답한다() {
        JobAccepted accepted = request(member, firstMatched);
        complete(accepted.jobId());

        JobAccepted cached = request(member, firstMatched);

        assertTrue(cached.cacheHit());
        assertEquals(ResidualJobStore.COMPLETED, cached.status());
        assertNull(cached.jobId(), "캐시에는 기다릴 작업이 없다");
        assertEquals(List.of("c-" + firstMatched), cached.resultCurveContext().removedCandidateIds());
        assertEquals(1, runner.started.size());
    }

    /** D-4. 같은 회원의 다른 작업이 돌고 있으면 기다리라고 하지 않고 그 작업을 알려 준다. */
    @Test
    void 회원당_한_작업_상한에_걸리면_돌고_있는_작업을_알려_준다() {
        JobAccepted mine = request(member, firstMatched);

        BusinessException refused = assertThrows(BusinessException.class,
                () -> request(member, secondMatched));

        assertEquals(ErrorCode.RESIDUAL_QUEUE_FULL, refused.getErrorCode());
        assertEquals(mine.jobId(), refused.getDetails().get("activeJobId"));
        assertEquals(7, refused.getDetails().get("retryAfterSeconds"));
    }

    @Test
    void 전체_자리가_차면_대기_시간만_알려_준다() {
        // 자리를 채우는 두 작업은 서로 다른 목표여야 한다. 같은 목표면 병합돼 자리를 쓰지 않는다.
        request(member, firstMatched);
        match(stranger, secondMatched);
        request(stranger, secondMatched);
        long third = insertMember();
        unlock(third, ticId);
        long thirdTarget = insertCandidate();
        match(third, thirdTarget);

        BusinessException refused = assertThrows(BusinessException.class, () -> request(third, thirdTarget));

        assertEquals(ErrorCode.RESIDUAL_QUEUE_FULL, refused.getErrorCode());
        assertEquals(7, refused.getDetails().get("retryAfterSeconds"));
        assertFalse(refused.getDetails().containsKey("activeJobId"),
                "내 작업이 도는 것이 아니라 자리가 없는 것이다");
    }

    // ---------- 검증과 권한 ----------

    @Test
    void 목표_검증은_곡선_조회와_같은_규칙이다() {
        assertField(() -> request(member, List.of(unmatched)), "target.removedCandidateIds");
        assertField(() -> request(member, List.of()), "target.removedCandidateIds");
        assertField(() -> jobs.request(member, ticId,
                new JobRequest(new TargetRequest("2", List.of("c-" + firstMatched), "rm-1", "pg-1"))),
                "target.bundleId");
        assertField(() -> jobs.request(member, ticId, null), "target");

        BusinessException changed = assertThrows(BusinessException.class, () -> jobs.request(member, ticId,
                new JobRequest(new TargetRequest("b-" + archivedBundleId, List.of("c-" + firstMatched),
                        "rm-1", "pg-1"))));
        assertEquals(ErrorCode.BUNDLE_CHANGED, changed.getErrorCode());
        assertEquals("b-" + currentBundleId, changed.getDetails().get("currentBundleId"));
    }

    @Test
    void 발견하지_않은_별과_미공개_별은_계산을_요청할_수_없다() {
        long otherStar = insertStar("published");
        BusinessException locked = assertThrows(BusinessException.class,
                () -> jobs.request(member, otherStar, target(List.of(firstMatched), currentBundleId)));
        assertEquals(ErrorCode.STAR_LOCKED, locked.getErrorCode());

        long hidden = insertStar("hidden");
        unlock(member, hidden);
        BusinessException notPublished = assertThrows(BusinessException.class,
                () -> jobs.request(member, hidden, target(List.of(firstMatched), currentBundleId)));
        assertEquals(ErrorCode.STAR_NOT_PUBLISHED, notPublished.getErrorCode());
    }

    // ---------- 7.2 조회 ----------

    @Test
    void 상태_조회는_단계와_시각을_주고_완료에만_결과_문맥을_준다() {
        String jobId = request(member, firstMatched).jobId();

        store.advance(jobId, 1, ResidualJobStore.RESIDUAL_CALCULATING);
        JobStatus calculating = status(member, jobId);
        assertEquals(ResidualJobStore.RESIDUAL_CALCULATING, calculating.status());
        assertEquals(1, calculating.attempt());
        assertNotNull(calculating.timeline().queuedAt());
        assertNotNull(calculating.timeline().residualStartedAt());
        assertNull(calculating.timeline().completedAt());
        assertNull(calculating.resultCurveContext(), "계산이 끝나기 전에는 바꿀 문맥을 주지 않는다");
        assertEquals(String.valueOf(ticId), calculating.ticId());
        assertEquals(2, calculating.pollAfterSeconds());
        assertEquals(0, calculating.queuePosition(), "계산 중이면 0이다. 7.1 응답과 같은 뜻이다");

        store.advance(jobId, 1, ResidualJobStore.RESIDUAL_READY);
        store.advance(jobId, 1, ResidualJobStore.PERIODOGRAM_CALCULATING);
        complete(jobId);

        JobStatus completed = status(member, jobId);
        assertEquals(ResidualJobStore.COMPLETED, completed.status());
        assertNotNull(completed.timeline().completedAt());
        assertEquals(completed.target(), completed.resultCurveContext(), "이 문맥으로 곡선을 조회한다");
        assertNull(completed.failure());
        assertNull(completed.queuePosition(), "줄이 끝났는데 0번째라고 말하지 않는다");
    }

    /** AT-101. 실패는 마지막 정상 곡선을 남기고 사유를 알린다. */
    @Test
    void 실패한_작업은_사유를_주고_같은_목표로_다시_요청할_수_있다() {
        String jobId = request(member, firstMatched).jobId();
        store.advance(jobId, 1, ResidualJobStore.RESIDUAL_CALCULATING);
        store.fail(jobId, 1, new ResidualJobStore.Failure("RESIDUAL", "COMPUTE_ERROR", "계산에 실패했습니다.", true));

        JobStatus failed = status(member, jobId);
        assertEquals(ResidualJobStore.FAILED, failed.status());
        assertEquals("RESIDUAL", failed.failure().stage());
        assertTrue(failed.failure().retryable());
        assertNull(failed.resultCurveContext());

        assertNull(failed.queuePosition());

        JobAccepted retried = request(member, firstMatched);
        assertNotEquals(jobId, retried.jobId(), "끝난 작업에 붙이지 않고 새로 시작한다");
        assertEquals(1, status(member, retried.jobId()).attempt(),
                "새 작업이라 시도 번호도 1이다. 화면은 응답의 새 jobId로 갈아탄다");
    }

    /** 같은 목표를 요청한 사람은 같은 작업을 기다린다. 만든 사람만 볼 수 있으면 폴링이 404가 된다. */
    @Test
    void 같은_목표로_병합된_회원도_상태를_볼_수_있다() {
        match(stranger, firstMatched);
        String jobId = request(member, firstMatched).jobId();

        JobAccepted merged = request(stranger, firstMatched);

        assertEquals(jobId, merged.jobId());
        assertEquals(jobId, status(stranger, jobId).jobId());
        assertEquals(jobId, status(member, jobId).jobId());
    }

    /**
     * D-5. 조회는 판을 보지 않아 409를 내지 않으므로, 계산이 도는 동안 판 교체를 알 수 있는 곳이
     * 이 헤더뿐이다. 작업이 들고 있는 판이 아니라 <b>지금</b> 판이어야 값이 달라진다.
     */
    @Test
    void 조회_응답은_작업의_판이_아니라_지금_판을_알려_준다() {
        String jobId = request(member, firstMatched).jobId();
        assertEquals("b-" + currentBundleId, jobs.status(member, jobId).currentBundleId());

        jdbc.update("UPDATE publication_bundles SET status = 'archived' WHERE id = ?", currentBundleId);
        long replaced = insertBundle("current");

        assertEquals("b-" + replaced, jobs.status(member, jobId).currentBundleId(),
                "화면은 이 값이 진입 때 받은 판과 다르면 5.1절을 다시 조회한다");
        assertEquals("b-" + currentBundleId, status(member, jobId).target().bundleId(),
                "작업이 무엇을 계산 중인지는 그대로다");
    }

    /**
     * 등록만 해 두고 시작하지 못하면 아무도 진행시키지 않는 작업이 남는다. 같은 목표의 재요청은 그
     * 작업에 병합돼 실행기를 다시 부르지 않으므로 화면이 만료까지 기다리게 된다.
     */
    @Test
    void 계산을_시작하지_못하면_기다리는_작업을_남기지_않는다() {
        runner.failure = new IllegalStateException("워커 제출 실패");

        BusinessException refused = assertThrows(BusinessException.class, () -> request(member, firstMatched));

        assertEquals(ErrorCode.DEPENDENCY_UNAVAILABLE, refused.getErrorCode());
        assertEquals(ErrorCode.DEPENDENCY_UNAVAILABLE.getDefaultMessage(), refused.getMessage(),
                "실행기 예외를 사용자에게 보여 주지 않는다");
        assertEquals(1, runner.started.size());

        ResidualJobStore.Job orphan = store.find(runner.started.getFirst().jobId()).orElseThrow();
        assertEquals(ResidualJobStore.FAILED, orphan.status());
        assertTrue(orphan.failure().retryable());
        assertTrue(store.active(orphan.cacheKey()).isEmpty(), "병합 대상으로 남으면 재요청이 시작을 못 한다");

        runner.failure = null;
        JobAccepted retried = request(member, firstMatched);

        assertNotEquals(orphan.jobId(), retried.jobId(), "끝난 작업에 붙이지 않고 새로 시작한다");
        assertEquals(2, runner.started.size());
    }

    /** 2.1절. 서버가 정렬·중복 제거하므로 같은 후보를 두 번 보내도 한 번 보낸 것과 같은 목표다. */
    @Test
    void 같은_후보를_중복해_보내도_같은_작업이다() {
        JobAccepted once = request(member, firstMatched);

        JobAccepted twice = request(member, List.of(firstMatched, firstMatched));

        assertEquals(once.jobId(), twice.jobId());
        assertEquals(1, runner.started.size(), "중복 때문에 계산이 하나 더 돌지 않는다");
    }

    /** 순번은 폴링마다 다시 센다. 202에만 주면 화면에서 한 번 떴다 사라진다. */
    @Test
    void 앞_작업이_끝나면_대기_순번이_줄어든다() {
        match(stranger, secondMatched);
        String running = request(member, firstMatched).jobId();
        String waiting = request(stranger, secondMatched).jobId();

        assertEquals(1, status(stranger, waiting).queuePosition(), "앞에 하나가 기다린다");

        complete(running);

        assertEquals(0, status(stranger, waiting).queuePosition(), "앞이 비었으니 이제 이 작업 차례다");
    }

    /** 캐시 확인과 등록이 갈라지면 이미 있는 결과를 두고 작업이 하나 더 생긴다. */
    @Test
    void 등록_직전에_계산이_끝나도_작업을_만들지_않는다() {
        String jobId = request(member, firstMatched).jobId();
        AnalysisViews.CurveContext target = contextOf(List.of(firstMatched));
        complete(jobId);

        // 호출자가 밖에서 캐시를 본 뒤 여기 오는 사이에 끝난 상황이다. 저장소가 한 자물쇠 안에서 다시 본다.
        ResidualJobStore.Enqueued again =
                store.enqueue(stranger, ticId, target, ResidualJobStore.cacheKey(ticId, target));

        assertInstanceOf(ResidualJobStore.Enqueued.Cached.class, again);
        assertEquals(1, runner.started.size(), "이미 있는 결과로 계산을 다시 시작하지 않는다");
    }

    @Test
    void 남의_작업과_없는_작업은_같은_404다() {
        String jobId = request(member, firstMatched).jobId();

        for (String requested : new String[] {jobId, "rj-999999", "abc", "rj-0"}) {
            long viewer = requested.equals(jobId) ? stranger : member;
            BusinessException missing = assertThrows(BusinessException.class, () -> status(viewer, requested));
            assertEquals(ErrorCode.RESOURCE_NOT_FOUND, missing.getErrorCode(), requested);
        }
    }

    // ---------- 조회 연동 (5.1·5.2·5.3) ----------

    @Test
    void 곡선_조회는_진행_중에는_작업을_보여_주고_완료되면_결과를_읽는다() {
        AnalysisViews.CurveContext context = contextOf(List.of(firstMatched));

        assertNull(residuals.lookup(ticId, context).status(), "요청 전에는 결과도 작업도 없다(D-14)");

        String jobId = request(member, firstMatched).jobId();
        ResidualResultReader.Lookup running = residuals.lookup(ticId, context);
        assertEquals(ResidualJobStore.QUEUED, running.status());
        assertEquals(jobId, running.jobId());
        assertFalse(running.completed());

        complete(jobId);
        ResidualResultReader.Lookup done = residuals.lookup(ticId, context);
        assertTrue(done.completed());
        assertNull(done.jobId(), "결과가 있으면 기다릴 작업이 없다");
        assertArrayEquals(new Float[] {0.5f, 0.6f}, done.segmentFlux().get(segmentId));
        assertNotNull(done.computedAt());
    }

    // ---------- 도우미 ----------

    private JobAccepted request(long viewer, long candidateId) {
        return request(viewer, List.of(candidateId));
    }

    private JobAccepted request(long viewer, List<Long> removed) {
        return jobs.request(viewer, ticId, target(removed, currentBundleId)).body();
    }

    private JobStatus status(long viewer, String jobId) {
        return jobs.status(viewer, jobId).body();
    }

    private JobRequest target(List<Long> removed, long bundleId) {
        return new JobRequest(new TargetRequest("b-" + bundleId,
                removed.stream().map(id -> "c-" + id).toList(), "rm-1", "pg-1"));
    }

    private AnalysisViews.CurveContext contextOf(List<Long> removed) {
        List<String> ids = removed.stream().sorted().map(id -> "c-" + id).toList();
        return new AnalysisViews.CurveContext("b-" + currentBundleId, ids.size(), ids, "rm-1", "pg-1");
    }

    private void complete(String jobId) {
        store.complete(jobId, 1, new ResidualJobStore.Result(OffsetDateTime.now(),
                Map.of(segmentId, new Float[] {0.5f, 0.6f}), new Float[] {0.01f, 0.02f, 0.03f}));
    }

    private static void assertField(Runnable call, String field) {
        BusinessException thrown = assertThrows(BusinessException.class, call::run, field);
        assertEquals(ErrorCode.VALIDATION_FAILED, thrown.getErrorCode(), field);
        assertTrue(thrown.getFieldErrors().stream().anyMatch(error -> error.field().equals(field)),
                field + "를 가리켜야 한다: " + thrown.getFieldErrors());
    }

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long insertStar(String serviceStatus) {
        long id = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, tmag, confirmed_count, service_status) VALUES (?, 9.8, 0, ?)",
                id, serviceStatus);
        return id;
    }

    private void unlock(long viewer, long star) {
        int ordinal = jdbc.queryForObject("SELECT COALESCE(MAX(layout_ordinal) + 1, 0) FROM star_unlocks"
                + " WHERE user_id = ?", Integer.class, viewer);
        var position = layout.place(ordinal);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                viewer, star, position.depthZ(), position.worldX(), position.worldY(),
                position.layoutVersion(), ordinal);
    }

    private long insertSegment(long star, int sector) {
        return jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd,"
                        + " bin_minutes, n_points, flux, gaps)"
                        + " VALUES (?, ?, '10m-v1', 1683.35, 10, 2, ?, '[]'::jsonb) RETURNING id",
                Long.class, star, sector, new Float[] {1.0f, 0.999f});
    }

    private long insertBundle(String status) {
        String manifest = """
                {"segment_ids": [%d], "array_checksums": {},
                 "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
                 "binning": {"minutes": 10}, "period_grid": {"spacing": "log"},
                 "fine_tune": {"half_width_cells": 3}, "curve_steps": {}}
                """.formatted(segmentId);
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, ?, ?::jsonb, 1683.4231, 81.4) RETURNING id",
                Long.class, ticId, "pv1-" + UUID.randomUUID(), status, manifest);
    }

    private long insertCandidate() {
        return jdbc.queryForObject("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step,"
                        + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,"
                        + " discoverable, is_confirmed)"
                        + " VALUES (?, 'active', ?, 1, 3.0, 1684.0, 2.0, 900, 10.0, '{}'::jsonb, true, false)"
                        + " RETURNING id", Long.class, ticId, currentBundleId);
    }

    /** 제거하려면 그 후보를 매칭한 제출이 있어야 한다(7.1절 검증). */
    private void match(long viewer, long candidateId) {
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.0, 0.1, 0.2, 1683.4231,"
                        + " 'LIKELY_PLANET', '[]'::jsonb, 'matched', ?, 'recognized', 'rm-1', 'pg-1', 'rule-0')",
                viewer, ticId, currentBundleId, UUID.randomUUID().toString(), candidateId);
    }
}
