package com.planetory.backend.domain.exploration.service;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 제출 조회·요청 ID 복구·상세 보기·다시 풀기 초안 (탐사 API 6.6·6.7·6.8절) [S15P21C206-145].
 *
 * <p>실제 제출을 만들고 조회한다. 외부 잔차 공급자만 대체하고 HTTP·DB·보안 필터는 실제로 실행한다.
 */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class SubmissionLookupTest {

    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");

    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", DB::getUsername);
        r.add("spring.datasource.password", DB::getPassword);
    }

    @Autowired SubmissionLookupService lookup;
    @Autowired SubmissionService submissions;
    @Autowired HistoryService histories;
    @Autowired JdbcTemplate jdbc;
    @Autowired GalaxyLayout layout;
    @Autowired MockMvc mvc;
    @Autowired DataSource dataSource;
    @MockitoBean ResidualResultReader residuals;

    long member, stranger, tic, bundle, segment, candidate;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @BeforeEach
    void seed() {
        when(residuals.lookup(anyLong(), any())).thenReturn(ResidualResultReader.Lookup.none());
        member = member();
        stranger = member();
        tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000) + 1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')", tic);
        unlock(member);
        unlock(stranger);
        Float[] flux = new Float[4320];
        Arrays.fill(flux, 1f);
        segment = jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id,sector,binning_revision,start_btjd,"
                        + "bin_minutes,n_points,flux,gaps) VALUES (?,1,'10m-v1',100,10,?,?,'[]') RETURNING id",
                Long.class, tic, flux.length, flux);
        String manifest = """
                {"segment_ids":[%d],"array_checksums":{},"residual_model_version":"rm-1",
                "periodogram_config_version":"pg-1","binning":{"minutes":10},"period_grid":{"spacing":"log"},
                "fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """.formatted(segment);
        bundle = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,"
                        + "fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",
                Long.class, tic, "lookup-" + UUID.randomUUID(), manifest);
        jdbc.update("INSERT INTO periodograms(bundle_id,period_min_days,period_max_days,n_periods,power) "
                + "VALUES (?,0.5,20,3,?)", bundle, new Float[] {1f, 2f, 1f});
        candidate = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,"
                        + "period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,"
                        + "is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",
                Long.class, tic, bundle);
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,"
                + "rule_version,applied_at,source_refs) VALUES (?,'pc','analysis',NULL,'rule-0',now(),'[]')", candidate);
    }

    // ---------- 6.6 제출 조회 ----------

    /** 완료 조건 (5). 당시 판정은 그대로 두고 진행·공개·통계만 조회 시점으로 다시 만든다. */
    @Test
    void 당시_값은_그대로_두고_조회_시점_값만_다시_만든다() {
        var accepted = submit(3, "LIKELY_PLANET");
        String submissionId = accepted.path("submissionId").asText();
        var first = lookup.byId(member, submissionId).body();

        assertEquals("UNPUBLISHED", first.publication().state());
        assertEquals("pending_publish", first.achievement().result(), "미확정 신호는 공개해야 성과가 된다");
        assertEquals(0, first.achievement().star().count(), "아직 인정된 성과가 없다");

        // 판정이 바뀌어도 당시 값은 그대로다. 성과는 조회 시점 값이라 따라 움직인다.
        jdbc.update("UPDATE candidate_dispositions SET disposition='confirmed',answer_class='graded',"
                + "planet_truth='planet' WHERE candidate_id=?", candidate);

        var again = lookup.byId(member, submissionId).body();

        assertEquals(first.judgment(), again.judgment(), "당시 판단은 다시 매기지 않는다");
        assertEquals(first.match(), again.match(), "당시 매칭도 그대로다");
        assertEquals(first.original(), again.original());
        assertEquals(first.achievement().result(), again.achievement().result());
        assertEquals("UNPUBLISHED", again.publication().state(), "제출 당시 미확정이면 공개 자격이 남는다");
    }

    /** 6.6은 8.2와 같은 본문이다. 두 경로가 다른 말을 하면 같은 제출이 화면마다 달라진다. */
    @Test
    void 제출_조회와_기록_상세가_같은_본문을_준다() {
        var accepted = submit(3, "LIKELY_PLANET");

        var bySubmission = lookup.byId(member, accepted.path("submissionId").asText()).body();
        var byHistory = histories.detail(member, accepted.path("historyId").asText()).submission();

        assertEquals(stable(byHistory), stable(bySubmission));
    }

    @Test
    void 타인_제출은_403이고_없는_제출은_404다() {
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        error(ErrorCode.FORBIDDEN, () -> lookup.byId(stranger, submissionId));
        for (String requested : new String[] {"sub-999999999", "abc", "sub-01", "7002"}) {
            error(ErrorCode.RESOURCE_NOT_FOUND, () -> lookup.byId(member, requested));
        }
    }

    // ---------- 6.6 요청 ID 복구 ----------

    @Test
    void 접수된_요청은_같은_본문으로_복구된다() {
        String requestId = UUID.randomUUID().toString();
        var accepted = submit(requestId, 3, "LIKELY_PLANET");

        var recovered = lookup.byRequest(member, requestId).body();

        assertEquals(accepted.path("submissionId").asText(), recovered.submissionId());
        assertEquals(stable(lookup.byId(member, recovered.submissionId()).body()), stable(recovered));
    }

    /** 미접수와 처리 중을 가른다. 합치면 처리 중인 제출에 같은 ID를 또 보내게 된다. */
    @Test
    void 미접수는_404이고_처리_중은_409다() throws Exception {
        String pending = UUID.randomUUID().toString();

        error(ErrorCode.RESOURCE_NOT_FOUND, () -> lookup.byRequest(member, pending));

        // 6.1절이 쓰는 같은 권고 잠금을 다른 세션이 들고 있는 상태를 만든다.
        UUID id = UUID.fromString(pending);
        try (Connection holder = dataSource.getConnection()) {
            holder.setAutoCommit(false);
            try (PreparedStatement st = holder.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {
                st.setLong(1, id.getMostSignificantBits() ^ id.getLeastSignificantBits());
                st.executeQuery().close();
            }
            error(ErrorCode.REQUEST_IN_PROGRESS, () -> lookup.byRequest(member, pending));
            holder.rollback();
        }

        error(ErrorCode.RESOURCE_NOT_FOUND, () -> lookup.byRequest(member, pending));
    }

    /** 이미 접수된 요청을 조회하면서 잠그면, 응답을 잃은 화면의 재전송이 그동안 막힌다. */
    @Test
    void 접수된_요청_조회는_재전송을_막지_않는다() {
        String requestId = UUID.randomUUID().toString();
        submit(requestId, 3, "LIKELY_PLANET");

        lookup.byRequest(member, requestId);

        var replayed = submissions.submit(member, tic, request(requestId, 3, "LIKELY_PLANET"));
        assertTrue(replayed.replay(), "조회가 잠금을 남겼다면 여기서 REQUEST_IN_PROGRESS가 난다");
    }

    @Test
    void 요청_ID_형식이_아니면_400이다() {
        BusinessException refused = assertThrows(BusinessException.class,
                () -> lookup.byRequest(member, "not-a-uuid"));

        assertEquals(ErrorCode.VALIDATION_FAILED, refused.getErrorCode());
        assertEquals("requestId", refused.getFieldErrors().getFirst().field());
    }

    // ---------- 6.7 상세 보기 ----------

    /** 판단이 달랐던 제출은 그 제출이 매칭한 신호를 연다. */
    @Test
    void 판단이_달랐던_제출은_매칭한_신호를_보여_준다() {
        graded("confirmed", "planet");
        String submissionId = submit(3, "UNLIKELY_PLANET").path("submissionId").asText();

        var view = lookup.detailView(member, submissionId);

        assertEquals("CURRENT_MATCH", view.targetKind());
        assertTrue(view.answerViewed());
        assertEquals("c-" + candidate, view.signal().get("candidateId"));
        assertEquals(Boolean.FALSE, view.userJudgmentAgrees(), "당시 판단이 신호 판정과 달랐다");
        assertTrue(viewed(submissionId));
    }

    /**
     * RES-09. 힌트는 <b>그 제출의</b> 제거 집합만 본다. 회원이 이미 매칭한 후보도 빼지 않는다 —
     * 누적으로 세면 뒤의 제출이 옛 제출의 힌트를 바꾼다.
     */
    @Test
    void 힌트는_누적_매칭이_아니라_그_제출_단계를_본다() {
        jdbc.update("UPDATE candidates SET bls_power=50 WHERE id=?", candidate);
        long weaker = candidate(7, 10);

        submit(3, "LIKELY_PLANET");
        String unmatched = submit(13, "LIKELY_PLANET").path("submissionId").asText();

        var view = lookup.detailView(member, unmatched);

        assertEquals("CURRENT_CURVE_HINT", view.targetKind());
        assertEquals("c-" + candidate, view.signal().get("candidateId"),
                "이미 매칭한 후보라도 세기가 가장 크면 힌트다");
        assertNull(view.userJudgmentAgrees(), "힌트는 당시 판단을 채점한 대상이 아니다");
        assertNotEquals("c-" + weaker, view.signal().get("candidateId"));
    }

    /** 맞힌 제출에는 열어 볼 상세가 없다. 본 것으로 적으면 건너뛰기 조건이 잘못 열린다. */
    @Test
    void 볼_대상이_없으면_409이고_조회_표시도_켜지_않는다() {
        graded("confirmed", "planet");
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        error(ErrorCode.DETAIL_UNAVAILABLE, () -> lookup.detailView(member, submissionId));

        assertFalse(viewed(submissionId));
    }

    @Test
    void 상세_보기는_반복해도_같은_대상이다() {
        graded("fp", "not_planet");
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        var first = lookup.detailView(member, submissionId);
        var again = lookup.detailView(member, submissionId);

        assertEquals(first.targetKind(), again.targetKind());
        assertEquals(first.signal().get("candidateId"), again.signal().get("candidateId"));
        assertEquals(first.userJudgmentAgrees(), again.userJudgmentAgrees());
    }

    @Test
    void 상세_보기도_타인_제출은_403이고_없는_제출은_404다() {
        graded("fp", "not_planet");
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        error(ErrorCode.FORBIDDEN, () -> lookup.detailView(stranger, submissionId));
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> lookup.detailView(member, "sub-999999999"));
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> lookup.detailView(member, "abc"));
        assertFalse(viewed(submissionId), "실패한 요청은 조회 표시를 남기지 않는다");
    }

    @Test
    void 상세_보기_HTTP는_튜토리얼_상태를_함께_준다() throws Exception {
        graded("fp", "not_planet");
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        mvc.perform(post("/api/v1/submissions/" + submissionId + "/detail-view")
                        .session(session(member)).with(csrf()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.submissionId").value(submissionId))
                .andExpect(jsonPath("$.answerViewed").value(true))
                .andExpect(jsonPath("$.targetKind").value("CURRENT_MATCH"))
                .andExpect(jsonPath("$.signal.candidateId").value("c-" + candidate))
                .andExpect(jsonPath("$.tutorial.skipAvailable").value(false));
    }

    /**
     * 6.7절 「반복 호출은 같은 대상」. 매번 현재 후보에서 다시 고르면 판이 갱신될 때 같은 제출의
     * 답이 달라진다.
     */
    @Test
    void 후보가_갱신돼도_힌트_대상은_처음_고른_신호다() {
        long weaker = candidate(7, 5);
        String unmatched = submit(13, "LIKELY_PLANET").path("submissionId").asText();

        var first = lookup.detailView(member, unmatched);
        assertEquals("c-" + candidate, first.signal().get("candidateId"), "세기가 큰 쪽을 고른다");

        // 다른 후보의 세기를 올린다. 다시 고르면 대상이 이쪽으로 바뀐다.
        jdbc.update("UPDATE candidates SET bls_power=99 WHERE id=?", weaker);

        var again = lookup.detailView(member, unmatched);

        assertEquals("c-" + candidate, again.signal().get("candidateId"), "한 번 정한 대상은 바꾸지 않는다");
        assertEquals(candidate, jdbc.queryForObject("SELECT detail_target_candidate_id FROM submissions "
                + "WHERE id=?", Long.class, Long.parseLong(unmatched.substring(4))));
    }

    /** 한 번 보여 준 신호가 은퇴했다고 없던 일이 되지는 않는다. */
    @Test
    void 처음_고른_힌트가_은퇴해도_같은_신호를_보여_준다() {
        candidate(7, 5);
        String unmatched = submit(13, "LIKELY_PLANET").path("submissionId").asText();
        var first = lookup.detailView(member, unmatched);

        jdbc.update("UPDATE candidates SET status='retired' WHERE id=?", candidate);

        assertEquals(first.signal().get("candidateId"),
                lookup.detailView(member, unmatched).signal().get("candidateId"));
    }

    /**
     * 6.7절 signal에는 해설 자리가 있다. 저장할 열도 생성 규칙도 없어 값은 null이지만, <b>키를 빼면</b>
     * 소비자가 「해설 없음」과 「모르는 응답」을 구분하지 못한다.
     */
    @Test
    void 상세_보기_signal에는_해설_자리가_있다() throws Exception {
        graded("fp", "not_planet");
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        assertTrue(lookup.detailView(member, submissionId).signal().containsKey("explanation"));
        assertNull(lookup.detailView(member, submissionId).signal().get("explanation"));

        mvc.perform(post("/api/v1/submissions/" + submissionId + "/detail-view")
                        .session(session(member)).with(csrf()))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("\"explanation\":null")));
    }

    // ---------- 6.8 다시 풀기 초안 ----------

    /**
     * AT-118. 기준 시각이 100에서 101로 바뀌면 저장된 0.20~0.30이 0.95~1.05로 복원된다.
     * 저장값을 그대로 복사하면 창이 통과에서 벗어난다.
     */
    @Test
    void 위상은_현재_판_기준_시각으로_다시_만든다() {
        // 주기 4일, 창 0.20~0.30 → 기준 시각 100에서 epoch 101.0, 지속 9.6시간이다.
        String submissionId = submit(4, 0.20, 0.30).path("submissionId").asText();
        var before = lookup.retryDraft(member, submissionId);
        assertEquals(0.20, before.draft().phaseStart(), 1e-9);
        assertEquals(0.30, before.draft().phaseEnd(), 1e-9);

        replaceBundle(101);

        var after = lookup.retryDraft(member, submissionId);

        assertEquals(0.95, after.draft().phaseStart(), 1e-9, "저장값을 복사하지 않는다");
        assertEquals(1.05, after.draft().phaseEnd(), 1e-9, "경계를 넘는 창은 이어진 값으로 준다");
        assertEquals(4.0, after.draft().periodDays(), 1e-9, "고른 주기는 그대로다");
        assertTrue(after.isPreviousBundle());
    }

    /** 다시 푸는 것이지 옛 답을 다시 내는 것이 아니다. */
    @Test
    void 초안은_판단과_근거와_메모를_비운다() {
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        var draft = lookup.retryDraft(member, submissionId).draft();

        assertNull(draft.userJudgment());
        assertTrue(draft.evidenceChecks().isEmpty());
        assertNull(draft.memo());
        assertNotNull(draft.viewState(), "보던 화면은 그대로 연다");
        assertEquals(10.0, draft.viewState().periodogramViewport().maxDays(), 1e-9);
    }

    /** C02-R1. 제거한 후보가 은퇴하면 단계를 되살리지 못하고 현재 진행 문맥으로 바꾼다. */
    @Test
    void 제거_후보가_은퇴하면_현재_진행_문맥으로_바꾸고_알린다() {
        long second = candidate(7, 5);
        submit(3, "LIKELY_PLANET");
        Float[] residual = new Float[4320];
        Arrays.fill(residual, 0.9f);
        when(residuals.lookup(anyLong(), any())).thenReturn(new ResidualResultReader.Lookup(
                "COMPLETED", null, java.time.OffsetDateTime.now(), java.util.Map.of(segment, residual), null));
        String step1 = submissions.submit(member, tic, step(7, List.of("c-" + candidate)))
                .body().path("submissionId").asText();

        var restored = lookup.retryDraft(member, step1);
        assertTrue(restored.restored().step(), "아직은 그대로 되살린다");
        assertNull(restored.restored().notice());
        assertEquals(List.of("c-" + candidate), restored.curveContext().removedCandidateIds());

        jdbc.update("UPDATE candidates SET status='retired' WHERE id=?", candidate);

        var replaced = lookup.retryDraft(member, step1);

        assertFalse(replaced.restored().step());
        assertEquals("STEP_NOT_RESTORABLE", replaced.restored().notice());
        assertEquals(List.of("c-" + second), replaced.curveContext().removedCandidateIds(),
                "은퇴한 후보 대신 지금 매칭한 후보로 선다");
        assertEquals(1, replaced.curveContext().curveStep());
    }

    @Test
    void 대상_신호가_은퇴했으면_409다() {
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        jdbc.update("UPDATE candidates SET status='retired' WHERE id=?", candidate);

        error(ErrorCode.CANDIDATE_RETIRED, () -> lookup.retryDraft(member, submissionId));
    }

    /** 완료 조건 (4). 초안 조회로 새 행·성과가 생기지 않는다. */
    @Test
    void 초안_조회는_아무것도_저장하지_않는다() {
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();
        int submissionCount = count("submissions");
        int achievementCount = count("user_candidate_achievements");
        int historyCount = count("analysis_histories");

        lookup.retryDraft(member, submissionId);
        lookup.retryDraft(member, submissionId);

        assertEquals(submissionCount, count("submissions"));
        assertEquals(achievementCount, count("user_candidate_achievements"));
        assertEquals(historyCount, count("analysis_histories"));
    }

    @Test
    void 초안_HTTP는_원본_제출과_잔차_상태를_함께_준다() throws Exception {
        String submissionId = submit(3, "LIKELY_PLANET").path("submissionId").asText();

        mvc.perform(get("/api/v1/submissions/" + submissionId + "/retry-draft").session(session(member)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sourceSubmissionId").value(submissionId))
                .andExpect(jsonPath("$.retryOfSubmissionId").value(submissionId))
                .andExpect(jsonPath("$.bundleId").value("b-" + bundle))
                .andExpect(jsonPath("$.isPreviousBundle").value(false))
                .andExpect(jsonPath("$.restored.step").value(true))
                .andExpect(jsonPath("$.curveContext.curveStep").value(0))
                // 원본 단계는 계산할 것이 없어 항상 완료다.
                .andExpect(jsonPath("$.residualForStep.status").value("COMPLETED"));

        mvc.perform(get("/api/v1/submissions/" + submissionId + "/retry-draft").session(session(stranger)))
                .andExpect(status().isForbidden());
    }

    // ---------- HTTP ----------

    @Test
    void 두_조회_모두_지금_판을_헤더로_준다() throws Exception {
        String requestId = UUID.randomUUID().toString();
        var accepted = submit(requestId, 3, "LIKELY_PLANET");
        String submissionId = accepted.path("submissionId").asText();

        mvc.perform(get("/api/v1/submissions/" + submissionId).session(session(member)))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Current-Bundle", "b-" + bundle))
                .andExpect(jsonPath("$.submissionId").value(submissionId))
                .andExpect(jsonPath("$.ticId").value(String.valueOf(tic)));

        mvc.perform(get("/api/v1/submissions/by-request/" + requestId).session(session(member)))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Current-Bundle", "b-" + bundle))
                .andExpect(jsonPath("$.submissionId").value(submissionId));

        mvc.perform(get("/api/v1/submissions/" + submissionId).session(session(stranger)))
                .andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/submissions/by-request/" + UUID.randomUUID()).session(session(member)))
                .andExpect(status().isNotFound());
    }

    // ---------- 도우미 ----------

    private long member() {
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) "
                + "RETURNING id", Long.class, UUID.randomUUID().toString(), UUID.randomUUID().toString());
    }

    private void unlock(long id) {
        var p = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,"
                        + "layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                id, tic, p.depthZ(), p.worldX(), p.worldY(), p.layoutVersion());
    }

    private SubmissionRequest request(String requestId, double period, String judgment) {
        return new SubmissionRequest(requestId, "candidate",
                new SubmissionRequest.Context("b-" + bundle, 0, List.of(), "rm-1", "pg-1"),
                new SubmissionRequest.Selection(period, null, .25 / period, .35 / period), judgment,
                List.of("ushape"), "조회 메모",
                new SubmissionRequest.ViewState(new SubmissionRequest.Viewport(1.0, 10.0), 2.0), null);
    }

    private tools.jackson.databind.JsonNode submit(double period, String judgment) {
        return submit(UUID.randomUUID().toString(), period, judgment);
    }

    private tools.jackson.databind.JsonNode submit(String requestId, double period, String judgment) {
        return submissions.submit(member, tic, request(requestId, period, judgment)).body();
    }

    private MockHttpSession session(long id) {
        var session = new MockHttpSession();
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(id), null, "ROLE_USER"));
        session.setAttribute("SPRING_SECURITY_CONTEXT", context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()
                + ".lastActivity", java.time.Instant.now());
        return session;
    }

    /**
     * 판단 통계에는 집계 시각({@code asOf})이 들어 있어 호출마다 달라진다. 두 경로가 같은 본문을 주는지
     * 보는 비교에서는 그 값만 뺀다. 나머지는 한 글자도 달라지면 안 된다.
     */
    private JsonNode stable(SubmissionViews.Result result) {
        ObjectNode node = (ObjectNode) JSON.valueToTree(result);
        if (node.path("judgmentStatistics").isObject()) {
            ((ObjectNode) node.get("judgmentStatistics")).remove("asOf");
        }
        return node;
    }

    private int count(String table) {
        return jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class);
    }

    /** 현재 판을 기준 시각만 다른 새 판으로 바꾼다. */
    private void replaceBundle(double reference) {
        jdbc.update("UPDATE publication_bundles SET status='archived' WHERE tic_id=? AND status='current'", tic);
        jdbc.update("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,"
                + "fold_reference_time_btjd,base_days) SELECT tic_id,?,'current',manifest,?,base_days "
                + "FROM publication_bundles WHERE id=?", "lookup-" + UUID.randomUUID(), reference, bundle);
    }

    private SubmissionRequest step(double period, List<String> removed) {
        return new SubmissionRequest(UUID.randomUUID().toString(), "candidate",
                new SubmissionRequest.Context("b-" + bundle, removed.size(), removed, "rm-1", "pg-1"),
                new SubmissionRequest.Selection(period, null, .25 / period, .35 / period), "LIKELY_PLANET",
                List.of("ushape"), "조회 메모",
                new SubmissionRequest.ViewState(new SubmissionRequest.Viewport(1.0, 10.0), 2.0), null);
    }

    private tools.jackson.databind.JsonNode submit(double period, double phaseStart, double phaseEnd) {
        var request = new SubmissionRequest(UUID.randomUUID().toString(), "candidate",
                new SubmissionRequest.Context("b-" + bundle, 0, List.of(), "rm-1", "pg-1"),
                new SubmissionRequest.Selection(period, null, phaseStart, phaseEnd), "LIKELY_PLANET",
                List.of("ushape"), "조회 메모",
                new SubmissionRequest.ViewState(new SubmissionRequest.Viewport(1.0, 10.0), 2.0), null);
        return submissions.submit(member, tic, request).body();
    }

    /** 판정을 채점형으로 바꾼다. 제출 시점에 채점되므로 제출 전에 불러야 한다. */
    private void graded(String disposition, String truth) {
        jdbc.update("UPDATE candidate_dispositions SET disposition=?,answer_class='graded',planet_truth=? "
                + "WHERE candidate_id=?", disposition, truth, candidate);
    }

    private long candidate(double period, double blsPower) {
        long id = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,"
                        + "period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,"
                        + "is_confirmed) VALUES (?,'active',?,1,?,100.3,2.4,1000,?,'{}',true,true) RETURNING id",
                Long.class, tic, bundle, period, blsPower);
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,"
                + "rule_version,applied_at,source_refs) VALUES (?,'pc','analysis',NULL,'rule-0',now(),'[]')", id);
        return id;
    }

    private boolean viewed(String submissionId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT answer_viewed FROM submissions WHERE id=?",
                Boolean.class, Long.parseLong(submissionId.substring(4))));
    }

    private void error(ErrorCode expected, Runnable action) {
        assertEquals(expected, assertThrows(BusinessException.class, action::run).getErrorCode());
    }
}
