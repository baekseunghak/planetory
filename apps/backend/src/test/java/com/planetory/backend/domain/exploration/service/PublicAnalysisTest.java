package com.planetory.backend.domain.exploration.service;

import java.util.Arrays;
import java.util.List;
import java.util.UUID;
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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import com.planetory.backend.domain.post.service.PublicAnalysisService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 실제 제출 픽스처와 패키지 내부 잔차 공급자를 사용하므로 탐사 테스트 패키지에 둔다. 공개 HTTP·DB·성과는 실제 구현이다. */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class PublicAnalysisTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", DB::getUsername);
        r.add("spring.datasource.password", DB::getPassword);
    }
    @Autowired HistoryService histories;
    @Autowired SubmissionService submissions;
    @Autowired JdbcTemplate jdbc;
    @Autowired GalaxyLayout layout;
    @Autowired PlatformTransactionManager transactions;
    @Autowired MockMvc mvc;
    @MockitoBean ResidualResultReader residuals;
    @Autowired PublicAnalysisService publications;
    @MockitoSpyBean StarDiscoveryService discovery;
    long member,tic,bundle,segment,candidate;
    Float[] flux;

    @BeforeEach void seed() {
        when(residuals.lookup(any())).thenReturn(ResidualResultReader.Lookup.none());
        member=member(); tic=Math.abs(UUID.randomUUID().getMostSignificantBits()%900_000_000)+1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",tic);
        var p=layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                member,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')", tic + 1000000000);
        flux=new Float[4320]; Arrays.fill(flux,1f);
        segment=jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id,sector,binning_revision,start_btjd,bin_minutes,n_points,flux,gaps) VALUES (?,1,'10m-v1',100,10,?,?,'[]') RETURNING id",
                Long.class,tic,flux.length,flux);
        String manifest="""
                {"segment_ids":[%d],"array_checksums":{},"residual_model_version":"rm-1",
                "periodogram_config_version":"pg-1","binning":{"minutes":10},"period_grid":{"spacing":"log"},
                "fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """.formatted(segment);
        bundle=jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",
                Long.class,tic,"history-"+UUID.randomUUID(),manifest);
        jdbc.update("INSERT INTO periodograms(bundle_id,period_min_days,period_max_days,n_periods,power) VALUES (?,0.5,20,3,?)",bundle,new Float[]{1f,2f,1f});
        candidate=jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",
                Long.class,tic,bundle);
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,rule_version,applied_at,source_refs) VALUES (?,'pc','analysis',NULL,'rule-0',now(),'[]')",candidate);
    }
    long member() { return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",Long.class,UUID.randomUUID().toString(),UUID.randomUUID().toString()); }
    SubmissionRequest request(double period) {
        return new SubmissionRequest(UUID.randomUUID().toString(),"candidate",new SubmissionRequest.Context("b-"+bundle,0,List.of(),"rm-1","pg-1"),
                new SubmissionRequest.Selection(period,null,.25/period,.35/period),"LIKELY_PLANET",List.of("ushape"),"공개 메모",
                new SubmissionRequest.ViewState(new SubmissionRequest.Viewport(1.0,10.0),2.0),null);
    }
    String submit(double period) { return submissions.submit(member,tic,request(period)).body().path("historyId").asText(); }
    HistoryViews.Query query(String cursor,String size) { return new HistoryViews.Query(null,null,null,null,null,cursor,size); }
    long number(String id) { return Long.parseLong(id.substring(2)); }
    void error(ErrorCode expected,Runnable action) { assertEquals(expected,assertThrows(BusinessException.class,action::run).getErrorCode()); }
    MockHttpSession session(long id) {
        var session=new MockHttpSession(); var context=SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(id),null,"ROLE_USER"));
        session.setAttribute("SPRING_SECURITY_CONTEXT",context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",java.time.Instant.now());
        return session;
    }

    @Test
    void 공식공개한_History의_일반첨부해제는_공개와성과를_변경하지않는다() throws Exception {
        String history = submit(3);
        var published = publications.publish(member, history);
        String created = mvc.perform(post("/api/v1/posts").session(session(member)).with(csrf())
                        .contentType("application/json").content("""
                                {"title":"공개 기록 첨부","body":"본문","purposeTag":"ANALYSIS",
                                 "ticId":"%s","historyIds":["%s"]}
                                """.formatted(tic, history)))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String postId = new tools.jackson.databind.ObjectMapper().readTree(created).path("postId").asText();
        mvc.perform(patch("/api/v1/posts/" + postId).session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyIds\":[]}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.attachments").isEmpty());
        var replay = publications.publish(member, history);
        assertEquals(published.analysisId(), replay.analysisId());
        assertEquals(published.threadId(), replay.threadId());
        assertTrue(replay.isPublic());
        assertTrue(replay.achievementGranted());
        assertFalse(replay.created());
        assertFalse(replay.newlyGranted());
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE"})
    void 세판단_최초공개와_응답유실재시도(String judgment) throws Exception {
        var original = request(3);
        var request = new SubmissionRequest(original.requestId(), original.submissionKind(), original.curveContext(),
                original.selection(), judgment, original.evidenceChecks(), original.memo(), original.viewState(), null);
        String id = submissions.submit(member, tic, request).body().path("historyId").asText();
        String snapshot = jdbc.queryForObject("SELECT response_snapshot::text FROM submissions WHERE id="
                + "(SELECT submission_id FROM analysis_histories WHERE id=?)", String.class, number(id));
        mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"" + id + "\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.created").value(true))
                .andExpect(jsonPath("$.achievementGranted").value(true)).andExpect(jsonPath("$.newlyGranted").value(true))
                .andExpect(jsonPath("$.achievement.star.byType.unconfirmed").value(1))
                .andExpect(jsonPath("$.judgmentSummary.participantCount").value(1));
        var replay = publications.publish(member, id);
        assertFalse(replay.created()); assertFalse(replay.newlyGranted()); assertTrue(replay.achievementGranted());
        assertTrue(replay.achievement().unlockedStars().isEmpty());
        mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"" + id + "\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.newlyGranted").value(false));
        assertEquals(1, count("published_analyses", "history_id", number(id)));
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
        assertEquals(snapshot, jdbc.queryForObject("SELECT response_snapshot::text FROM submissions WHERE id="
                + "(SELECT submission_id FROM analysis_histories WHERE id=?)", String.class, number(id)));
        assertTrue(histories.list(member, query(null, null)).items().getFirst().publication().isPublic());
        assertEquals(0, count("comments", "post_id", Long.parseLong(replay.threadId().substring(3))));
    }

    @Test void duplicate_새기록은_새공개지만_추가성과없음() {
        String first = submit(3);
        var published = publications.publish(member, first);
        String next = submit(3);
        assertEquals("duplicate", histories.detail(member, next).submission().match().status());
        var result = publications.publish(member, next);
        assertTrue(result.created()); assertFalse(result.newlyGranted());
        assertEquals(published.threadId(), result.threadId());
        assertNotEquals(published.analysisId(), result.analysisId());
        assertEquals(2, count("published_analyses", "user_id", member));
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
        assertEquals(1L, result.judgmentSummary().get("participantCount"));
    }

    @Test void 취소숨김재전송은_재공개하거나_성과를다시지급하지않음() {
        String id = submit(3);
        var first = publications.publish(member, id);
        String publishedAt = jdbc.queryForObject("SELECT published_at::text FROM published_analyses WHERE history_id=?", String.class, number(id));
        jdbc.update("UPDATE published_analyses SET unpublished_at=now(), hidden_at=now() WHERE history_id=?", number(id));
        var again = publications.publish(member, id);
        assertEquals(first.analysisId(), again.analysisId()); assertFalse(again.isPublic());
        assertFalse(again.created()); assertFalse(again.newlyGranted()); assertTrue(again.achievementGranted());
        assertEquals(0L, again.judgmentSummary().get("participantCount"));
        assertEquals(publishedAt, jdbc.queryForObject("SELECT published_at::text FROM published_analyses WHERE history_id=?", String.class, number(id)));
        jdbc.update("UPDATE posts SET status='hidden' WHERE candidate_id=?", candidate);
        String next = submit(3);
        error(ErrorCode.THREAD_HIDDEN, () -> publications.publish(member, next));
        assertEquals(1, count("posts", "candidate_id", candidate));
        assertEquals(1, count("published_analyses", "user_id", member));
    }

    @Test void 과거미확정은_재분류와은퇴후에도_당시신호로공개성과인정() {
        String id = submit(3);
        jdbc.update("UPDATE candidate_dispositions SET disposition='confirmed',answer_class='graded',planet_truth='planet' WHERE candidate_id=?", candidate);
        jdbc.update("UPDATE candidates SET status='retired',discoverable=false WHERE id=?", candidate);
        assertEquals("UNPUBLISHED", histories.detail(member, id).submission().publication().state());
        var result = publications.publish(member, id);
        assertTrue(result.newlyGranted());
        assertEquals(1, result.achievement().star().byType().unconfirmed());
        assertEquals(candidate, jdbc.queryForObject("SELECT candidate_id FROM published_analyses WHERE history_id=?", Long.class, number(id)));
    }

    @Test void 타인_미매칭_당시채점형_기록은공개불가() {
        String own = submit(3);
        error(ErrorCode.FORBIDDEN, () -> publications.publish(member(), own));
        String unmatched = submit(7);
        error(ErrorCode.PUBLICATION_NOT_ELIGIBLE, () -> publications.publish(member, unmatched));
        jdbc.update("UPDATE candidate_dispositions SET disposition='fp',answer_class='graded',planet_truth='not_planet' WHERE candidate_id=?", candidate);
        String graded = submit(3);
        jdbc.update("UPDATE candidate_dispositions SET disposition='pc',answer_class='analysis',planet_truth=NULL WHERE candidate_id=?", candidate);
        error(ErrorCode.PUBLICATION_NOT_ELIGIBLE, () -> publications.publish(member, graded));
        assertEquals(0, count("published_analyses", "user_id", member));
    }

    @Test void 같은History_동시공개는_한번만생성() throws Exception {
        String id = submit(3);
        var results = concurrent(() -> publications.publish(member, id), () -> publications.publish(member, id));
        assertEquals(1, results.stream().filter(r -> r.created()).count());
        assertEquals(1, results.stream().filter(r -> r.newlyGranted()).count());
        assertEquals(results.getFirst().analysisId(), results.getLast().analysisId());
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
    }

    @Test void 다른회원_최초공개경합은_공식스레드하나() throws Exception {
        String first = submit(3);
        long other = member();
        var position = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                other, tic, position.depthZ(), position.worldX(), position.worldY(), position.layoutVersion());
        String second = submissions.submit(other, tic, request(3)).body().path("historyId").asText();
        var results = concurrent(() -> publications.publish(member, first), () -> publications.publish(other, second));
        assertEquals(results.getFirst().threadId(), results.getLast().threadId());
        assertTrue(results.stream().allMatch(r -> r.newlyGranted()));
        assertEquals(1, count("posts", "candidate_id", candidate));
        assertEquals(2, count("published_analyses", "candidate_id", candidate));
        assertNull(jdbc.queryForObject("SELECT user_id FROM posts WHERE candidate_id=?", Long.class, candidate));
    }

    @Test void 별저장실패는_이번스레드공개성과전체롤백() {
        String id = submit(3);
        StarDiscoveryService target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(discovery);
        doThrow(new IllegalStateException("별 저장 실패 주입")).when(target).discoverByAchievement(anyLong(), anyLong(), any());
        assertThrows(IllegalStateException.class, () -> publications.publish(member, id));
        assertEquals(0, count("posts", "candidate_id", candidate));
        assertEquals(0, count("published_analyses", "history_id", number(id)));
        assertEquals(0, count("user_candidate_achievements", "user_id", member));
        assertEquals(0, jdbc.queryForObject("SELECT achievement_count FROM user_star_progress WHERE user_id=? AND tic_id=?", Integer.class, member, tic));
        assertEquals(1, count("analysis_histories", "id", number(id)));
        assertEquals(1, count("star_unlocks", "user_id", member));
    }

    @Test void 일반글경로로_공식스레드수정삭제불가() throws Exception {
        var result = publications.publish(member, submit(3));
        String postId = "p-" + result.threadId().substring(3);
        mvc.perform(patch("/api/v1/posts/" + postId).session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"title\":\"변경\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(delete("/api/v1/posts/" + postId).session(session(member)).with(csrf()))
                .andExpect(status().isNotFound());
    }

    @Test void 앱역할로_공개성과저장_성공() {
        String id = submit(3);
        new TransactionTemplate(transactions).executeWithoutResult(status -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            assertTrue(publications.publish(member, id).newlyGranted());
        });
        assertEquals(1, count("published_analyses", "history_id", number(id)));
    }

    @Test void 입력변조와CSRF는_등록전차단() throws Exception {
        String id = submit(3);
        for (String body : List.of("{}", "{\"historyId\":1}", "{\"historyId\":\"" + id + "\",\"userId\":1}", "{\"historyId\":\"h-01\"}")) {
            mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                            .contentType("application/json").content(body)).andExpect(status().isBadRequest());
        }
        mvc.perform(post("/api/v1/public-analyses").session(session(member))
                        .contentType("application/json").content("{\"historyId\":\"" + id + "\"}"))
                .andExpect(status().isForbidden());
        assertEquals(0, count("published_analyses", "user_id", member));
    }

    private int count(String table, String column, long value) {
        return jdbc.queryForObject("SELECT count(*) FROM " + table + " WHERE " + column + "=?", Integer.class, value);
    }

    @Test void 제출성과와공개성과_같은회원_동시실행() throws Exception {
        String id = submit(3);
        long graded = jdbc.queryForObject("""
                INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,
                    duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed)
                VALUES (?,'active',?,2,5,100.3,2.4,1000,10,'{}',true,true) RETURNING id
                """, Long.class, tic, bundle);
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,rule_version,applied_at,source_refs) VALUES (?,'confirmed','graded','planet','rule-0',now(),'[]')", graded);
        concurrent(() -> publications.publish(member, id), () -> submissions.submit(member, tic, request(5)));
        assertEquals(2, count("user_candidate_achievements", "user_id", member));
        assertEquals(2, jdbc.queryForObject("SELECT achievement_count FROM user_star_progress WHERE user_id=? AND tic_id=?", Integer.class, member, tic));
    }

    @Test void 발견별부족은_성과를유지하고부족수반환() {
        String id = submit(3);
        // 테스트 전용 컨테이너에서 트랜잭션 안의 가용 별만 소진하고 끝에 복구한다.
        new TransactionTemplate(transactions).executeWithoutResult(status -> {
            jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id<>?", tic);
            var result = publications.publish(member, id);
            assertTrue(result.newlyGranted()); assertEquals(1, result.achievement().unlockShortfall());
            assertTrue(result.achievement().unlockedStars().isEmpty());
            assertEquals(1, count("user_candidate_achievements", "user_id", member));
            status.setRollbackOnly();
        });
    }

    @Test void 과거제출늦은공개는_최신판단을덮어쓰지않음() {
        String older = submit(3);
        var request = request(3);
        var newerRequest = new SubmissionRequest(request.requestId(), request.submissionKind(), request.curveContext(),
                request.selection(), "UNSURE", request.evidenceChecks(), request.memo(), request.viewState(), null);
        String newer = submissions.submit(member, tic, newerRequest).body().path("historyId").asText();
        publications.publish(member, newer);
        var result = publications.publish(member, older);
        assertEquals(1L, result.judgmentSummary().get("participantCount"));
        assertEquals(1L, result.judgmentSummary().get("unsure"));
        assertEquals(0L, result.judgmentSummary().get("likelyPlanet"));
        jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE history_id=?", number(newer));
        var fallback = publications.publish(member, older);
        assertEquals(1L, fallback.judgmentSummary().get("likelyPlanet"));
        assertEquals(0L, fallback.judgmentSummary().get("unsure"));
    }

    private <T> List<T> concurrent(java.util.concurrent.Callable<T> first, java.util.concurrent.Callable<T> second) throws Exception {
        var start = new java.util.concurrent.CyclicBarrier(2);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var a = executor.submit(() -> { start.await(5, java.util.concurrent.TimeUnit.SECONDS); return first.call(); });
            var b = executor.submit(() -> { start.await(5, java.util.concurrent.TimeUnit.SECONDS); return second.call(); });
            return List.of(a.get(20, java.util.concurrent.TimeUnit.SECONDS), b.get(20, java.util.concurrent.TimeUnit.SECONDS));
        }
    }
}
