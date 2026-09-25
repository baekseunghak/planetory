package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.post.service.PostService;
import com.planetory.backend.global.security.MemberPrincipal;
import java.time.Instant;
import java.time.OffsetDateTime;
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
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 실제 제출·DB·HTTP 보안 필터와 160 첨부 경로. 잔차 공급자만 대체한다.
 * 탐사 패키지 내부의 HistoryRepository 등으로 제출·판 교체 픽스처를 제어하므로 이 패키지에 둔다.
 */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class HistoryAttachmentTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url",DB::getJdbcUrl);
        r.add("spring.datasource.username",DB::getUsername);
        r.add("spring.datasource.password",DB::getPassword);
    }
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired SubmissionService submissions;
    @Autowired GalaxyLayout layout;
    @Autowired PostService posts;
    @Autowired PlatformTransactionManager transactions;
    @MockitoBean ResidualResultReader residuals;
    @MockitoSpyBean HistoryRepository histories;
    @MockitoSpyBean GoldCatalogRepository gold;
    long member,other,tic,bundle,segment,candidate;
    String history;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @BeforeEach void seed() {
        when(residuals.lookup(anyLong(), any())).thenReturn(ResidualResultReader.Lookup.none());
        member=member(); other=member(); tic=Math.abs(UUID.randomUUID().getMostSignificantBits()%900_000_000)+1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",tic);
        var p=layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                member,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
        Float[] flux=new Float[4320]; Arrays.fill(flux,1f);
        segment=jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id,sector,binning_revision,start_btjd,bin_minutes,n_points,flux,gaps) VALUES (?,1,'10m-v1',100,10,?,?,'[]') RETURNING id",
                Long.class,tic,flux.length,flux);
        String manifest="""
                {"segment_ids":[%d],"array_checksums":{},"residual_model_version":"rm-1","periodogram_config_version":"pg-1",
                "binning":{"minutes":10},"period_grid":{"spacing":"log"},"fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """.formatted(segment);
        bundle=jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",
                Long.class,tic,"attachment-"+UUID.randomUUID(),manifest);
        jdbc.update("INSERT INTO periodograms(bundle_id,period_min_days,period_max_days,n_periods,power) VALUES (?,0.5,20,3,?)",bundle,new Float[]{1f,2f,1f});
        candidate=jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",
                Long.class,tic,bundle);
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,rule_version,applied_at,source_refs) VALUES (?,'confirmed','graded','planet','rule-0',now(),'[]')",candidate);
        history=submit(3);
    }
    long member() {
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",Long.class,UUID.randomUUID().toString(),UUID.randomUUID().toString());
    }
    String submit(double period) {
        var request=new SubmissionRequest(UUID.randomUUID().toString(),"candidate",
                new SubmissionRequest.Context("b-"+bundle,0,List.of(),"rm-1","pg-1"),
                new SubmissionRequest.Selection(period,null,.25/period,.35/period),"LIKELY_PLANET",List.of("ushape"),"첨부 공개 메모",
                new SubmissionRequest.ViewState(new SubmissionRequest.Viewport(1.0,10.0),2.0),null);
        return submissions.submit(member,tic,request).body().path("historyId").asText();
    }
    MockHttpSession session(long id) {
        var session=new MockHttpSession(); var context=SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(id),null,"ROLE_USER"));
        session.setAttribute("SPRING_SECURITY_CONTEXT",context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",Instant.now());
        return session;
    }
    ResultActions create(long owner, List<String> ids, String ticValue) throws Exception {
        return mvc.perform(post("/api/v1/posts").session(session(owner)).with(csrf()).contentType("application/json")
                .content(JSON.writeValueAsString(new PostService.CreateCommand("첨부 글","본문","GENERAL",ticValue,ids,List.of()))));
    }
    String create(List<String> ids) throws Exception {
        return JSON.readTree(create(member,ids,Long.toString(tic)).andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString()).path("postId").asText();
    }
    String path(String post) { return "/api/v1/posts/"+post+"/history-attachments/"+history; }
    ResultActions patchPost(String post, String body) throws Exception {
        return mvc.perform(patch("/api/v1/posts/"+post).session(session(member)).with(csrf()).contentType("application/json").content(body));
    }
    long number(String id) { return Long.parseLong(id.substring(2)); }

    @Test void 첨부_교체_해제와_자료만수정_원본성과불변() throws Exception {
        String h2=submit(5),h3=submit(6);
        String original=jdbc.queryForObject("SELECT row_to_json(h)::text FROM analysis_histories h WHERE id=?",String.class,number(history));
        int achievements=jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements WHERE user_id=?",Integer.class,member);
        String post=create(List.of(history,h2,h3));
        mvc.perform(get("/api/v1/posts/"+post).session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.attachments.length()").value(3));
        var attachedAt=jdbc.queryForObject("SELECT attached_at FROM post_history_attachments WHERE post_id=? AND history_id=?",OffsetDateTime.class,number(post),number(history));
        patchPost(post,"{\"historyIds\":[\""+history+"\"]}").andExpect(status().isOk())
                .andExpect(jsonPath("$.attachments[0].historyId").value(history)).andExpect(jsonPath("$.body").value("본문"));
        patchPost(post,"{\"title\":\"제목 변경\"}").andExpect(status().isOk()).andExpect(jsonPath("$.attachments.length()").value(1));
        assertEquals(attachedAt,jdbc.queryForObject("SELECT attached_at FROM post_history_attachments WHERE post_id=?",OffsetDateTime.class,number(post)));
        patchPost(post,"{\"ticId\":null}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TIC_MISMATCH"));
        patchPost(post,"{\"ticId\":null,\"historyIds\":[]}").andExpect(status().isOk()).andExpect(jsonPath("$.attachments").isEmpty());
        mvc.perform(get(path(post)).session(session(member))).andExpect(status().isNotFound());
        assertEquals(original,jdbc.queryForObject("SELECT row_to_json(h)::text FROM analysis_histories h WHERE id=?",String.class,number(history)));
        assertEquals(achievements,jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements WHERE user_id=?",Integer.class,member));
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM published_analyses WHERE user_id=?",Integer.class,member));
    }

    @Test void 소유자_TIC_중복_상한_형식검증과_실패시롤백() throws Exception {
        create(other,List.of(history),Long.toString(tic)).andExpect(status().isForbidden());
        create(member,List.of(history),null).andExpect(status().isBadRequest());
        mvc.perform(post("/api/v1/posts").session(session(member)).with(csrf()).contentType("application/json")
                .content(JSON.writeValueAsString(Map.of(
                        "title", "숫자 TIC 거절", "body", "본문", "purposeTag", "GENERAL", "ticId", tic))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        for (List<String> ids:List.of(List.of(history,history),List.of(history,"h-2","h-3","h-4"),List.of("h-01")))
            create(member,ids,Long.toString(tic)).andExpect(status().isBadRequest());
        String post=create(List.of(history));
        for (String value:List.of("null","1","[1]","[null]"))
            patchPost(post,"{\"historyIds\":"+value+"}").andExpect(status().isBadRequest());
        patchPost(post, JSON.writeValueAsString(Map.of("ticId", tic)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        patchPost(post,"{\"title\":\"롤백\",\"historyIds\":[\"h-9223372036854775807\"]}")
                .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/posts/"+post).session(session(member))).andExpect(jsonPath("$.title").value("첨부 글"))
                .andExpect(jsonPath("$.attachments[0].historyId").value(history));
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,0,'published')",tic+1);
        jdbc.update("UPDATE analysis_histories SET tic_id=? WHERE id=?",tic+1,number(history));
        create(member,List.of(history),Long.toString(tic)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TIC_MISMATCH"));
        mvc.perform(get(path(post)).session(session(other))).andExpect(status().isNotFound());
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM posts WHERE user_id=?",Integer.class,member));
    }

    @Test void 공개HTTP_부모관계_인증_내부필드차단과_모드재사용() throws Exception {
        String post=create(List.of(history)),empty=create(List.of());
        mvc.perform(get(path(post))).andExpect(status().isUnauthorized());
        mvc.perform(get(path(empty)).session(session(other))).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/histories/"+history).session(session(other))).andExpect(status().isForbidden());
        String body=mvc.perform(get(path(post)).session(session(other))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control","no-store"))
                .andExpect(jsonPath("$.parentType").value("POST")).andExpect(jsonPath("$.parentId").value(post))
                .andExpect(jsonPath("$.judgment").value("LIKELY_PLANET")).andExpect(jsonPath("$.memo").value("첨부 공개 메모"))
                .andExpect(jsonPath("$.graph.historyId").value(history)).andExpect(jsonPath("$.graph.curve.curveContext.curveStep").value(0))
                .andReturn().getResponse().getContentAsString();
        for(String key:List.of("viewState","answerViewed","achievementResult","retryOfSubmissionId","originalMatch","requestId","skyVersion","targetKind"))
            assertFalse(body.contains('"'+key+'"'),key);
        mvc.perform(get(path(post)).param("graphMode","SUBMITTED").session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.curve").isEmpty()).andExpect(jsonPath("$.graph.snapshot.bins").value(150));
        mvc.perform(get(path(post)).param("graphMode","BAD").session(session(other))).andExpect(status().isBadRequest());
        mvc.perform(get(path(post)).param("includeGraph","false").session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph").isEmpty()).andExpect(jsonPath("$.memo").value("첨부 공개 메모"));
    }

    @Test void 그래프503에도_공개내용별도조회_숨김과삭제는모두차단() throws Exception {
        String post=create(List.of(history));
        doReturn(false).when(histories).stillCurrent(anyLong(),anyLong());
        mvc.perform(get(path(post)).session(session(other))).andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("GRAPH_TEMPORARILY_UNAVAILABLE"));
        verify(histories,times(2)).stillCurrent(anyLong(),anyLong());
        mvc.perform(get(path(post)).param("includeGraph","false").session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.memo").value("첨부 공개 메모"));
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",number(post));
        for (String include:List.of("true","false"))
            mvc.perform(get(path(post)).param("includeGraph",include).session(session(member))).andExpect(status().isNotFound());
        mvc.perform(delete("/api/v1/posts/"+post).session(session(member)).with(csrf())).andExpect(status().isNoContent());
        mvc.perform(get(path(post)).session(session(member))).andExpect(status().isNotFound());
    }

    @Test void 조회도중첨부해제는_반환직전DB검사에서차단() throws Exception {
        String post=create(List.of(history));
        doAnswer(call -> {
            var tx=new TransactionTemplate(transactions);
            tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            tx.executeWithoutResult(status -> jdbc.update("DELETE FROM post_history_attachments WHERE post_id=?",number(post)));
            return call.callRealMethod();
        }).when(gold).findSegments(anyLong(), any());
        mvc.perform(get(path(post)).session(session(other))).andExpect(status().isNotFound());
    }

    @Test void 공개잔차_캐시없음은원본_완료캐시는job비공개_스냅샷없음() throws Exception {
        String h2=submit(5);
        jdbc.update("UPDATE submissions SET removed_candidate_ids=ARRAY[?]::bigint[],curve_step=1 WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)",candidate,number(h2));
        history=h2;
        String post=create(List.of(history));
        mvc.perform(get(path(post)).session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.reproduction.fallbackReason").value("RESIDUAL_NOT_AVAILABLE"))
                .andExpect(jsonPath("$.graph.curve.curveContext.curveStep").value(0))
                .andExpect(jsonPath("$.graph.curve.residual.jobId").isEmpty());
        Float[] flux=new Float[4320]; Arrays.fill(flux,.99f);
        when(residuals.lookup(anyLong(), any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED","private-job",null,Map.of(segment,flux),null));
        mvc.perform(get(path(post)).session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.curve.curveContext.curveStep").value(1))
                .andExpect(jsonPath("$.graph.curve.residual.jobId").isEmpty());
        mvc.perform(get(path(post)).param("graphMode","SUBMITTED").session(session(other))).andExpect(status().isOk())
                .andExpect(jsonPath("$.graph.curve").isEmpty()).andExpect(jsonPath("$.graph.snapshot").isEmpty());
    }

    @Test void 댓글첨부_일반공식부모_본문생략수정_부모TIC변경과숨김차단() throws Exception {
        String post=create(List.of());
        long thread=jdbc.queryForObject("INSERT INTO posts(kind,board,tic_id,candidate_id,title,body,status) VALUES ('system_thread','star',?,?,'공식','본문','visible') RETURNING id",Long.class,tic,candidate);
        for(String parent:List.of(post,"st-"+thread)) {
            String type=parent.startsWith("st-")?"SIGNAL_THREAD":"POST";
            String comment=JSON.readTree(mvc.perform(post("/api/v1/comments").session(session(member)).with(csrf()).contentType("application/json")
                    .content(JSON.writeValueAsString(Map.of("parentType",type,"parentId",parent,"body","댓글","historyIds",List.of(history)))))
                    .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("commentId").asText();
            String path="/api/v1/comments/"+comment+"/history-attachments/"+history;
            mvc.perform(get(path).session(session(other))).andExpect(status().isOk()).andExpect(jsonPath("$.parentType").value("COMMENT"));
            mvc.perform(get("/api/v1/comments").param("parentType",type).param("parentId",parent).session(session(other)))
                    .andExpect(jsonPath("$.items[0].attachments[0].historyId").value(history));
            if (type.equals("POST")) patchPost(post,"{\"ticId\":null,\"historyIds\":[]}")
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TIC_MISMATCH"));
            long parentId=Long.parseLong(parent.substring(parent.indexOf('-')+1));
            jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",parentId);
            mvc.perform(get(path).param("includeGraph","false").session(session(member))).andExpect(status().isNotFound());
            jdbc.update("UPDATE posts SET status='visible' WHERE id=?",parentId);
            mvc.perform(patch("/api/v1/comments/"+comment).session(session(member)).with(csrf()).contentType("application/json")
                    .content("{\"historyIds\":[]}")).andExpect(status().isOk()).andExpect(jsonPath("$.body").value("댓글"))
                    .andExpect(jsonPath("$.attachments").isEmpty());
            mvc.perform(get(path).session(session(other))).andExpect(status().isNotFound());
        }
        patchPost(post,"{\"ticId\":null,\"historyIds\":[]}").andExpect(status().isOk());
    }

    @Test void 실제앱역할로_첨부참조쓰기와해제_원본변경금지() throws Exception {
        String post=create(List.of());
        try(var connection=java.sql.DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());var sql=connection.createStatement()) {
            sql.execute("SET ROLE planetory_app");
            sql.execute("INSERT INTO post_history_attachments(post_id,history_id) VALUES ("+number(post)+","+number(history)+")");
            try(var rows=sql.executeQuery("SELECT history_id FROM post_history_attachments WHERE post_id="+number(post))) { assertTrue(rows.next()); }
            assertEquals(1,sql.executeUpdate("DELETE FROM post_history_attachments WHERE post_id="+number(post)));
            assertEquals("42501",assertThrows(java.sql.SQLException.class,()->sql.execute("DELETE FROM analysis_histories WHERE id="+number(history))).getSQLState());
        }
    }
}
