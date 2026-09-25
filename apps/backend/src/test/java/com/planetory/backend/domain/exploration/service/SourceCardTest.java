package com.planetory.backend.domain.exploration.service;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
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
class SourceCardTest {
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


    private static final tools.jackson.databind.json.JsonMapper JSON = tools.jackson.databind.json.JsonMapper.builder().build();
    @MockitoSpyBean com.planetory.backend.domain.post.service.SourceLinkService sources;
    @MockitoSpyBean org.springframework.jdbc.core.simple.JdbcClient sourceJdbc;
    @Autowired com.planetory.backend.domain.comment.service.CommentService comments;
    @Autowired com.planetory.backend.domain.post.service.PostService posts;
    @MockitoSpyBean SubmissionRepository summaryRepository;
    String link(String type, String id) { return "{\"type\":\""+type+"\",\"id\":\""+id+"\"}"; }
    String links(PublicAnalysisService.Published p) { return "["+link("PUBLIC_ANALYSIS",p.analysisId())+","+link("SIGNAL_THREAD",p.threadId())+"]"; }
    org.springframework.test.web.servlet.ResultActions create(long owner,String refs, String star) throws Exception {
        return mvc.perform(post("/api/v1/posts").session(session(owner)).with(csrf()).contentType("application/json")
                .content("{\"title\":\"출처 글\",\"body\":\"본문\",\"purposeTag\":\"GENERAL\",\"ticId\":"+star+",\"sourceLinks\":"+refs+"}"));
    }
    String create(String refs) throws Exception { return create(member, refs); }
    String create(long owner, String refs) throws Exception {
        return JSON.readTree(create(owner, refs, "\""+tic+"\"").andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("postId").asText();
    }
    org.springframework.test.web.servlet.ResultActions patchPost(String post, String body) throws Exception { return patchPost(member, post, body); }
    org.springframework.test.web.servlet.ResultActions patchPost(long owner, String post, String body) throws Exception {
        return mvc.perform(patch("/api/v1/posts/"+post).session(session(owner)).with(csrf()).contentType("application/json").content(body));
    }
    /** 다른 스레드의 새 트랜잭션에서 공개를 취소한다. 호출 트랜잭션의 잠금을 기다리면 10초 뒤 실패한다. 풀 close()는 막힌 작업을 끝없이 기다리므로 쓰지 않는다. */
    void cancel(long owner, String analysis) {
        java.util.concurrent.CompletableFuture.runAsync(() -> publications.visibility(owner,analysis,false))
                .orTimeout(10,java.util.concurrent.TimeUnit.SECONDS).join();
    }
    tools.jackson.databind.JsonNode read(String path) throws Exception {
        return JSON.readTree(mvc.perform(get(path).session(session(member))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control",org.hamcrest.Matchers.containsString("no-store"))).andReturn().getResponse().getContentAsString());
    }
    String preview(String type, String id) { return "/api/v1/source-cards?type="+type+"&id="+id+"&ticId="+tic; }
    String comment(String post,String refs) throws Exception {
        return JSON.readTree(mvc.perform(post("/api/v1/comments").session(session(member())).with(csrf()).contentType("application/json")
                .content("{\"parentType\":\"POST\",\"parentId\":\""+post+"\",\"body\":\"댓글\",\"sourceLinks\":"+refs+"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("commentId").asText();
    }
    String snapshot() {
        return jdbc.queryForObject("SELECT json_build_array((SELECT json_agg(row_to_json(x)) FROM published_analyses x),(SELECT json_agg(row_to_json(x)) FROM user_candidate_achievements x),(SELECT json_agg(row_to_json(x)) FROM post_reactions x))::text",String.class);
    }
    @Test void 글댓글_미리보기_공개출처연결_원본성과통계불변() throws Exception {
        var published=publications.publish(member,submit(3));
        String before=snapshot();
        var analysis=read(preview("PUBLIC_ANALYSIS",published.analysisId()));
        assertEquals("u-"+member,analysis.path("author").path("memberId").asText());
        assertFalse(analysis.has("historyId")); assertFalse(analysis.has("memo")); assertFalse(analysis.has("graph"));
        var thread=read(preview("SIGNAL_THREAD",published.threadId()));
        assertEquals(1,thread.path("judgmentSummary").path("participantCount").asInt());
        assertEquals(3,thread.path("signal").path("periodDays").asInt());
        String post=create(links(published));
        comment(post,links(published));
        assertEquals(2,read("/api/v1/posts/"+post).path("sourceLinks").size());
        assertEquals(2,read("/api/v1/comments?parentType=POST&parentId="+post).path("items").get(0).path("sourceLinks").size());
        patchPost(post,"{\"sourceLinks\":[]}").andExpect(status().isOk()).andExpect(jsonPath("$.sourceLinks").isEmpty());
        assertEquals(before,snapshot());
        assertEquals(thread.path("judgmentSummary").path("participantCount"),read(preview("SIGNAL_THREAD",published.threadId())).path("judgmentSummary").path("participantCount"));
    }
    @Test void 입력상한_중복_null_잘못된타입_생략_자유게시판_타인원본거절() throws Exception {
        var p=publications.publish(member,submit(3));
        String source=link("PUBLIC_ANALYSIS",p.analysisId());
        for (String invalid:List.of("null","{}","[null]","["+source+","+source+"]","["+source+","+source+","+source+","+source+"]",
                "["+link("HISTORY","h-1")+"]","["+link("PUBLIC_ANALYSIS","h-1")+"]","["+link("SIGNAL_THREAD","st-9223372036854775808")+"]"))
            create(member,invalid,"\""+tic+"\"").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        create(member,"["+source+"]","null").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TIC_MISMATCH"));
        create(member(),"["+source+"]","\""+tic+"\"").andExpect(status().isCreated());
        mvc.perform(get(preview("PUBLIC_ANALYSIS",p.analysisId())).param("ticId","1").session(session(member))).andExpect(status().isBadRequest());
        mvc.perform(get(preview("PUBLIC_ANALYSIS","pa-999999999")).session(session(member))).andExpect(status().isNotFound());
        String post=create("[]");
        patchPost(post,"{\"sourceLinks\":null}").andExpect(status().isBadRequest());
        patchPost(post,"{\"body\":\"본문만\"}").andExpect(status().isOk());
        mvc.perform(get(preview("PUBLIC_ANALYSIS",p.analysisId()))).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/posts").session(session(member)).contentType("application/json").content("{}"))
                .andExpect(status().isForbidden());
    }
    @Test void 취소숨김_대체안내_ID와내용없음_본문수정유지_명시해제() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create(links(p)); comment(post,links(p));
        publications.visibility(member,p.analysisId(),false);
        var unavailable=read("/api/v1/posts/"+post).path("sourceLinks").get(0);
        assertEquals(JSON.readTree("{\"type\":\"PUBLIC_ANALYSIS\",\"available\":false}"),unavailable);
        patchPost(post,"{\"body\":\"본문 수정\"}").andExpect(status().isOk()).andExpect(jsonPath("$.sourceLinks.length()").value(2));
        assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM post_source_links WHERE post_id=?",Integer.class,number(post)));
        create(member,links(p),"\""+tic+"\"").andExpect(status().isNotFound());
        mvc.perform(get(preview("PUBLIC_ANALYSIS",p.analysisId())).session(session(member))).andExpect(status().isNotFound());
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",Long.parseLong(p.threadId().substring(3)));
        var hidden=read("/api/v1/comments?parentType=POST&parentId="+post).path("items").get(0).path("sourceLinks");
        for (var item:hidden) { assertEquals(2,item.size()); assertFalse(item.path("available").asBoolean()); }
        jdbc.update("UPDATE posts SET status='visible' WHERE id=?",Long.parseLong(p.threadId().substring(3)));
        publications.visibility(member,p.analysisId(),true);
        assertTrue(read("/api/v1/posts/"+post).path("sourceLinks").get(0).path("available").asBoolean());
        patchPost(post,"{\"sourceLinks\":[]}").andExpect(status().isOk()).andExpect(jsonPath("$.sourceLinks").isEmpty());
    }
    @Test void 별변경은_타인댓글출처보호_숨긴출처도암묵제거하지않음() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create("[]"); comment(post,links(p));
        patchPost(post,"{\"ticId\":null,\"sourceLinks\":[]}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TIC_MISMATCH"));
        publications.visibility(member,p.analysisId(),false);
        patchPost(post,"{\"ticId\":null}").andExpect(status().isNotFound());
        assertEquals(Long.toString(tic),read("/api/v1/posts/"+post).path("ticId").asText());
    }
    @Test void 댓글본문수정_생략유지_null거절_출처만제거_부모숨김거절() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create("[]");
        var response=mvc.perform(post("/api/v1/comments").session(session(member)).with(csrf()).contentType("application/json")
                .content("{\"parentType\":\"POST\",\"parentId\":\""+post+"\",\"body\":\"댓글\",\"sourceLinks\":"+links(p)+"}"))
                .andExpect(status().isCreated()).andReturn();
        String path="/api/v1/comments/"+JSON.readTree(response.getResponse().getContentAsString()).path("commentId").asText();
        publications.visibility(member,p.analysisId(),false);
        mvc.perform(patch(path).session(session(member)).with(csrf()).contentType("application/json").content("{\"body\":\"수정\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.sourceLinks[0].id").doesNotExist());
        mvc.perform(patch(path).session(session(member)).with(csrf()).contentType("application/json").content("{\"sourceLinks\":null}"))
                .andExpect(status().isBadRequest());
        mvc.perform(patch(path).session(session(member)).with(csrf()).contentType("application/json").content("{\"sourceLinks\":[]}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.sourceLinks").isEmpty());
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",number(post));
        mvc.perform(patch(path).session(session(member)).with(csrf()).contentType("application/json").content("{\"sourceLinks\":[]}"))
                .andExpect(status().isNotFound());
    }
    @Test void 미리보기와통계는_같은스냅샷_다음조회는취소반영() throws Exception {
        var p=publications.publish(member,submit(3));
        doAnswer(invocation -> { cancel(member,p.analysisId()); return invocation.callRealMethod(); }).when(summaryRepository).statistics(org.mockito.ArgumentMatchers.eq(candidate), any());
        var card=read(preview("SIGNAL_THREAD",p.threadId()));
        assertEquals(1,card.path("judgmentSummary").path("participantCount").asInt());
        reset(summaryRepository);
        assertEquals(0,read(preview("SIGNAL_THREAD",p.threadId())).path("judgmentSummary").path("participantCount").asInt());
    }
    @Test void 앱역할로_실제출처저장조회교체_최소권한() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create("[]");
        var tx=new TransactionTemplate(transactions);
        tx.executeWithoutResult(status -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            var link=new com.planetory.backend.domain.post.service.PostService.SourceLink("PUBLIC_ANALYSIS",p.analysisId());
            sources.replace(com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent.POST,number(post),tic,List.of(link),false);
            assertEquals(1,sources.references(com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent.POST,number(post),tic).size());
            sources.replace(com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent.POST,number(post),tic,List.of(),false);
        });
    }

