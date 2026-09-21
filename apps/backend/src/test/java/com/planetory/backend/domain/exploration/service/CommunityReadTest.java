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
    @MockitoSpyBean HistoryRepository historyRepository;
    @MockitoSpyBean SubmissionRepository summaryRepository;

    private static final tools.jackson.databind.json.JsonMapper JSON = tools.jackson.databind.json.JsonMapper.builder().build();
    private static final String FEED = "/api/v1/community/feed";
    String threadPath(PublicAnalysisService.Published p) { return "/api/v1/signal-threads/" + p.threadId(); }
    String publicPath(PublicAnalysisService.Published p) { return "/api/v1/public-analyses/" + p.analysisId(); }
    tools.jackson.databind.JsonNode read(String path) throws Exception {
        return JSON.readTree(mvc.perform(get(path).session(session(member))).andExpect(status().isOk())
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
        for (String query : List.of("board=STAR", "board=FREE", "ticId=" + tic + "&board=FREE",
                "ticId=" + tic + "&board=", "ticId=" + tic + "&board=star",
                "ticId=" + tic + "&board=STAR&board=STAR", "ticId=" + tic + "&board=STAR&q=x"))
            mvc.perform(get(FEED + "?" + query).session(session(member))).andExpect(status().isBadRequest());
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?", tic);
        mvc.perform(get(FEED + "?ticId=" + tic + "&board=STAR&size=20").session(session(member)))
                .andExpect(status().isNotFound());
    }

    @Test void 미지원검색_빈값_중복_잘못된커서와범위_인증거절() throws Exception {
        var p = publications.publish(member, submit(3)); post(tic, "visible");
        String cursor = read(FEED + "?ticId=" + tic + "&size=1").path("nextCursor").asText();
        for (String query : List.of("q=x", "searchIn=TITLE", "author=x", "board=STAR", "tag=GENERAL", "sort=hot",
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
        for (var item : read(FEED).path("items")) {
            assertNotEquals(p.threadId(), item.path("id").asText());
            assertNotEquals("p-" + post, item.path("id").asText());
        }
        for (String path : List.of(FEED + "?ticId=" + tic, threadPath(p), threadPath(p) + "/analyses", publicPath(p),
                "/api/v1/posts/p-" + post, postAttachment, commentAttachment,
                "/api/v1/comments?parentType=SIGNAL_THREAD&parentId=" + p.threadId()))
            mvc.perform(get(path).session(session(other))).andExpect(status().isNotFound());
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
            mvc.perform(get(path).session(session(member))).andExpect(status().isNotFound());
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
