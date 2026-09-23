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
class CommunityReadTest {
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
    @Autowired com.planetory.backend.domain.post.service.PublicAnalysisAccess publicAccess;
    @MockitoSpyBean com.planetory.backend.domain.gold.GoldCatalogRepository gold;
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


    @Autowired com.planetory.backend.domain.post.service.CommunityReadService community;
    @Autowired com.planetory.backend.domain.comment.service.CommentService commentService;
    @MockitoSpyBean HistoryRepository historyRepository;
    @MockitoSpyBean SubmissionRepository summaryRepository;
    @MockitoSpyBean org.springframework.jdbc.core.simple.JdbcClient feedJdbc;

    private static final tools.jackson.databind.json.JsonMapper JSON = tools.jackson.databind.json.JsonMapper.builder().build();
    private static final String FEED = "/api/v1/community/feed";
    String threadPath(PublicAnalysisService.Published p) { return "/api/v1/signal-threads/" + p.threadId(); }
    String publicPath(PublicAnalysisService.Published p) { return "/api/v1/public-analyses/" + p.analysisId(); }
    tools.jackson.databind.JsonNode read(String path) throws Exception {
        return JSON.readTree(mvc.perform(get(java.net.URI.create(path)).session(session(member))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store"))).andReturn().getResponse().getContentAsString());
    }
    long post(Long star, String status) {
        return jdbc.queryForObject("INSERT INTO posts(kind,user_id,board,tic_id,tag,title,body,status) "
                        + "VALUES ('user',?,?,?,'GENERAL','피드 제목','피드 본문',?) RETURNING id", Long.class,
                member, star == null ? "free" : "star", star, status);
    }
    com.planetory.backend.domain.post.service.CommunityQuery feedQuery() {
        var params = new org.springframework.util.LinkedMultiValueMap<String, String>();
        params.add("ticId", Long.toString(tic));
        return com.planetory.backend.domain.post.service.CommunityQuery.feed(params);
    }
    com.planetory.backend.domain.post.service.CommunityQuery analysisQuery(PublicAnalysisService.Published p) {
        return com.planetory.backend.domain.post.service.CommunityQuery.analyses(
                Long.parseLong(p.threadId().substring(3)), new org.springframework.util.LinkedMultiValueMap<>());
    }

    @Test void 탈퇴_공개분석은_목록_상세_현재판단에서_함께_제외한다() {
        var publication = publications.publish(member, submit(3));
        long viewer = member();
        assertEquals(1, community.analyses(viewer, analysisQuery(publication)).items().size());
        jdbc.update("UPDATE users SET status='withdrawn', withdrawn_at=clock_timestamp() WHERE id=?", member);
        assertTrue(community.analyses(viewer, analysisQuery(publication)).items().isEmpty());
        error(ErrorCode.RESOURCE_NOT_FOUND,
                () -> community.analysis(viewer, Long.parseLong(publication.analysisId().substring(3)), "CURRENT", false));
        var summary = new TransactionTemplate(transactions).execute(tx -> submissions.publicJudgmentSummary(candidate));
        assertEquals(0, ((Number) summary.get("participantCount")).intValue());
    }

    @Test void 탈퇴_일반글과_댓글은_남기되_이전_이름과_프로필_연결을_숨긴다() {
        long postId = post(tic, "visible");
        jdbc.update("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'댓글','visible')", postId, member);
        String oldName = jdbc.queryForObject("SELECT nickname FROM users WHERE id=?", String.class, member);
        long viewer = member();
        jdbc.update("UPDATE users SET status='withdrawn', withdrawn_at=clock_timestamp() WHERE id=?", member);
        var feed = community.feed(viewer, feedQuery()).items();
        assertEquals(1, feed.size());
        assertEquals(new com.planetory.backend.domain.post.service.PostService.Author(null, "탈퇴한 회원"), feed.getFirst().author());
        var comment = commentService.list(postId, com.planetory.backend.domain.comment.service.CommentService.ParentType.POST,
                20, null).items().getFirst();
        assertNull(comment.author().memberId());
        assertEquals("탈퇴한 회원", comment.author().nickname());
        var search = new org.springframework.util.LinkedMultiValueMap<String, String>();
        search.add("ticId", Long.toString(tic));
        search.add("author", oldName);
        assertTrue(community.feed(viewer, com.planetory.backend.domain.post.service.CommunityQuery.feed(search)).items().isEmpty());
    }

    @Test void 혼합피드_시각동률_숫자ID_페이지_현재닉네임_댓글수() throws Exception {
        var p = publications.publish(member, submit(3));
        long a = post(tic, "visible"), b = post(tic, "visible");
        long free = post(null, "visible"), hidden = post(tic, "hidden"), deleted = post(tic, "deleted");
        jdbc.update("UPDATE posts SET created_at='2026-09-21T00:00:00.123456Z' WHERE tic_id=? OR id=?", tic, free);
        jdbc.update("UPDATE users SET nickname='새 닉네임' WHERE id=?", member);
        jdbc.update("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'표시','visible'),(?,?,'숨김','hidden'),(?,?,'삭제','deleted')",
                b,member,b,member,b,member);
        var first = read(FEED + "?ticId=" + tic + "&size=2");
        assertEquals("p-" + b, first.path("items").get(0).path("id").asText());
        assertEquals("새 닉네임", first.path("items").get(0).path("author").path("nickname").asText());
        assertEquals(1, first.path("items").get(0).path("commentCount").asInt());
        assertEquals("p-" + a, first.path("items").get(1).path("id").asText());
        assertTrue(first.path("hasNext").asBoolean());
        String cursor = first.path("nextCursor").asText();
        // 커서 행이 삭제되고 새 글이 생겨도 위치는 유지한다.
        jdbc.update("UPDATE posts SET status='deleted' WHERE id=?", a);
        post(tic, "visible");
        var second = read(FEED + "?ticId=" + tic + "&size=2&cursor=" + cursor);
        assertEquals(1, second.path("items").size());
        var thread = second.path("items").get(0);
        assertEquals(p.threadId(), thread.path("id").asText());
        assertEquals("SIGNAL_THREAD", thread.path("type").asText());
        assertEquals("SYSTEM", thread.path("author").path("type").asText());
        assertFalse(thread.path("author").has("memberId"));
        assertEquals(1, thread.path("judgmentSummary").path("participantCount").asInt());
        assertFalse(second.path("hasNext").asBoolean());
        assertTrue(second.path("nextCursor").isNull());
        var all = read(FEED + "?size=100").path("items");
        var ids = new java.util.HashSet<String>(); all.forEach(i -> ids.add(i.path("id").asText()));
        assertTrue(ids.contains("p-" + free)); assertFalse(ids.contains("p-" + hidden)); assertFalse(ids.contains("p-" + deleted));
    }

    @Test void 프론트_특정별_기본요청의_STAR중복범위와_커서호환() throws Exception {
        long first = post(tic, "visible"), second = post(tic, "visible");
        // readFeedSearch(routeTic) → feedSearchParams → CommunityPage가 보내는 실제 조합이다.
        var response = read(FEED + "?ticId=" + tic + "&board=STAR&size=20");
        assertEquals(2, response.path("items").size());
        assertEquals("p-" + second, response.path("items").get(0).path("id").asText());
        assertEquals(read(FEED + "?ticId=" + tic + "&size=20"), response);
        String cursor = read(FEED + "?ticId=" + tic + "&board=STAR&size=1").path("nextCursor").asText();
        assertEquals(read(FEED + "?ticId=" + tic + "&size=1").path("nextCursor").asText(), cursor);
        for (String board : List.of("", "&board=STAR")) {
            var next = read(FEED + "?ticId=" + tic + board + "&size=1&cursor=" + cursor);
            assertEquals("p-" + first, next.path("items").get(0).path("id").asText());
            assertFalse(next.path("hasNext").asBoolean());
        }
        for (String query : List.of("ticId=" + tic + "&board=FREE",
                "ticId=" + tic + "&board=", "ticId=" + tic + "&board=star",
                "ticId=" + tic + "&board=STAR&board=STAR"))
            mvc.perform(get(FEED + "?" + query).session(session(member))).andExpect(status().isBadRequest());
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?", tic);
        mvc.perform(get(FEED + "?ticId=" + tic + "&board=STAR&size=20").session(session(member)))
                .andExpect(status().isNotFound());
    }

    @Test void 검색오류_빈값_중복_잘못된커서와범위_인증거절() throws Exception {
        var p = publications.publish(member, submit(3)); post(tic, "visible");
        String cursor = read(FEED + "?ticId=" + tic + "&size=1").path("nextCursor").asText();
        for (String query : List.of("q=", "searchIn=TITLE", "author=", "board=BAD", "tag=BAD", "sort=hot",
                "size=0", "size=101", "size=1.0", "size=", "size=1&size=1", "ticId=01", "ticId=", "ticId=-1",
                "ticId=9223372036854775808", "cursor=", "cursor=broken", "size=2&ticId=" + tic + "&cursor=" + cursor,
                "size=1&cursor=" + cursor)) {
            mvc.perform(get(FEED + "?" + query).session(session(member))).andExpect(status().isBadRequest());
        }
        mvc.perform(get(threadPath(p) + "/analyses?size=1&cursor=" + cursor).session(session(member))).andExpect(status().isBadRequest());
        for (String q : List.of("judgment=BAD", "judgment=", "judgment=UNSURE&judgment=UNSURE", "size=101", "q=x"))
            mvc.perform(get(threadPath(p) + "/analyses?" + q).session(session(member))).andExpect(status().isBadRequest());
        for (String q : List.of("graphMode=BAD", "graphMode=", "includeGraph=1", "includeGraph=", "graphMode=CURRENT&graphMode=SUBMITTED"))
            mvc.perform(get(publicPath(p) + "?" + q).session(session(member))).andExpect(status().isBadRequest());
        for (String path : List.of(FEED, threadPath(p), threadPath(p) + "/analyses", publicPath(p)))
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/signal-threads/st-01").session(session(member))).andExpect(status().isNotFound());
        jdbc.update("UPDATE users SET status='withdrawn' WHERE id=?", member);
        mvc.perform(get(FEED).session(session(member))).andExpect(status().isUnauthorized());
    }

    @Test void 공개게시판은_본인잠금과무관하며_미공개미발견은_목록과직접경로차단() throws Exception {
        var p = publications.publish(member, submit(3)); long post = post(tic, "visible");
        long history = jdbc.queryForObject("SELECT history_id FROM published_analyses WHERE id=?", Long.class,
                Long.parseLong(p.analysisId().substring(3)));
        jdbc.update("INSERT INTO post_history_attachments(post_id,history_id) VALUES (?,?)",post,history);
        long comment = jdbc.queryForObject("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'첨부','visible') RETURNING id",
                Long.class,Long.parseLong(p.threadId().substring(3)),member);
        jdbc.update("INSERT INTO comment_history_attachments(comment_id,history_id) VALUES (?,?)",comment,history);
        String postAttachment = "/api/v1/posts/p-" + post + "/history-attachments/h-" + history;
        String commentAttachment = "/api/v1/comments/c-" + comment + "/history-attachments/h-" + history;
        long other = member();
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id=? AND tic_id=?", Integer.class, other,tic));
        for (String path : List.of(FEED + "?ticId=" + tic, threadPath(p), threadPath(p) + "/analyses", publicPath(p),
                "/api/v1/posts/p-" + post, postAttachment, commentAttachment,
                "/api/v1/comments?parentType=SIGNAL_THREAD&parentId=" + p.threadId()))
            mvc.perform(get(path).session(session(other))).andExpect(status().isOk());
        // 미발견 별은 빈 목록이 아니라 접근 불가다. signed-64-bit 최대 TIC도 파싱 후 404다.
        mvc.perform(get(FEED + "?ticId=9223372036854775807").session(session(member))).andExpect(status().isNotFound());
        jdbc.update("DELETE FROM star_unlocks WHERE tic_id=?", tic);
        for (String path : List.of(FEED + "?ticId=" + tic, threadPath(p), threadPath(p) + "/analyses", publicPath(p),
                "/api/v1/posts/p-" + post, postAttachment, commentAttachment,
                "/api/v1/comments?parentType=SIGNAL_THREAD&parentId=" + p.threadId()))
            mvc.perform(get(path).session(session(other))).andExpect(status().isOk());
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        mvc.perform(get(publicPath(p) + "?includeGraph=false").session(session(other))).andExpect(status().isNotFound());
    }

    @Test void 과거목록_제출동률_대표판단과_필터독립통계_취소시복귀() throws Exception {
        String old = submit(3), recent = submit(3), privateHistory = submit(3);
        jdbc.update("UPDATE submissions SET created_at='2026-09-21T00:00:00.123456Z',user_judgment='UNSURE' WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", number(old));
        jdbc.update("UPDATE submissions SET created_at='2026-09-21T00:00:00.123456Z',user_judgment='LIKELY_PLANET' WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", number(recent));
        var latest = publications.publish(member, recent);
        var previous = publications.publish(member, old); // 과거 기록을 나중에 공개한다.
        var page = read(threadPath(latest) + "/analyses?size=1");
        assertEquals(latest.analysisId(), page.path("items").get(0).path("analysisId").asText());
        assertTrue(page.path("items").get(0).path("contributesToSummary").asBoolean());
        var next = read(threadPath(latest) + "/analyses?size=1&cursor=" + page.path("nextCursor").asText());
        assertEquals(previous.analysisId(), next.path("items").get(0).path("analysisId").asText());
        assertFalse(next.path("items").get(0).path("contributesToSummary").asBoolean());
        mvc.perform(get(threadPath(latest) + "/analyses?judgment=UNSURE&size=1&cursor=" + page.path("nextCursor").asText())
                .session(session(member))).andExpect(status().isBadRequest());
        var filtered = read(threadPath(latest) + "/analyses?judgment=UNSURE");
        assertEquals(1, filtered.path("items").size());
        assertFalse(filtered.path("items").get(0).path("contributesToSummary").asBoolean());
        assertEquals(1, filtered.path("judgmentSummary").path("participantCount").asInt());
        assertEquals(1, filtered.path("judgmentSummary").path("likelyPlanet").asInt());
        assertEquals(0, filtered.path("judgmentSummary").path("unsure").asInt());
        publications.visibility(member, latest.analysisId(), false);
        var restored = read(threadPath(latest) + "/analyses?judgment=UNSURE");
        assertTrue(restored.path("items").get(0).path("contributesToSummary").asBoolean());
        assertEquals(1, restored.path("judgmentSummary").path("unsure").asInt());
        publications.visibility(member, previous.analysisId(), false);
        var empty = read(threadPath(latest) + "/analyses");
        assertEquals(0, empty.path("items").size()); assertTrue(empty.path("nextCursor").isNull());
        assertFalse(empty.path("hasNext").asBoolean()); assertTrue(empty.path("judgmentSummary").path("percentages").isNull());
        assertEquals("SYSTEM", read(threadPath(latest)).path("author").path("type").asText());
        assertNotNull(histories.detail(member, privateHistory));
    }

    @Test void 부모숨김복원_개별숨김취소_토론수와공개경로() throws Exception {
        var cancelled = publications.publish(member, submit(3));
        var hidden = publications.publish(member, submit(3));
        var visible = publications.publish(member, submit(3));
        publications.visibility(member, cancelled.analysisId(), false);
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE id=?", Long.parseLong(hidden.analysisId().substring(3)));
        long thread = Long.parseLong(visible.threadId().substring(3));
        jdbc.update("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'토론','visible'),(?,?,'숨김','hidden')", thread,member,thread,member);
        assertEquals(1, read(threadPath(visible)).path("commentCount").asInt());
        assertEquals(1, read("/api/v1/comments?parentType=SIGNAL_THREAD&parentId=" + visible.threadId()).path("items").size());
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?", thread);
        for (String path : List.of(threadPath(visible), threadPath(visible) + "/analyses", publicPath(visible),
                "/api/v1/comments?parentType=SIGNAL_THREAD&parentId=" + visible.threadId()))
            mvc.perform(get(java.net.URI.create(path)).session(session(member))).andExpect(status().isNotFound());
        assertEquals(0, read(FEED + "?ticId=" + tic).path("items").size());
        jdbc.update("UPDATE posts SET status='visible' WHERE id=?", thread);
        assertEquals(1, read(threadPath(visible) + "/analyses").path("items").size());
        for (var blocked : List.of(cancelled, hidden))
            for (String graph : List.of("true", "false"))
                mvc.perform(get(publicPath(blocked) + "?includeGraph=" + graph).session(session(member))).andExpect(status().isNotFound());
        read(publicPath(visible));
    }

    @Test void 공개상세_허용필드_그래프두모드_503내용분리_캐시접근철회() throws Exception {
        String history = submit(3);
        var p = publications.publish(member, history); long other = member();
        String body = mvc.perform(get(publicPath(p)).session(session(other))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.judgment").value("LIKELY_PLANET"))
                .andExpect(jsonPath("$.firstPublishedAt").exists()).andExpect(jsonPath("$.original.periodDays").exists())
                .andReturn().getResponse().getContentAsString();
        for (String key : List.of("submissionId", "requestId", "viewState", "answerViewed", "achievementResult", "retryOfSubmissionId", "skyVersion"))
            assertFalse(body.contains('"' + key + '"'), key);
        mvc.perform(get("/api/v1/histories/" + history).session(session(other))).andExpect(status().isForbidden());
        assertEquals(150, read(publicPath(p) + "?graphMode=SUBMITTED").path("graph").path("snapshot").path("bins").asInt());
        doReturn(false).when(historyRepository).stillCurrent(anyLong(), anyLong());
        mvc.perform(get(publicPath(p)).session(session(other))).andExpect(status().isServiceUnavailable());
        assertTrue(read(publicPath(p) + "?includeGraph=false").path("graph").isNull());
        doCallRealMethod().when(historyRepository).stillCurrent(anyLong(), anyLong());
        // CURRENT 계산 도중 취소를 커밋한다. 이미 읽은 내용과 캐시가 있어도 반환하지 않는다.
        doAnswer(call -> {
            var tx = new TransactionTemplate(transactions);
            tx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            tx.executeWithoutResult(s -> jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE id=?", Long.parseLong(p.analysisId().substring(3))));
            return call.callRealMethod();
        }).when(gold).findSegments(any());
        mvc.perform(get(publicPath(p)).session(session(other))).andExpect(status().isNotFound());
    }

    @Test void 목록과통계는_동일스냅샷_동시취소는_다음요청부터반영() throws Exception {
        var p = publications.publish(member, submit(3));
        doAnswer(call -> {
            var tx = new TransactionTemplate(transactions);
            tx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            tx.executeWithoutResult(s -> jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE id=?", Long.parseLong(p.analysisId().substring(3))));
            return call.callRealMethod();
        }).when(summaryRepository).statistics(org.mockito.ArgumentMatchers.eq(candidate), any());
        var same = read(threadPath(p) + "/analyses");
        assertEquals(1, same.path("items").size());
        assertTrue(same.path("items").get(0).path("contributesToSummary").asBoolean());
        assertEquals(1, same.path("judgmentSummary").path("participantCount").asInt());
        var next = read(threadPath(p) + "/analyses");
        assertEquals(0, next.path("items").size()); assertEquals(0, next.path("judgmentSummary").path("participantCount").asInt());
    }

    @Test void 공개잔차캐시_job비노출_당시스냅샷없음_별닫힘반환직전차단() throws Exception {
        String history = submit(3);
        var p = publications.publish(member, history);
        jdbc.update("UPDATE submissions SET removed_candidate_ids=ARRAY[?]::bigint[],curve_step=1 WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)", candidate,number(history));
        mvc.perform(get(publicPath(p)).session(session(member))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.reproduction.fallbackReason").value("RESIDUAL_NOT_AVAILABLE"));
        Float[] cached = new Float[4320]; Arrays.fill(cached, .99f);
        when(residuals.lookup(anyLong(), any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED", "private-job", null,
                java.util.Map.of(segment,cached), null));
        mvc.perform(get(publicPath(p)).session(session(member))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.curve.curveContext.curveStep").value(1))
                .andExpect(jsonPath("$.graph.curve.residual.jobId").isEmpty());
        doReturn(java.util.Optional.empty()).when(historyRepository).snapshot(number(history));
        mvc.perform(get(publicPath(p)).param("graphMode", "SUBMITTED").session(session(member))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.curve").isEmpty()).andExpect(jsonPath("$.graph.snapshot").isEmpty());
        doAnswer(call -> {
            var tx = new TransactionTemplate(transactions);
            tx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            tx.executeWithoutResult(s -> jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?", tic));
            return call.callRealMethod();
        }).when(gold).findSegments(any());
        mvc.perform(get(publicPath(p)).session(session(member))).andExpect(status().isNotFound());
        // 개인·공개 그래프의 캐시가 있어도 닫힌 별은 전체 피드에도 남지 않는다.
        for (var item : read(FEED).path("items")) assertNotEquals(p.threadId(), item.path("id").asText());
    }

    @Test void 공통검색표본을_실제HTTP와DB에_대조() throws Exception {
        var data = JSON.readTree(java.nio.file.Files.readString(java.nio.file.Path.of("../../docs/api/community/search-cases.json")));
        jdbc.update("UPDATE posts SET status='hidden'"); // 이 클래스의 일회용 DB만 격리한다.
        long other = member();
        jdbc.update("UPDATE users SET nickname='Orbit' WHERE id=?", member);
        jdbc.update("UPDATE users SET nickname='관측자' WHERE id=?", other);
        int ordinal=1;
        for (long star : List.of(123456789L, 9007199254740993L)) {
            jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')", star);
            var position = layout.place(ordinal);
            jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,world_x,world_y,layout_version,layout_ordinal,unlocked_at) VALUES (?,?,'tutorial',?,?,?,?,?,now())",
                    member,star,position.depthZ(),position.worldX(),position.worldY(),position.layoutVersion(),ordinal++);
        }
        var ids = new java.util.HashMap<String,String>();
        for (var p : data.path("posts")) {
            Long star = p.path("ticId").isNull() ? null : Long.parseLong(p.path("ticId").asText());
            Long signal = null;
            boolean system = p.path("kind").asText().equals("system_thread");
            if (system) signal = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id", Long.class,star,bundle);
            long id = jdbc.queryForObject("INSERT INTO posts(kind,user_id,candidate_id,board,tic_id,tag,title,body,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?::timestamptz) RETURNING id", Long.class,
                    p.path("kind").asText(),system ? null : p.path("memberId").asText().equals("u-1") ? member : other,
                    signal,p.path("board").asText().toLowerCase(java.util.Locale.ROOT),star,p.path("tag").isNull() ? null : p.path("tag").asText(),
                    p.path("title").asText(),p.path("body").asText(),p.path("status").asText(),p.path("createdAt").asText());
            ids.put(p.path("id").asText(), (system ? "st-" : "p-") + id);
        }
        for (var c : data.path("cases")) {
            var request = get(FEED).session(session(member));
            for (var pair : c.path("query")) request.param(pair.get(0).asText(),pair.get(1).asText());
            var result = mvc.perform(request).andExpect(status().is(c.has("expectedError") ? 400 : 200));
            if (c.has("expectedError")) result.andExpect(jsonPath("$.code").value(c.path("expectedError").asText()));
            else {
                var body = JSON.readTree(result.andReturn().getResponse().getContentAsString());
                var expected = new java.util.ArrayList<String>();
                c.path("expectedIds").forEach(id -> expected.add(ids.get(id.asText())));
                assertEquals(expected, feedIds(body), c.path("id").asText());
                assertFalse(body.path("hasNext").asBoolean()); assertTrue(body.path("nextCursor").isNull());
            }
        }
        String cursor = null;
        for (var expectedPage : data.path("pages").get(0).path("expectedPages")) {
            var request = get(FEED).param("size","2").session(session(member));
            if (cursor != null) request.param("cursor",cursor);
            var page = JSON.readTree(mvc.perform(request).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
            var expected = new java.util.ArrayList<String>(); expectedPage.forEach(id -> expected.add(ids.get(id.asText())));
            assertEquals(expected,feedIds(page)); cursor=page.path("nextCursor").asText();
        }
        jdbc.update("UPDATE users SET nickname='NewOrbit' WHERE id=?",member);
        assertEquals(List.of(),feedIds(read(FEED + "?author=Orbit")));
        assertEquals(List.of(ids.get("p-101")),feedIds(read(FEED + "?author=neworbit")));
    }

    java.util.List<String> feedIds(tools.jackson.databind.JsonNode body) {
        var ids = new java.util.ArrayList<String>(); body.path("items").forEach(i -> ids.add(i.path("id").asText())); return ids;
    }

    @Test void 검색커서_구분자와_모든필터결속_마이크로초_권한재검사() throws Exception {
        jdbc.update("UPDATE users SET nickname=? WHERE id=?", "Cursor" + member, member);
        long a=post(tic,"visible"), b=post(tic,"visible"), c=post(tic,"visible");
        jdbc.update("UPDATE posts SET title='a|b %_\\',body='a|b',created_at='2026-09-21T00:00:00.123456Z' WHERE id IN (?,?,?)",a,b,c);
        jdbc.update("UPDATE posts SET created_at='2026-09-21T00:00:00.123457Z' WHERE id=?",a);
        var params = new org.springframework.util.LinkedMultiValueMap<String,String>();
        params.set("q","a|b");params.set("searchIn","TITLE");params.set("author","Cursor"+member);
        params.set("ticId",""+tic);params.set("board","STAR");params.set("tag","GENERAL");params.set("size","1");
        var first=JSON.readTree(mvc.perform(get(FEED).params(params).session(session(member))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertEquals(List.of("p-"+a),feedIds(first));
        String cursor=first.path("nextCursor").asText();
        for (String key : List.of("q","searchIn","author","ticId","board","tag","size")) {
            var changed=new org.springframework.util.LinkedMultiValueMap<>(params);changed.set("cursor",cursor);
            changed.set(key,switch(key){case "q" -> "a";case "searchIn" -> "BODY";case "author" -> "other";case "ticId" -> ""+(tic+1);case "board" -> "FREE";case "tag" -> "QUESTION";default -> "2";});
            mvc.perform(get(FEED).params(changed).session(session(member))).andExpect(status().isBadRequest());
        }
        for (String path : List.of("/api/v1/community/hot-topics", "/api/v1/signal-threads/st-1/analyses"))
            mvc.perform(get(path).param("size","1").param("cursor",cursor).session(session(member))).andExpect(status().isBadRequest());
        params.set("cursor",cursor);params.set("q","\u00a0a|b\ufeff");params.remove("board");
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",c);post(tic,"visible");
        var second=JSON.readTree(mvc.perform(get(FEED).params(params).session(session(member))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertEquals(List.of("p-"+b),feedIds(second));assertFalse(second.path("hasNext").asBoolean());
        params.set("cursor",cursor+"=");
        mvc.perform(get(FEED).params(params).session(session(member))).andExpect(status().isBadRequest());
        params.set("cursor",cursor);jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        mvc.perform(get(FEED).params(params).session(session(member))).andExpect(status().isNotFound());
        assertTrue(feedIds(read(FEED+"?q=a%7Cb")).stream().noneMatch(id -> List.of("p-"+a,"p-"+b,"p-"+c).contains(id)));
    }

    @Test void 코드포인트_공백_리터럴_입력경계() throws Exception {
        long id=post(tic,"visible");
        jdbc.update("UPDATE posts SET title=?,body=? WHERE id=?", "🪐".repeat(100),"x' OR 1=1 -- a|b %_ \\",id);
        for (String q : List.of("🪐".repeat(100),"x' OR 1=1 --","%_","\\","a|b")) {
            var result=JSON.readTree(mvc.perform(get(FEED).param("q",q).param("ticId",""+tic).session(session(member)))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
            assertEquals(List.of("p-"+id),feedIds(result));
        }
        for (String q : List.of("🪐".repeat(101),"한".repeat(101),"\u00a0\ufeff\u202f","a\0b"))
            mvc.perform(get(FEED).param("q",q).session(session(member))).andExpect(status().isBadRequest());
        // author는 생성 검증이 아니라 조회 값이다. 예약명·부분명·긴 값도 불일치면 빈 목록이다.
        for (String author : List.of("SYSTEM","a","a".repeat(1000),"%_")) {
            var result=JSON.readTree(mvc.perform(get(FEED).param("author",author).session(session(member)))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
            assertTrue(feedIds(result).isEmpty());
        }
    }

    @Test void 공식요약_생성_후보수치변경_역할_비공개메모제외() throws Exception {
        var p=publications.publish(member,submit(3));long id=Long.parseLong(p.threadId().substring(3));
        assertEquals("주기 3 일 · 기준 시각 100.3 BTJD · 지속시간 2.4 시간 · 깊이 1000 ppm",jdbc.queryForObject("SELECT body FROM posts WHERE id=?",String.class,id));
        assertEquals(List.of(p.threadId()),feedIds(read(FEED+"?ticId="+tic+"&q=1000%20ppm&searchIn=BODY")));
        assertTrue(feedIds(read(FEED+"?ticId="+tic+"&q=공개%20메모")).isEmpty());
        var before=jdbc.queryForMap("SELECT status,created_at FROM posts WHERE id=?",id);
        new TransactionTemplate(transactions).executeWithoutResult(s -> {
            jdbc.execute("SET LOCAL ROLE planetory_gold_writer");
            jdbc.update("UPDATE candidates SET depth_ppm=1200.5000 WHERE id=?",candidate);
            jdbc.execute("RESET ROLE");
        });
        assertEquals(before,jdbc.queryForMap("SELECT status,created_at FROM posts WHERE id=?",id));
        assertEquals(List.of(p.threadId()),feedIds(read(FEED+"?ticId="+tic+"&q=1200.5%20ppm&searchIn=BODY")));
        assertTrue(feedIds(read(FEED+"?ticId="+tic+"&q=1000%20ppm&searchIn=BODY")).isEmpty());
        publications.visibility(member,p.analysisId(),false);
        assertEquals(List.of(p.threadId()),feedIds(read(FEED+"?ticId="+tic+"&q=1200.5%20ppm")));
        var emptySummary=read(FEED+"?ticId="+tic+"&q=1200.5%20ppm").path("items").get(0).path("judgmentSummary");
        assertEquals("public_analyses",emptySummary.path("kind").asText());
        assertEquals("c-"+candidate,emptySummary.path("candidateId").asText());
        for(String key:List.of("participantCount","likelyPlanet","unlikelyPlanet","unsure")) assertEquals(0,emptySummary.path(key).asInt());
        assertTrue(emptySummary.path("percentages").isNull());assertTrue(emptySummary.hasNonNull("asOf"));
        assertEquals(1200.5,read(threadPath(p)).path("signal").path("depthPpm").asDouble());
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",id);
        jdbc.update("UPDATE candidates SET depth_ppm=2E-7 WHERE id=?",candidate);
        assertTrue(jdbc.queryForObject("SELECT body FROM posts WHERE id=?",String.class,id).endsWith("0.0000002 ppm"));
        assertTrue(feedIds(read(FEED+"?ticId="+tic+"&q=ppm")).isEmpty());
        var params=new org.springframework.util.LinkedMultiValueMap<String,String>();params.set("q","ppm");
        new TransactionTemplate(transactions).executeWithoutResult(s -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            assertTrue(community.feed(member,com.planetory.backend.domain.post.service.CommunityQuery.feed(params)).items().stream().noneMatch(i -> i.id().equals(p.threadId())));
            jdbc.execute("RESET ROLE");
        });
    }

    @Test void 후보갱신_이전스냅샷뒤_생긴스레드_갱신또는격리오류롤백() throws Exception {
        for (int isolation : List.of(java.sql.Connection.TRANSACTION_READ_COMMITTED,
                java.sql.Connection.TRANSACTION_REPEATABLE_READ, java.sql.Connection.TRANSACTION_SERIALIZABLE)) {
            long signal=jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",Long.class,tic,bundle);
            try(var writer=java.sql.DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());
                var statement=writer.createStatement()) {
                writer.setTransactionIsolation(isolation);writer.setAutoCommit(false);
                statement.execute("SET LOCAL ROLE planetory_gold_writer");
                // 이 스냅샷에는 아직 공식 스레드가 없다. 다음 INSERT는 다른 연결에서 커밋한다.
                try(var result=statement.executeQuery("SELECT depth_ppm FROM candidates WHERE id="+signal)) { assertTrue(result.next()); }
                jdbc.update("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'격리 검사','','visible')",signal,tic);
                String update="UPDATE candidates SET depth_ppm=987.6 WHERE id="+signal;
                if(isolation==java.sql.Connection.TRANSACTION_READ_COMMITTED) {
                    assertEquals(1,statement.executeUpdate(update));writer.commit();
                } else {
                    var failure=assertThrows(java.sql.SQLException.class,()->statement.executeUpdate(update));
                    assertEquals("25000",failure.getSQLState());
                    assertTrue(failure.getMessage().contains("READ COMMITTED"));writer.rollback();
                }
            }
            String expected=isolation==java.sql.Connection.TRANSACTION_READ_COMMITTED?"987.6":"1000";
            assertEquals(expected,jdbc.queryForObject("SELECT trim_scale(depth_ppm)::text FROM candidates WHERE id=?",String.class,signal));
            assertTrue(jdbc.queryForObject("SELECT body FROM posts WHERE candidate_id=?",String.class,signal).endsWith(expected+" ppm"));
        }
    }

    @Test void 후보갱신과_공식최초생성_양방향경합() throws Exception {
        for (boolean insertFirst : List.of(false,true)) {
            long signal=jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",Long.class,tic,bundle);
            String insert="INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',"+signal+",'star',"+tic+",'경합','','visible')";
            String update="UPDATE candidates SET depth_ppm=987.600 WHERE id="+signal;
            try(var first=java.sql.DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());
                var second=java.sql.DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());
                var pool=java.util.concurrent.Executors.newSingleThreadExecutor()) {
                first.setAutoCommit(false);
                first.createStatement().execute(insertFirst?insert:update);
                int pid;
                try(var statement=second.createStatement();var result=statement.executeQuery("SELECT pg_backend_pid()")) {
                    result.next();pid=result.getInt(1);
                }
                var waiting=pool.submit(()->second.createStatement().execute(insertFirst?update:insert));
                try {
                    long until=System.nanoTime()+java.time.Duration.ofSeconds(5).toNanos();
                    boolean blocked=false;
                    while(System.nanoTime()<until) {
                        if(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=? AND wait_event_type='Lock')",Boolean.class,pid)){blocked=true;break;}
                        java.util.concurrent.locks.LockSupport.parkNanos(10_000_000);
                    }
                    assertTrue(blocked,"공식 생성과 후보 갱신은 행 잠금에서 직렬화돼야 한다");
                } finally { first.commit(); }
                waiting.get(5,java.util.concurrent.TimeUnit.SECONDS);
            }
            assertTrue(jdbc.queryForObject("SELECT body FROM posts WHERE candidate_id=?",String.class,signal).endsWith("987.6 ppm"));
        }
    }

    @Test void V18기존공식본문_채움과_재실행_롤백() throws Exception {
        String schema="search_"+UUID.randomUUID().toString().replace("-", "");
        var previous=org.flywaydb.core.Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword())
                .schemas(schema).locations("classpath:db/migration").target("18").load();
        previous.migrate();
        // 현재 테스트 후보의 공개 네 수치와 최소 FK만 새 격리 스키마에 복사한다.
        jdbc.execute("INSERT INTO "+schema+".stars(tic_id,teff_k,radius_rsun,tmag,confirmed_count,service_status) "
                +"SELECT tic_id,teff_k,radius_rsun,tmag,confirmed_count,service_status FROM public.stars WHERE tic_id="+tic);
        jdbc.execute("INSERT INTO "+schema+".publication_bundles SELECT * FROM public.publication_bundles WHERE id="+bundle);
        jdbc.execute("INSERT INTO "+schema+".candidates SELECT * FROM public.candidates WHERE id="+candidate);
        jdbc.execute("INSERT INTO "+schema+".users SELECT * FROM public.users WHERE id="+member);
        jdbc.update("INSERT INTO "+schema+".posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'공식','','hidden')",candidate,tic);
        jdbc.update("INSERT INTO "+schema+".posts(kind,user_id,board,title,body,status) VALUES ('user',?,'free','일반','유지','visible')",member);
        var before=jdbc.queryForMap("SELECT status,created_at FROM "+schema+".posts WHERE kind='system_thread'");
        var upgraded=org.flywaydb.core.Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword())
                .schemas(schema).locations("classpath:db/migration").target("19").load();
        assertEquals(1,upgraded.migrate().migrationsExecuted);upgraded.validate();assertEquals(0,upgraded.migrate().migrationsExecuted);
        String body=jdbc.queryForObject("SELECT body FROM "+schema+".posts WHERE kind='system_thread'",String.class);
        assertEquals("주기 3 일 · 기준 시각 100.3 BTJD · 지속시간 2.4 시간 · 깊이 1000 ppm",body);
        assertEquals(before,jdbc.queryForMap("SELECT status,created_at FROM "+schema+".posts WHERE kind='system_thread'"));
        assertEquals("유지",jdbc.queryForObject("SELECT body FROM "+schema+".posts WHERE kind='user'",String.class));
        new TransactionTemplate(transactions).executeWithoutResult(s -> {
            jdbc.update("UPDATE "+schema+".candidates SET period_days=7 WHERE id=?",candidate);s.setRollbackOnly();
        });
        assertEquals(body,jdbc.queryForObject("SELECT body FROM "+schema+".posts WHERE kind='system_thread'",String.class));
        assertEquals("주기 미정 일 · 기준 시각 미정 BTJD · 지속시간 미정 시간 · 깊이 미정 ppm",
                jdbc.queryForObject("SELECT "+schema+".official_signal_summary(NULL,NULL,NULL,NULL)",String.class));
    }

    @org.junit.jupiter.api.Tag("perf")
    @Test void 검색_실제SQL_10만행_3회_실행계획() throws Exception {
        jdbc.execute("INSERT INTO users(provider,provider_user_id,nickname) SELECT 'perf',g::text,'Perf'||g FROM generate_series(0,99) g");
        jdbc.update("""
                INSERT INTO posts(kind,user_id,board,tic_id,tag,title,body,status,created_at)
                SELECT 'user',u.id,CASE WHEN g%3=0 THEN 'free' ELSE 'star' END,
                    CASE WHEN g%3=0 THEN NULL WHEN g%7=0 THEN ? ELSE ? END,
                    CASE WHEN g%4=0 THEN 'QUESTION' ELSE 'GENERAL' END,
                    CASE WHEN g%2000=0 THEN 'spectrumrare' ELSE '관측 '||g END,
                    CASE WHEN g%2000=1 THEN 'spectrumrare ' ELSE '' END ||
                    CASE WHEN g%5<3 THEN '관측 빛 ' ELSE '기록 ' END || repeat(md5(g::text),8+g%40),
                    CASE WHEN g%31=0 THEN 'hidden' WHEN g%47=0 THEN 'deleted' ELSE 'visible' END,
                    '2026-09-21T00:00:00Z'::timestamptz + g*interval '1 microsecond'
                FROM generate_series(1,100000) g JOIN users u ON u.provider='perf' AND u.provider_user_id=(g%100)::text
                """,tic+1000000000,tic);
        jdbc.update("INSERT INTO comments(post_id,user_id,body,status) SELECT p.id,?,'합성 댓글','visible' FROM posts p WHERE p.id%10=0",member);
        for (String table : List.of("posts","users","stars","star_unlocks","comments")) jdbc.execute("ANALYZE "+table);
        var output=new StringBuilder("# 169 실제 검색 SQL 실행 계획\n\n");
        output.append(jdbc.queryForObject("SELECT version()",String.class)).append('\n');
        output.append(jdbc.queryForMap("SELECT datcollate,datctype FROM pg_database WHERE datname=current_database()")).append('\n');
        output.append(jdbc.queryForMap("SELECT count(*) AS rows,min(length(body)) AS min_body,max(length(body)) AS max_body,avg(length(body)) AS avg_body FROM posts")).append('\n');
        output.append(jdbc.queryForList("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('posts','users','comments')")).append("\n\n");
        var captured=new java.util.concurrent.atomic.AtomicReference<String>();
        doAnswer(call -> { String sql=call.getArgument(0);if(sql.contains("SELECT p.id,p.kind"))captured.set(sql);return call.callRealMethod(); }).when(feedJdbc).sql(any(String.class));
        var scenarios=List.of(
                java.util.Map.of("q","spectrumrare","searchIn","TITLE"),
                java.util.Map.of("q","spectrumrare","searchIn","BODY"),
                java.util.Map.of("q","spectrumrare"),java.util.Map.of("q","빛"),java.util.Map.of("q","관측"),
                java.util.Map.of("q","관측","ticId",""+tic,"board","STAR","tag","QUESTION"),
                java.util.Map.of("author","Perf0"),java.util.Map.of("q","관측","page","next"));
        for (var input : scenarios) {
            var params=new org.springframework.util.LinkedMultiValueMap<String,String>();input.forEach((k,v)->{if(!k.equals("page"))params.set(k,v);});
            var q=com.planetory.backend.domain.post.service.CommunityQuery.feed(params);
            var result=community.feed(member,q);
            if(input.containsKey("page")){params.set("cursor",result.nextCursor());q=com.planetory.backend.domain.post.service.CommunityQuery.feed(params);community.feed(member,q);}
            String sql=captured.get();assertNotNull(sql);
            var binds=new org.springframework.jdbc.core.namedparam.MapSqlParameterSource()
                    .addValue("tic",q.target()).addValue("at",q.afterAt()).addValue("id",q.afterId()).addValue("limit",q.size()+1)
                    .addValue("pattern","%"+input.getOrDefault("q","")+"%").addValue("author",input.get("author"))
                    .addValue("board","star").addValue("tag",input.get("tag"));
            output.append("## ").append(input).append("\n```sql\n").append(sql).append("\n```\n");
            var named=new org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate(jdbc);
            String count=sql.substring(sql.indexOf("FROM posts"),sql.indexOf("ORDER BY p.created_at"));
            output.append("matched rows: ").append(named.queryForObject("SELECT count(*) "+count,binds,Long.class)).append('\n');
            for(int run=1;run<=3;run++)output.append("### run ").append(run).append("\n```text\n")
                    .append(String.join("\n",named.queryForList("EXPLAIN (ANALYZE,BUFFERS,SETTINGS) "+sql,binds,String.class))).append("\n```\n");
        }
        java.nio.file.Files.writeString(java.nio.file.Path.of("build/search-performance.md"),output);
    }

    @Test void 앱역할_읽기트랜잭션_통계계약_성과진행불변() {
        var p = publications.publish(member, submit(3));
        String before = jdbc.queryForObject("SELECT row_to_json(u)::text FROM user_star_progress u WHERE user_id=? AND tic_id=?", String.class, member,tic);
        var tx = new TransactionTemplate(transactions);
        tx.setReadOnly(true); tx.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        tx.executeWithoutResult(s -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            assertEquals(1, community.feed(member, feedQuery()).items().size());
            assertEquals(1L, community.thread(member, Long.parseLong(p.threadId().substring(3))).judgmentSummary().get("participantCount"));
            assertEquals(1, community.analyses(member, analysisQuery(p)).items().size());
            publicAccess.check(member, Long.parseLong(p.analysisId().substring(3)),
                    jdbc.queryForObject("SELECT history_id FROM published_analyses WHERE id=?", Long.class, Long.parseLong(p.analysisId().substring(3))));
        });
        assertEquals(before, jdbc.queryForObject("SELECT row_to_json(u)::text FROM user_star_progress u WHERE user_id=? AND tic_id=?", String.class, member,tic));
    }
}
