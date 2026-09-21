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
    @Autowired com.planetory.backend.domain.post.service.PublicAnalysisBatchService batches;
    @Autowired com.planetory.backend.domain.post.service.PostReactionService reactions;
    @Autowired com.planetory.backend.domain.post.service.PostService posts;
    @Autowired com.planetory.backend.domain.post.service.PublicAnalysisAccess publicAccess;
    @MockitoSpyBean StarDiscoveryService discovery;
    long member,tic,bundle,segment,candidate;
    Float[] flux;

    @BeforeEach void seed() {
        when(residuals.lookup(anyLong(), any())).thenReturn(ResidualResultReader.Lookup.none());
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

    @Test void 일반반응은_공개판단과_성과를_바꾸지않고_공식스레드에는_허용되지않는다() throws Exception {
        var publication = publications.publish(member, submit(3));
        long thread = Long.parseLong(publication.threadId().substring(3));
        var tx = new TransactionTemplate(transactions);
        var summary = tx.execute(s -> submissions.publicJudgmentSummary(candidate));
        int achievements = count("user_candidate_achievements", "user_id", member);
        long postId = Long.parseLong(posts.create(member, new com.planetory.backend.domain.post.service.PostService.CreateCommand(
                "일반 의견", "본문", "GENERAL", null, List.of(), List.of())).postId().substring(2));
        for (String reaction : List.of("AGREE", "DISAGREE", "NONE")) {
            reactions.put(member, postId, reaction);
            mvc.perform(put("/api/v1/posts/p-" + thread + "/my-reaction").session(session(member)).with(csrf())
                            .contentType("application/json").content("{\"reaction\":\"" + reaction + "\"}"))
                    .andExpect(status().isNotFound());
        }
        mvc.perform(get("/api/v1/posts/p-" + thread + "/reactions").session(session(member)).param("reaction", "AGREE"))
                .andExpect(status().isNotFound());
        var after = tx.execute(s -> submissions.publicJudgmentSummary(candidate));
        summary.forEach((key, value) -> {
            if (!key.equals("asOf")) assertEquals(value, after.get(key), key);
        });
        assertEquals(achievements, count("user_candidate_achievements", "user_id", member));
        assertEquals(1, count("published_analyses", "user_id", member));
        assertEquals(0, count("post_reactions", "post_id", thread));
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
        var firstResponse = mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"" + id + "\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.created").value(true))
                .andExpect(jsonPath("$.achievementGranted").value(true)).andExpect(jsonPath("$.newlyGranted").value(true))
                .andExpect(jsonPath("$.achievement.star.byType.unconfirmed").value(1))
                .andExpect(jsonPath("$.judgmentSummary.participantCount").value(1))
                .andExpect(jsonPath("$.achievement.unlockedStars[0].ticId").isString())
                .andExpect(jsonPath("$.achievement.unlockedStars[0].position.worldX").isNumber())
                .andExpect(jsonPath("$.achievement.unlockedStars[0].layoutOrdinal").doesNotExist())
                .andExpect(jsonPath("$.achievement.unlockedStars[0].skyVersion").doesNotExist())
                .andReturn().getResponse().getContentAsString();
        int unlockedCount = count("star_unlocks", "user_id", member);
        var replay = publications.publish(member, id);
        assertFalse(replay.created()); assertFalse(replay.newlyGranted()); assertTrue(replay.achievementGranted());
        assertFalse(replay.achievement().unlockedStars().isEmpty());
        var replayResponse = mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"" + id + "\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.newlyGranted").value(false))
                .andReturn().getResponse().getContentAsString();
        var mapper = new tools.jackson.databind.ObjectMapper();
        assertEquals(mapper.readTree(firstResponse).path("achievement").path("unlockedStars"),
                mapper.readTree(replayResponse).path("achievement").path("unlockedStars"));
        assertEquals(unlockedCount, count("star_unlocks", "user_id", member));
        assertEquals(1, count("published_analyses", "history_id", number(id)));
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
        assertEquals(snapshot, jdbc.queryForObject("SELECT response_snapshot::text FROM submissions WHERE id="
                + "(SELECT submission_id FROM analysis_histories WHERE id=?)", String.class, number(id)));
        assertTrue(histories.list(member, query(null, null)).items().getFirst().publication().isPublic());
        assertEquals(0, count("comments", "post_id", Long.parseLong(replay.threadId().substring(3))));
    }

    @Test void 미공개별은_404이며_공개성과를_만들지않는다() throws Exception {
        String history = submit(3);
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?", tic);
        mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"" + history + "\"}"))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("STAR_NOT_PUBLISHED"));
        assertEquals(0, count("posts", "candidate_id", candidate));
        assertEquals(0, count("published_analyses", "user_id", member));
        assertEquals(0, count("user_candidate_achievements", "user_id", member));
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
        assertTrue(result.achievement().unlockedStars().isEmpty());
        assertTrue(publications.publish(member, next).achievement().unlockedStars().isEmpty());
        assertEquals(published.achievement().unlockedStars(),
                publications.publish(member, first).achievement().unlockedStars());
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
        assertEquals(first.achievement().unlockedStars(), again.achievement().unlockedStars());
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

    @Test void 재분류후에도_공개집계는_탐사채점통계와_구분한다() {
        String history = submit(3);
        jdbc.update("UPDATE candidate_dispositions SET disposition='confirmed',answer_class='graded',planet_truth='planet' WHERE candidate_id=?", candidate);
        var first = publications.publish(member, history);
        assertEquals("public_analyses", first.judgmentSummary().get("kind"));
        assertEquals(1L, first.judgmentSummary().get("participantCount"));
        assertFalse(first.judgmentSummary().containsKey("matchedMemberCount"));
        var current = (java.util.Map<?, ?>) histories.detail(member, history).submission().judgmentStatistics();
        assertEquals("graded", current.get("kind"));
        assertEquals(1L, current.get("matchedMemberCount"));
        assertFalse(current.containsKey("participantCount"));
        var replay = publications.publish(member, history);
        assertEquals("public_analyses", replay.judgmentSummary().get("kind"));
        assertEquals(1L, replay.judgmentSummary().get("participantCount"));
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

    @Test void 없는History는_404이고_공개와성과를_생성하지않는다() throws Exception {
        mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"h-999999999999999999\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
        assertEquals(0, count("posts", "candidate_id", candidate));
        assertEquals(0, count("published_analyses", "user_id", member));
        assertEquals(0, count("user_candidate_achievements", "user_id", member));
    }

    @Test void 저장된판정근거가없으면_503이고_현재라벨로공개하지않는다() throws Exception {
        String history = submit(3);
        jdbc.update("UPDATE submissions SET response_snapshot=NULL WHERE id="
                + "(SELECT submission_id FROM analysis_histories WHERE id=?)", number(history));
        mvc.perform(post("/api/v1/public-analyses").session(session(member)).with(csrf())
                        .contentType("application/json").content("{\"historyId\":\"" + history + "\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("DEPENDENCY_UNAVAILABLE"));
        assertEquals(0, count("posts", "candidate_id", candidate));
        assertEquals(0, count("published_analyses", "user_id", member));
        assertEquals(0, count("user_candidate_achievements", "user_id", member));
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

    @Test void 공개취소_반복_재공개는_최초시각과성과를_보존한다() throws Exception {
        String history = submit(3);
        var first = publications.publish(member, history);
        String path = "/api/v1/public-analyses/" + first.analysisId() + "/visibility";
        String publishedAt = jdbc.queryForObject("SELECT published_at::text FROM published_analyses WHERE history_id=?", String.class, number(history));
        int unlocked = count("star_unlocks", "user_id", member);
        mvc.perform(put(path).session(session(member)).with(csrf()).contentType("application/json")
                        .content("{\"isPublic\":false}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.analysisId").value(first.analysisId()))
                .andExpect(jsonPath("$.isPublicByAuthor").value(false))
                .andExpect(jsonPath("$.isPublic").value(false))
                .andExpect(jsonPath("$.isModerationHidden").value(false))
                .andExpect(jsonPath("$.isEffectivelyPublic").value(false));
        String cancelledAt = jdbc.queryForObject("SELECT unpublished_at::text FROM published_analyses WHERE history_id=?", String.class, number(history));
        publications.visibility(member, first.analysisId(), false);
        assertEquals(cancelledAt, jdbc.queryForObject("SELECT unpublished_at::text FROM published_analyses WHERE history_id=?", String.class, number(history)));
        assertFalse(publications.publish(member, history).isPublic());
        assertEquals("UNPUBLISHED", histories.detail(member, history).submission().publication().state());
        assertTrue(publications.visibility(member, first.analysisId(), true).isEffectivelyPublic());
        mvc.perform(put(path).session(session(member)).with(csrf()).contentType("application/json")
                        .content("{\"isPublic\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.isPublicByAuthor").value(true))
                .andExpect(jsonPath("$.isPublic").value(true))
                .andExpect(jsonPath("$.isEffectivelyPublic").value(true));
        var replay = publications.publish(member, history);
        assertFalse(replay.newlyGranted());
        assertEquals(first.achievement().unlockedStars(), replay.achievement().unlockedStars());
        assertEquals(first.achievement().star(), replay.achievement().star());
        assertEquals(first.skyVersion(), replay.skyVersion());
        assertEquals(unlocked, count("star_unlocks", "user_id", member));
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
        assertEquals(publishedAt, jdbc.queryForObject("SELECT published_at::text FROM published_analyses WHERE history_id=?", String.class, number(history)));
    }

    @Test void 숨김중_취소허용_재공개거절_부모복원은_개별상태를유지한다() {
        String history = submit(3);
        var first = publications.publish(member, history);
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE history_id=?", number(history));
        error(ErrorCode.PUBLICATION_HIDDEN, () -> publications.visibility(member, first.analysisId(), true));
        jdbc.update("UPDATE posts SET status='hidden' WHERE candidate_id=?", candidate);
        var cancelled = publications.visibility(member, first.analysisId(), false);
        assertFalse(cancelled.isPublicByAuthor()); assertTrue(cancelled.isModerationHidden());
        error(ErrorCode.THREAD_HIDDEN, () -> publications.visibility(member, first.analysisId(), true));
        jdbc.update("UPDATE posts SET status='visible' WHERE candidate_id=?", candidate);
        error(ErrorCode.PUBLICATION_HIDDEN, () -> publications.visibility(member, first.analysisId(), true));
        jdbc.update("UPDATE published_analyses SET hidden_at=NULL WHERE history_id=?", number(history));
        assertFalse(publications.publish(member, history).isPublic());
        assertTrue(publications.visibility(member, first.analysisId(), true).isEffectivelyPublic());
    }

    @Test void 삭제된_공식부모는_숨김과구분하고_공개호환필드는_false다() throws Exception {
        String history = submit(3);
        var first = publications.publish(member, history);
        jdbc.update("UPDATE posts SET status='deleted' WHERE candidate_id=?", candidate);
        error(ErrorCode.THREAD_HIDDEN, () -> publications.visibility(member, first.analysisId(), true));
        assertFalse(publications.publish(member, history).isPublic());
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> publicAccess.check(member,
                Long.parseLong(first.analysisId().substring(3)), number(history)));
        mvc.perform(put("/api/v1/public-analyses/" + first.analysisId() + "/visibility")
                        .session(session(member)).with(csrf()).contentType("application/json")
                        .content("{\"isPublic\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.isPublicByAuthor").value(false))
                .andExpect(jsonPath("$.isModerationHidden").value(false))
                .andExpect(jsonPath("$.isEffectivelyPublic").value(false))
                .andExpect(jsonPath("$.isPublic").value(false));
    }

    @Test void 공개조회는_현재상태와_실제History관계를_검사한다() {
        String history = submit(3);
        var first = publications.publish(member, history);
        long analysis = Long.parseLong(first.analysisId().substring(3));
        Runnable access = () -> publicAccess.check(member, analysis, number(history));
        assertNotNull(histories.publicContent(history, access));
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> publicAccess.check(member, analysis, number(submit(3))));
        // 공개 내용을 이미 읽었어도 반환 직전 콜백에서 취소를 다시 확인한다.
        var checks = new java.util.concurrent.atomic.AtomicInteger();
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> histories.publicContent(history, () -> {
            if (checks.incrementAndGet() == 2) java.util.concurrent.CompletableFuture.runAsync(
                    () -> publications.visibility(member, first.analysisId(), false)).join();
            access.run();
        }));
        for (String mode : List.of("CURRENT", "SUBMITTED")) {
            error(ErrorCode.RESOURCE_NOT_FOUND, () -> histories.publicGraph(history, mode, access));
        }
        publications.visibility(member, first.analysisId(), true);
        jdbc.update("UPDATE posts SET status='hidden' WHERE candidate_id=?", candidate);
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> histories.publicContent(history, access));
        jdbc.update("UPDATE posts SET status='visible' WHERE candidate_id=?", candidate);
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE history_id=?", number(history));
        error(ErrorCode.RESOURCE_NOT_FOUND, access);
        assertNotNull(histories.detail(member, history)); // 개인 원본은 유지
    }

    @Test void 공개상태변경의_인증_소유권_본문_CSRF() throws Exception {
        var first = publications.publish(member, submit(3));
        String path = "/api/v1/public-analyses/" + first.analysisId() + "/visibility";
        long other = member();
        mvc.perform(put(path).with(csrf()).contentType("application/json").content("{\"isPublic\":false}"))
                .andExpect(status().isUnauthorized());
        mvc.perform(put(path).session(session(member)).contentType("application/json").content("{\"isPublic\":false}"))
                .andExpect(status().isForbidden());
        for (String body : List.of("{}", "null", "{\"isPublic\":\"false\"}", "{\"isPublic\":null}",
                "{\"isPublic\":false,\"hidden_at\":null}")) {
            mvc.perform(put(path).session(session(member)).with(csrf()).contentType("application/json").content(body))
                    .andExpect(status().isBadRequest());
        }
        error(ErrorCode.FORBIDDEN, () -> publications.visibility(other, first.analysisId(), false));
        publications.visibility(member, first.analysisId(), false);
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> publications.visibility(other, first.analysisId(), true));
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> publications.visibility(member, "pa-999999999999999999", true));
        error(ErrorCode.RESOURCE_NOT_FOUND, () -> publications.visibility(member, "pa-01", true));
    }

    @Test void 취소와_POST재전송_경합은_취소와기성과를_유지한다() throws Exception {
        String history = submit(3);
        var first = publications.publish(member, history);
        concurrent(() -> publications.visibility(member, first.analysisId(), false),
                () -> publications.publish(member, history));
        assertFalse(publications.publish(member, history).isPublic());
        assertEquals(1, count("published_analyses", "user_id", member));
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
    }

    @Test void 부모숨김중_타인댓글수정삭제는404_본인반복삭제는204_복원후에도삭제유지() throws Exception {
        var first = publications.publish(member, submit(3));
        long parent = Long.parseLong(first.threadId().substring(3));
        long comment = jdbc.queryForObject("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'본문','visible') RETURNING id",
                Long.class, parent, member);
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?", parent);
        String path = "/api/v1/comments/c-" + comment;
        var other = session(member());
        mvc.perform(patch(path).session(other).with(csrf()).contentType("application/json").content("{\"body\":\"변경\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(delete(path).session(other).with(csrf())).andExpect(status().isNotFound());
        mvc.perform(delete(path).session(session(member)).with(csrf())).andExpect(status().isNoContent());
        mvc.perform(delete(path).session(session(member)).with(csrf())).andExpect(status().isNoContent());
        jdbc.update("UPDATE posts SET status='visible' WHERE id=?", parent);
        assertEquals("deleted", jdbc.queryForObject("SELECT status FROM comments WHERE id=?", String.class, comment));
    }

    @Test void 공개취소는_독립적인_일반글History첨부를_차단하지않는다() throws Exception {
        String history = submit(3);
        var first = publications.publish(member, history);
        String body = mvc.perform(post("/api/v1/posts").session(session(member)).with(csrf())
                        .contentType("application/json").content("""
                                {"title":"독립 첨부","body":"본문","purposeTag":"ANALYSIS","ticId":"%s","historyIds":["%s"]}
                                """.formatted(tic, history)))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String postId = new tools.jackson.databind.ObjectMapper().readTree(body).path("postId").asText();
        publications.visibility(member, first.analysisId(), false);
        mvc.perform(get("/api/v1/posts/" + postId + "/history-attachments/" + history)
                        .param("includeGraph", "false").session(session(member)))
                .andExpect(status().isOk());
    }

    @Test void DB숨김이_먼저확정되면_대기하던재공개는_거절된다() throws Exception {
        var first = publications.publish(member, submit(3));
        publications.visibility(member, first.analysisId(), false);
        var locked = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var hide = executor.submit(() -> new TransactionTemplate(transactions).executeWithoutResult(s -> {
                jdbc.update("UPDATE posts SET status='hidden' WHERE candidate_id=?", candidate);
                locked.countDown();
                try { if (!release.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("대기 초과"); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IllegalStateException(e); }
            }));
            assertTrue(locked.await(5, java.util.concurrent.TimeUnit.SECONDS));
            var publish = executor.submit(() -> publications.visibility(member, first.analysisId(), true));
            try {
                assertThrows(java.util.concurrent.TimeoutException.class,
                        () -> publish.get(200, java.util.concurrent.TimeUnit.MILLISECONDS));
            } finally { release.countDown(); }
            hide.get(5, java.util.concurrent.TimeUnit.SECONDS);
            var failure = assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> publish.get(5, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(ErrorCode.THREAD_HIDDEN, ((BusinessException) failure.getCause()).getErrorCode());
            assertFalse(publications.publish(member, "h-" + jdbc.queryForObject(
                    "SELECT history_id FROM published_analyses WHERE user_id=?", Long.class, member)).isPublic());
        }
    }

    @Test void 앱역할로_공개성과저장_성공() {
        String id = submit(3);
        new TransactionTemplate(transactions).executeWithoutResult(status -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            var published = publications.publish(member, id);
            assertTrue(published.newlyGranted());
            assertFalse(publications.visibility(member, published.analysisId(), false).isEffectivelyPublic());
            assertTrue(publications.visibility(member, published.analysisId(), true).isEffectivelyPublic());
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
        var newerPublished = publications.publish(member, newer);
        var result = publications.publish(member, older);
        assertEquals(1L, result.judgmentSummary().get("participantCount"));
        assertEquals(1L, result.judgmentSummary().get("unsure"));
        assertEquals(0L, result.judgmentSummary().get("likelyPlanet"));
        publications.visibility(member, newerPublished.analysisId(), false);
        var fallback = publications.publish(member, older);
        assertEquals(1L, fallback.judgmentSummary().get("likelyPlanet"));
        assertEquals(0L, fallback.judgmentSummary().get("unsure"));
        publications.visibility(member, result.analysisId(), false);
        assertEquals(0L, publications.publish(member, older).judgmentSummary().get("participantCount"));
    }

    @Test void 공개15명_세판단비율과_빈집계는_null이다() {
        assertEquals(0L, summary().get("participantCount"));
        assertNull(summary().get("percentages"));
        for (int i = 0; i < 15; i++) {
            long voter = member();
            var position = layout.place(0);
            jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                    voter, tic, position.depthZ(), position.worldX(), position.worldY(), position.layoutVersion());
            publications.publish(voter, submitJudgment(voter, i < 8 ? "LIKELY_PLANET" : i < 12 ? "UNLIKELY_PLANET" : "UNSURE"));
        }
        var result = summary();
        assertEquals("public_analyses", result.get("kind"));
        assertEquals("c-" + candidate, result.get("candidateId"));
        assertEquals(15L, result.get("participantCount"));
        assertEquals(8L, result.get("likelyPlanet"));
        assertEquals(4L, result.get("unlikelyPlanet"));
        assertEquals(3L, result.get("unsure"));
        assertEquals(java.util.Map.of("likelyPlanet", 53.3, "unlikelyPlanet", 26.7, "unsure", 20.0), result.get("percentages"));
        assertInstanceOf(java.time.OffsetDateTime.class, result.get("asOf"));
        // 조회는 공개·성과·History·진행 행을 만들지 않는다.
        assertEquals(15, count("published_analyses", "candidate_id", candidate));
        assertEquals(15, count("user_candidate_achievements", "candidate_id", candidate));
        assertEquals(15, count("analysis_histories", "tic_id", tic));
        assertEquals(15, count("user_star_progress", "tic_id", tic));
    }

    @Test void 동률은_큰제출ID이며_미공개와숨김복원은_유효대표만_선택한다() {
        String older = submitJudgment(member, "LIKELY_PLANET");
        String newer = submitJudgment(member, "UNSURE");
        jdbc.update("UPDATE submissions SET created_at='2026-09-01T00:00:00Z' WHERE user_id=? AND tic_id=?", member, tic);
        var latest = publications.publish(member, newer);
        publications.publish(member, older); // 공개 순서와 ID 선택은 독립이다.
        assertEquals(1L, summary().get("unsure"));
        submitJudgment(member, "UNLIKELY_PLANET");
        assertEquals(1L, summary().get("unsure"));
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE history_id=?", number(newer));
        assertEquals(1L, summary().get("likelyPlanet"));
        for (String state : List.of("hidden", "deleted")) {
            jdbc.update("UPDATE posts SET status=? WHERE candidate_id=?", state, candidate);
            assertEquals(0L, summary().get("participantCount"));
            assertNull(summary().get("percentages"));
        }
        jdbc.update("UPDATE posts SET status='visible' WHERE candidate_id=?", candidate);
        assertEquals(1L, summary().get("likelyPlanet"));
        publications.visibility(member, latest.analysisId(), false);
        jdbc.update("UPDATE published_analyses SET hidden_at=NULL WHERE history_id=?", number(newer));
        assertEquals(1L, summary().get("likelyPlanet")); // 숨김 복구가 본인 취소를 되돌리지 않는다.
        assertEquals(3, count("analysis_histories", "user_id", member));
        assertEquals(1, count("user_candidate_achievements", "user_id", member));
    }

    @Test void 읽기트랜잭션은_동시취소에도_같은분모를_유지하고_다음조회는_갱신한다() {
        var published = publications.publish(member, submit(3));
        var tx = new TransactionTemplate(transactions);
        tx.setReadOnly(true);
        tx.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        tx.executeWithoutResult(status -> {
            var before = submissions.publicJudgmentSummary(candidate);
            java.util.concurrent.CompletableFuture.runAsync(
                    () -> publications.visibility(member, published.analysisId(), false)).join();
            assertEquals(1L, before.get("participantCount"));
            assertEquals(before.get("participantCount"), submissions.publicJudgmentSummary(candidate).get("participantCount"));
        });
        assertEquals(0L, summary().get("participantCount"));
        assertNull(summary().get("percentages"));
    }

    private String submitJudgment(long voter, String judgment) {
        var r = request(3);
        return submissions.submit(voter, tic, new SubmissionRequest(r.requestId(), r.submissionKind(), r.curveContext(),
                r.selection(), judgment, r.evidenceChecks(), r.memo(), r.viewState(), null)).body().path("historyId").asText();
    }

    private java.util.Map<String, Object> summary() {
        return new TransactionTemplate(transactions).execute(status -> submissions.publicJudgmentSummary(candidate));
    }

    @org.junit.jupiter.api.Nested
    class BatchPublication {
        final tools.jackson.databind.ObjectMapper json = new tools.jackson.databind.ObjectMapper();

        tools.jackson.databind.JsonNode requestBody(List<String> ids) {
            return json.valueToTree(java.util.Map.of("ticId", Long.toString(tic),
                    "items", ids.stream().map(id -> java.util.Map.of("historyId", id)).toList()));
        }
        tools.jackson.databind.JsonNode publish(List<String> ids) throws Exception {
            return json.readTree(mvc.perform(post("/api/v1/public-analyses/batch")
                    .session(session(member)).with(csrf()).contentType("application/json")
                    .content(requestBody(ids).toString())).andExpect(status().isOk())
                    .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
                    .andReturn().getResponse().getContentAsString()).path("results");
        }
        org.springframework.util.LinkedMultiValueMap<String, String> params(String size, String cursor) {
            var params = new org.springframework.util.LinkedMultiValueMap<String, String>();
            params.add("ticId", Long.toString(tic)); params.add("size", size);
            if (cursor != null) params.add("cursor", cursor);
            return params;
        }
        // 실제 제출로 만든 History에 합성 신호를 연결한다. 공개·성과·트랜잭션은 실제 경로다.
        String otherSignal() {
            String history = submit(3);
            long signal = jdbc.queryForObject("""
                    INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,
                        duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed)
                    SELECT tic_id,'retired',updated_bundle_id,(SELECT max(removal_step)+1 FROM candidates WHERE tic_id=?),
                        period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed
                    FROM candidates WHERE id=? RETURNING id
                    """, Long.class, tic, candidate);
            jdbc.update("""
                    UPDATE submissions SET matched_candidate_id=?,
                        response_snapshot=jsonb_set(response_snapshot,'{match,candidateId}',to_jsonb(?::text))
                    WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)
                    """, signal, "c-" + signal, number(history));
            return history;
        }
        long signal(String history) {
            return jdbc.queryForObject("SELECT s.matched_candidate_id FROM submissions s JOIN analysis_histories h ON h.submission_id=s.id WHERE h.id=?",
                    Long.class, number(history));
        }

        @Test void 전체형식오류_0_21_중복History_중복신호는_저장전400() throws Exception {
            String first = submit(3), same = submit(3);
            var bodies = new java.util.ArrayList<>(List.of("null", "{}", "[]",
                    "{\"ticId\":1,\"items\":[]}", "{\"ticId\":\"01\",\"items\":[{\"historyId\":\"h-1\"}]}",
                    "{\"ticId\":\"1\",\"items\":[{\"historyId\":1}]}",
                    "{\"ticId\":\"1\",\"items\":[{\"historyId\":\"h-01\"}]}",
                    "{\"ticId\":\"1\",\"items\":[{\"historyId\":\"h-1\",\"candidateId\":\"c-1\"}]}",
                    "{\"ticId\":\"1\",\"items\":[{\"historyId\":\"h-1\"}],\"userId\":1}"));
            for (var ids : List.of(List.<String>of(), List.of(first, first), List.of(first, same),
                    java.util.stream.LongStream.rangeClosed(1, 21).mapToObj(i -> "h-" + i).toList()))
                bodies.add(requestBody(ids).toString());
            for (String body : bodies) mvc.perform(post("/api/v1/public-analyses/batch").session(session(member))
                    .with(csrf()).contentType("application/json").content(body)).andExpect(status().isBadRequest());
            assertEquals(0, count("published_analyses", "user_id", member));
            assertEquals(0, count("user_candidate_achievements", "user_id", member));
        }

        @Test void 한개_20개_입력순서_재시도_응답유실은_성과와별을중복지급하지않는다() throws Exception {
            String first = submit(3);
            assertEquals("PUBLISHED", publish(List.of(first)).get(0).path("status").asText());
            var ids = new java.util.ArrayList<String>(); ids.add(first);
            for (int i = 1; i < 20; i++) ids.add(otherSignal());
            var result = publish(ids);
            assertEquals(20, result.size());
            for (int i = 0; i < 20; i++) {
                assertEquals(ids.get(i), result.get(i).path("historyId").asText());
                assertEquals("PUBLISHED", result.get(i).path("status").asText());
                assertEquals(i + 1, result.get(i).path("achievement").path("star").path("count").asInt());
            }
            int unlocked = count("star_unlocks", "user_id", member);
            var replay = publish(ids);
            for (int i = 0; i < 20; i++) {
                assertFalse(replay.get(i).path("newlyGranted").asBoolean());
                assertFalse(replay.get(i).path("created").asBoolean());
                assertEquals(result.get(i).path("analysisId"), replay.get(i).path("analysisId"));
                assertEquals(result.get(i).path("achievement").path("unlockedStars"),
                        replay.get(i).path("achievement").path("unlockedStars"));
            }
            assertEquals(20, count("published_analyses", "user_id", member));
            assertEquals(20, count("user_candidate_achievements", "user_id", member));
            assertEquals(unlocked, count("star_unlocks", "user_id", member));
        }

        @Test void 타인_없는기록_다른TIC_미자격은_항목별실패이고_신호정보를누출하지않는다() throws Exception {
            String own = submit(3), foreign = submit(3), mismatch = otherSignal(), ineligible = otherSignal();
            long other = member();
            jdbc.update("UPDATE analysis_histories SET user_id=? WHERE id=?", other, number(foreign));
            jdbc.update("UPDATE submissions SET user_id=? WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", other, number(foreign));
            jdbc.update("UPDATE analysis_histories SET tic_id=? WHERE id=?", tic + 1000000000, number(mismatch));
            jdbc.update("UPDATE submissions SET response_snapshot=jsonb_set(response_snapshot,'{signal,answerClass}','\"graded\"') WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", number(ineligible));
            var result = publish(List.of(foreign, own, "h-999999999999999999", mismatch, ineligible));
            assertEquals("PUBLISHED", result.get(1).path("status").asText());
            for (int index : List.of(0, 2, 3, 4)) {
                assertEquals("FAILED", result.get(index).path("status").asText());
                assertFalse(result.get(index).has("candidateId"));
                assertFalse(result.get(index).has("analysisId"));
                assertFalse(result.get(index).path("retryable").asBoolean());
            }
            assertEquals("FORBIDDEN", result.get(0).path("error").path("code").asText());
            assertEquals("RESOURCE_NOT_FOUND", result.get(2).path("error").path("code").asText());
            assertEquals("TIC_MISMATCH", result.get(3).path("error").path("code").asText());
            assertEquals("요청한 별과 같은 별의 분석 기록만 공개할 수 있습니다.",
                    result.get(3).path("error").path("message").asText());
            assertEquals("PUBLICATION_NOT_ELIGIBLE", result.get(4).path("error").path("code").asText());
            assertEquals(1, count("published_analyses", "user_id", member));
        }

        @Test void 전항목실패도200_취소숨김재전송은_NOT_PUBLISHED() throws Exception {
            assertEquals("FAILED", publish(List.of("h-999999999999999999")).get(0).path("status").asText());
            String cancelled = submit(3), hidden = otherSignal();
            var publication = publications.publish(member, cancelled);
            publications.publish(member, hidden);
            publications.visibility(member, publication.analysisId(), false);
            jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE history_id=?", number(hidden));
            var result = publish(List.of(cancelled, hidden));
            for (var item : result) {
                assertEquals("NOT_PUBLISHED", item.path("status").asText());
                assertFalse(item.path("isPublic").asBoolean());
                assertFalse(item.path("newlyGranted").asBoolean());
            }
            assertTrue(batches.candidates(member, params("20", null)).items().isEmpty());
        }

        @Test void 중간일시장애는_롤백하고_앞뒤성공유지_실패분만재시도한다() throws Exception {
            var ids = List.of(submit(3), otherSignal(), otherSignal());
            var calls = new java.util.concurrent.atomic.AtomicInteger();
            StarDiscoveryService target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(discovery);
            doAnswer(invocation -> {
                if (calls.incrementAndGet() == 2) throw new org.springframework.dao.CannotAcquireLockException("private DB detail");
                return invocation.callRealMethod();
            }).when(target).discoverByAchievement(anyLong(), anyLong(), any());
            var result = publish(ids);
            assertEquals("PUBLISHED", result.get(0).path("status").asText());
            assertEquals("FAILED", result.get(1).path("status").asText());
            assertTrue(result.get(1).path("retryable").asBoolean());
            assertFalse(result.toString().contains("private DB detail"));
            assertEquals("PUBLISHED", result.get(2).path("status").asText());
            assertEquals(0, count("published_analyses", "history_id", number(ids.get(1))));
            assertEquals(0, count("posts", "candidate_id", signal(ids.get(1))));
            assertEquals(2, count("user_candidate_achievements", "user_id", member));
            assertEquals("PUBLISHED", publish(List.of(ids.get(1))).get(0).path("status").asText());
            assertEquals(3, count("user_candidate_achievements", "user_id", member));
        }

        @Test void 내부장애와_근거누락은_임의재시도가능으로표시하지않는다() throws Exception {
            String first = submit(3), missing = otherSignal();
            jdbc.update("UPDATE submissions SET response_snapshot=NULL WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", number(missing));
            StarDiscoveryService target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(discovery);
            doThrow(new IllegalStateException("private DB detail")).when(target).discoverByAchievement(anyLong(), anyLong(), any());
            var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(
                    com.planetory.backend.domain.post.service.PublicAnalysisBatchService.class);
            var logs = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
            logs.start(); logger.addAppender(logs);
            tools.jackson.databind.JsonNode result;
            try {
                result = publish(List.of(first, missing));
                assertTrue(logs.list.stream().anyMatch(event -> event.getThrowableProxy() != null
                        && event.getThrowableProxy().getStackTraceElementProxyArray().length > 0));
            } finally { logger.detachAppender(logs); logs.stop(); }
            assertFalse(result.toString().contains("private DB detail"));
            assertEquals("INTERNAL_ERROR", result.get(0).path("error").path("code").asText());
            assertEquals("DEPENDENCY_UNAVAILABLE", result.get(1).path("error").path("code").asText());
            assertFalse(result.get(0).path("retryable").asBoolean());
            assertFalse(result.get(1).path("retryable").asBoolean());
            assertEquals(0, count("published_analyses", "user_id", member));
        }

        @Test void 항목사이상태변경을_다음단건에서재검사한다() throws Exception {
            String first = submit(3), second = otherSignal();
            StarDiscoveryService target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(discovery);
            doAnswer(invocation -> {
                Object result = invocation.callRealMethod();
                jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?", tic);
                return result;
            }).when(target).discoverByAchievement(anyLong(), anyLong(), any());
            var result = publish(List.of(first, second));
            assertEquals("PUBLISHED", result.get(0).path("status").asText());
            assertEquals("STAR_NOT_PUBLISHED", result.get(1).path("error").path("code").asText());
            assertEquals(1, count("published_analyses", "user_id", member));
        }

        @Test void 동시전체재전송과_바깥롤백도_항목의독립확정을바꾸지않는다() throws Exception {
            var ids = List.of(submit(3), otherSignal());
            concurrent(() -> batches.publish(member, requestBody(ids)), () -> batches.publish(member, requestBody(ids)));
            String next = otherSignal();
            new TransactionTemplate(transactions).executeWithoutResult(s -> {
                batches.publish(member, requestBody(List.of(next)));
                s.setRollbackOnly();
            });
            assertEquals(3, count("published_analyses", "user_id", member));
            assertEquals(3, count("user_candidate_achievements", "user_id", member));
        }

        @Test void 순차단건과_일괄공개의_누적성과등급발견개수는같다() throws Exception {
            var ids = List.of(submit(3), otherSignal(), otherSignal());
            var sequential = new TransactionTemplate(transactions).execute(s -> {
                var results = ids.stream().map(id -> publications.publish(member, id)).toList();
                s.setRollbackOnly();
                return results;
            });
            assertEquals(0, count("published_analyses", "user_id", member));
            var result = publish(ids);
            for (int i = 0; i < ids.size(); i++) {
                var expected = sequential.get(i).achievement();
                var actual = result.get(i).path("achievement");
                assertEquals(expected.star().count(), actual.path("star").path("count").asInt());
                assertEquals(expected.star().grade(), actual.path("star").path("grade").asText());
                assertEquals(expected.unlockedStars().size(), actual.path("unlockedStars").size());
                assertEquals(expected.unlockShortfall(), actual.path("unlockShortfall").asInt());
            }
        }

        @Test void 대표후보는_신호별최신선택후페이지하며_동률은제출ID다() throws Exception {
            submit(3); submit(3);
            String second = otherSignal();
            for (int i = 0; i < 22; i++) submit(3);
            String latest = submit(3);
            jdbc.update("UPDATE submissions SET created_at='2026-09-01T00:00:00Z' WHERE user_id=?", member);
            var first = batches.candidates(member, params("1", null));
            assertTrue(first.hasMore()); assertEquals(latest, first.items().getFirst().historyId());
            assertTrue(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM analysis_snapshots WHERE history_id=?)", Boolean.class, number(latest)));
            assertNotNull(histories.detail(member, latest).submission());
            jdbc.update("DELETE FROM analysis_snapshots WHERE history_id=?", number(latest));
            assertEquals(latest, batches.candidates(member, params("1", null)).items().getFirst().historyId());
            assertNull(histories.graph(member, latest, "SUBMITTED").snapshot());
            var last = batches.candidates(member, params("1", first.nextCursor()));
            assertEquals(second, last.items().getFirst().historyId()); assertFalse(last.hasMore());
            assertEquals(2, batches.candidates(member, params("100", null)).items().size());
            assertEquals(0, count("published_analyses", "user_id", member));
            error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member, params("2", first.nextCursor())));
            error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member(), params("1", first.nextCursor())));
            publications.publish(member, latest);
            var remaining = batches.candidates(member, params("20", null));
            assertNotEquals(latest, remaining.items().getFirst().historyId());
            assertTrue(remaining.items().stream().anyMatch(item -> item.candidateId().equals("c-" + candidate)));
            mvc.perform(get("/api/v1/public-analyses/batch-candidates").session(session(member)).param("ticId", Long.toString(tic)))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].submissionId").isString())
                    .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")));
        }

        @Test void 후보는_타인_다른별_비자격_숨김스레드_공개이력을제외하고_조회후에도재검사한다() throws Exception {
            String eligible = submit(3), wrongOwner = otherSignal(), wrongTic = otherSignal(),
                    graded = otherSignal(), published = otherSignal(), hidden = otherSignal();
            jdbc.update("UPDATE analysis_histories SET user_id=? WHERE id=?", member(), number(wrongOwner));
            jdbc.update("UPDATE analysis_histories SET tic_id=? WHERE id=?", tic + 1000000000, number(wrongTic));
            jdbc.update("UPDATE submissions SET response_snapshot=jsonb_set(response_snapshot,'{signal,answerClass}','\"graded\"') WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", number(graded));
            publications.publish(member, published);
            jdbc.update("INSERT INTO posts(kind,user_id,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',NULL,?,'star',?,'hidden','','hidden')", signal(hidden), tic);
            var page = batches.candidates(member, params("20", null));
            assertEquals(List.of(eligible), page.items().stream().map(p -> p.historyId()).toList());
            new TransactionTemplate(transactions).executeWithoutResult(s -> {
                jdbc.execute("SET LOCAL ROLE planetory_app");
                assertEquals(page, batches.candidates(member, params("20", null)));
            });
            assertEquals("THREAD_HIDDEN", publish(List.of(hidden)).get(0).path("error").path("code").asText());
            jdbc.update("UPDATE submissions SET response_snapshot=jsonb_set(response_snapshot,'{signal,answerClass}','\"graded\"') WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", number(eligible));
            assertEquals("PUBLICATION_NOT_ELIGIBLE", publish(List.of(eligible)).get(0).path("error").path("code").asText());
        }

        @Test void 인증_CSRF_잘못된후보필터_커서를거절한다() throws Exception {
            mvc.perform(get("/api/v1/public-analyses/batch-candidates").param("ticId", Long.toString(tic)))
                    .andExpect(status().isUnauthorized());
            mvc.perform(post("/api/v1/public-analyses/batch").with(csrf()).contentType("application/json").content(requestBody(List.of("h-1")).toString()))
                    .andExpect(status().isUnauthorized());
            mvc.perform(post("/api/v1/public-analyses/batch").session(session(member)).contentType("application/json").content(requestBody(List.of("h-1")).toString()))
                    .andExpect(status().isForbidden());
            for (String size : List.of("0", "101", "-1", "01", "x"))
                error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member, params(size, null)));
            for (String cursor : List.of("", "garbage", "a".repeat(1025)))
                error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member, params("20", cursor)));
            String binding = "batch-candidates-v1|" + member + "|" + tic + "|20|";
            String legacyCursor = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                    (binding + "2026-09-01T00:00Z|1").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertDoesNotThrow(() -> batches.candidates(member, params("20", legacyCursor)));
            for (String raw : List.of("feed-v1|" + tic + "||20|2026-09-01T00:00Z|1",
                    binding + "2026-09-01T00:00:00.000000001Z|1", binding + "0000-09-01T00:00Z|1",
                    binding + "2026-09-01T00:00Z|01", binding + "2026-09-01T00:00Z|9223372036854775808")) {
                String cursor = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member, params("20", cursor)));
            }
            var extra = params("20", null); extra.add("userId", "1");
            error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member, extra));
            var duplicate = params("20", null); duplicate.add("ticId", Long.toString(tic));
            error(ErrorCode.VALIDATION_FAILED, () -> batches.candidates(member, duplicate));
        }
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