    @Test void 세개상한과_다른별미리보기_숨김저장거절() throws Exception {
        var a=publications.publish(member,submit(3));
        var b=publications.publish(member,submit(3));
        String three="["+link("PUBLIC_ANALYSIS",a.analysisId())+","+link("PUBLIC_ANALYSIS",b.analysisId())+","+link("SIGNAL_THREAD",a.threadId())+"]";
        String post=create(three);
        assertEquals(3,read("/api/v1/posts/"+post).path("sourceLinks").size());
        mvc.perform(get(preview("PUBLIC_ANALYSIS",a.analysisId()).replace("ticId="+tic,"ticId="+(tic+1))).session(session(member)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TIC_MISMATCH"));
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE id=?",Long.parseLong(a.analysisId().substring(3)));
        patchPost(post,"{\"sourceLinks\":"+three+"}").andExpect(status().isNotFound());
        assertEquals(3,jdbc.queryForObject("SELECT count(*) FROM post_source_links WHERE post_id=?",Integer.class,number(post)));
        var unavailable=read("/api/v1/posts/"+post).path("sourceLinks").get(0);
        assertEquals(2,unavailable.size()); assertFalse(unavailable.has("id"));
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        mvc.perform(get(preview("SIGNAL_THREAD",a.threadId())).session(session(member))).andExpect(status().isNotFound());
    }
    @Test void 동시출처교체는_부모잠금으로직렬화하고_중복저장하지않음() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create("[]");
        var start=new java.util.concurrent.CountDownLatch(1);
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var futures=new java.util.ArrayList<java.util.concurrent.Future<?>>();
            for(int i=0;i<2;i++) futures.add(pool.submit(() -> {
                start.await();
                patchPost(post,"{\"sourceLinks\":"+links(p)+"}").andExpect(status().isOk());
                return null;
            }));
            start.countDown();
            for(var future:futures) future.get(10,java.util.concurrent.TimeUnit.SECONDS);
        }
        assertEquals(2,jdbc.queryForObject("SELECT count(*) FROM post_source_links WHERE post_id=?",Integer.class,number(post)));
    }
    @Test void 부모삭제가먼저잠그면_대기한출처수정은저장되지않음() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create("[]");
        var locked=new java.util.concurrent.CountDownLatch(1);
        var release=new java.util.concurrent.CountDownLatch(1);
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var deleting=pool.submit(() -> new TransactionTemplate(transactions).executeWithoutResult(status -> {
                jdbc.update("UPDATE posts SET status='deleted' WHERE id=?",number(post)); locked.countDown();
                try { assertTrue(release.await(10,java.util.concurrent.TimeUnit.SECONDS)); }
                catch(InterruptedException e) { throw new RuntimeException(e); }
            }));
            assertTrue(locked.await(10,java.util.concurrent.TimeUnit.SECONDS));
            var modifying=pool.submit(() -> { patchPost(post,"{\"sourceLinks\":"+links(p)+"}").andExpect(status().isNotFound()); return null; });
            release.countDown(); deleting.get(10,java.util.concurrent.TimeUnit.SECONDS); modifying.get(10,java.util.concurrent.TimeUnit.SECONDS);
        }
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM post_source_links WHERE post_id=?",Integer.class,number(post)));
    }

    @Test void 서로를참조하는_공식스레드댓글_생성과수정_40회_교착없음() throws Exception {
        var a=publications.publish(member,submit(3));
        long secondCandidate=jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,2,5,100.3,2.4,1000,10,'{}',true,true) RETURNING id",Long.class,tic,bundle);
        long secondThread=jdbc.queryForObject("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'두번째','','visible') RETURNING id",Long.class,secondCandidate,tic);
        long firstThread=Long.parseLong(a.threadId().substring(3));
        long other=member();
        var barrier=new java.util.concurrent.CyclicBarrier(2);
        doAnswer(call -> { barrier.await(5,java.util.concurrent.TimeUnit.SECONDS); return call.callRealMethod(); })
                .when(org.springframework.test.util.AopTestUtils.<com.planetory.backend.domain.post.service.SourceLinkService>getUltimateTargetObject(sources)).replace(org.mockito.ArgumentMatchers.eq(com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent.COMMENT),anyLong(),anyLong(),org.mockito.ArgumentMatchers.anyList(),org.mockito.ArgumentMatchers.eq(false));
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            for(int i=0;i<40;i++) {
                var leftLinks=List.of(new com.planetory.backend.domain.post.service.PostService.SourceLink("SIGNAL_THREAD","st-"+secondThread));
                var rightLinks=List.of(new com.planetory.backend.domain.post.service.PostService.SourceLink("SIGNAL_THREAD",a.threadId()));
                var left=pool.submit(() -> comments.create(member,new com.planetory.backend.domain.comment.service.CommentService.CreateCommand(
                        com.planetory.backend.domain.comment.service.CommentService.ParentType.SIGNAL_THREAD,firstThread,"교차",null,leftLinks)));
                var right=pool.submit(() -> comments.create(other,new com.planetory.backend.domain.comment.service.CommentService.CreateCommand(
                        com.planetory.backend.domain.comment.service.CommentService.ParentType.SIGNAL_THREAD,secondThread,"교차",null,rightLinks)));
                long leftId=number(left.get(10,java.util.concurrent.TimeUnit.SECONDS).commentId());
                long rightId=number(right.get(10,java.util.concurrent.TimeUnit.SECONDS).commentId());
                var editLeft=pool.submit(() -> comments.patch(member,leftId,new com.planetory.backend.domain.comment.service.CommentService.PatchCommand(null,false,null,leftLinks)));
                var editRight=pool.submit(() -> comments.patch(other,rightId,new com.planetory.backend.domain.comment.service.CommentService.PatchCommand(null,false,null,rightLinks)));
                assertEquals(1,editLeft.get(10,java.util.concurrent.TimeUnit.SECONDS).sourceLinks().size());
                assertEquals(1,editRight.get(10,java.util.concurrent.TimeUnit.SECONDS).sourceLinks().size());
            }
        }
    }
    @Test void 댓글20개_출처60개는_한번의출처쿼리로_가용성을조회() throws Exception {
        var a=publications.publish(member,submit(3)); var b=publications.publish(member,submit(3));
        String post=create("[]");
        for(int i=0;i<20;i++) {
            long comment=jdbc.queryForObject("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'목록','visible') RETURNING id",Long.class,number(post),member);
            jdbc.update("INSERT INTO post_source_links(comment_id,target_type,target_id) VALUES (?,'analysis',?),(?,'analysis',?),(?,'thread',?)",
                    comment,Long.parseLong(a.analysisId().substring(3)),comment,Long.parseLong(b.analysisId().substring(3)),comment,Long.parseLong(a.threadId().substring(3)));
        }
        publications.visibility(member,a.analysisId(),false);
        clearInvocations(sourceJdbc);
        var page=read("/api/v1/comments?parentType=POST&parentId="+post);
        assertEquals(20,page.path("items").size());
        for(var item:page.path("items")) {
            assertEquals(3,item.path("sourceLinks").size());
            assertEquals(2,item.path("sourceLinks").get(0).size());
            assertFalse(item.path("sourceLinks").get(0).path("available").asBoolean());
            assertTrue(item.path("sourceLinks").get(1).path("available").asBoolean());
        }
        verify(sourceJdbc,times(1)).sql(org.mockito.ArgumentMatchers.contains("FROM post_source_links a"));
        verify(sourceJdbc,never()).sql(org.mockito.ArgumentMatchers.startsWith("SELECT target_type,target_id FROM post_source_links"));
    }
    @Test void 서비스직접글상세도_취소와_동일스냅샷() throws Exception {
        var p=publications.publish(member,submit(3)); String post=create(links(p));
        doAnswer(call -> { cancel(member,p.analysisId()); return call.callRealMethod(); }).when(sources).references(com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent.POST,number(post),tic);
        assertTrue(posts.detail(number(post)).sourceLinks().getFirst().available());
        reset(sources);
        assertFalse(posts.detail(number(post)).sourceLinks().getFirst().available());
    }
    @Test void 출처저장도중취소는_최종재검증으로롤백하고_닫힌별댓글수정은거절() throws Exception {
        // 같은 회원이면 글 수정의 회원 잠금(180)이 취소를 저장 뒤로 직렬화한다. 남의 분석을 출처로 저장하는 도중의 취소를 재현한다.
        var p=publications.publish(member,submit(3)); long author=member(); String post=create(author,"[]");
        doAnswer(call -> { var statement=call.callRealMethod(); cancel(member,p.analysisId()); return statement; }).when(sourceJdbc).sql(org.mockito.ArgumentMatchers.startsWith("INSERT INTO post_source_links("));
        patchPost(author,post,"{\"sourceLinks\":"+links(p)+"}").andExpect(status().isNotFound());
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM post_source_links WHERE post_id=?",Integer.class,number(post)));
        var comment=comments.create(member,new com.planetory.backend.domain.comment.service.CommentService.CreateCommand(
                com.planetory.backend.domain.comment.service.CommentService.ParentType.POST,number(post),"본문",null,null));
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        error(ErrorCode.STAR_NOT_PUBLISHED,() -> comments.patch(member,number(comment.commentId()),
                new com.planetory.backend.domain.comment.service.CommentService.PatchCommand("수정",true,null,null)));
    }
}
