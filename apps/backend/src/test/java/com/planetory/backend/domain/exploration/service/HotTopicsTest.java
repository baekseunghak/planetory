package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.domain.post.service.CommunityReadService;
import com.planetory.backend.domain.post.service.HotTopicsQuery;
import com.planetory.backend.global.security.MemberPrincipal;
import java.time.Instant;
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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class HotTopicsTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", DB::getUsername);
        r.add("spring.datasource.password", DB::getPassword);
    }
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired GalaxyLayout layout;
    @Autowired CommunityReadService community;
    @Autowired PlatformTransactionManager transactions;
    @MockitoSpyBean SubmissionRepository summaries;
    @MockitoSpyBean org.springframework.jdbc.core.simple.JdbcClient client;
    private static final String PATH = "/api/v1/community/hot-topics";
    private static final JsonMapper JSON = JsonMapper.builder().build();
    long viewer, tic, bundle;
    record Topic(long id, long candidate) {}

    @BeforeEach void seed() {
        // 같은 일회용 DB의 이전 사례를 노출 집합에서 제외한다.
        jdbc.update("UPDATE posts SET status='hidden'");
        viewer = member();
        tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000) + 1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')", tic);
        var p = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                viewer,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
        String manifest = """
                {"segment_ids":[1],"array_checksums":{},"residual_model_version":"rm-1",
                "periodogram_config_version":"pg-1","binning":{"minutes":10},"period_grid":{"spacing":"log"},
                "fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """;
        bundle = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",
                Long.class,tic,"hot-" + UUID.randomUUID(),manifest);
    }
    long member() {
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",
                Long.class,UUID.randomUUID().toString(),UUID.randomUUID().toString());
    }
    Topic topic(int n) {
        long candidate = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",
                Long.class,tic,bundle);
        long post = jdbc.queryForObject("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'신호','', 'visible') RETURNING id",
                Long.class,candidate,tic);
        Topic topic = new Topic(post,candidate);
        for (int i=0;i<n;i++) publish(topic,member(),i%3==0 ? "LIKELY_PLANET" : i%3==1 ? "UNLIKELY_PLANET" : "UNSURE");
        return topic;
    }
    long publish(Topic topic, long user, String judgment) {
        long submission = jdbc.queryForObject("""
                INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,removed_candidate_ids,
                    submitted_period,phase_start,phase_end,fold_reference_time_btjd,user_judgment,evidence_checks,match_result,
                    matched_candidate_id,achievement_result,residual_model_version,periodogram_config_version,rule_version)
                VALUES (?,?,?,?,'candidate',0,'{}',3,0.1,0.2,100,?,'[]','matched',?,'pending_publish','rm-1','pg-1',
                    (SELECT rule_version FROM operation_settings ORDER BY applied_at DESC LIMIT 1)) RETURNING id
                """,Long.class,user,tic,bundle,UUID.randomUUID(),judgment,topic.candidate());
        long history = jdbc.queryForObject("INSERT INTO analysis_histories(submission_id,user_id,tic_id,snapshot_params,versions) VALUES (?,?,?,'{}','{}') RETURNING id",
                Long.class,submission,user,tic);
        return jdbc.queryForObject("INSERT INTO published_analyses(post_id,user_id,candidate_id,history_id,published_at) VALUES (?,?,?,?,now()) RETURNING id",
                Long.class,topic.id(),user,topic.candidate(),history);
    }
    MockHttpSession session() {
        var session = new MockHttpSession(); var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(viewer),null,"ROLE_USER"));
        session.setAttribute("SPRING_SECURITY_CONTEXT",context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",Instant.now());
        return session;
    }
    JsonNode read(String query) throws Exception {
        return JSON.readTree(mvc.perform(get(PATH + query).session(session())).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control","no-store")).andReturn().getResponse().getContentAsString());
    }
    void ids(JsonNode page, Topic... topics) {
        assertEquals(topics.length,page.path("items").size());
        for (int i=0;i<topics.length;i++) {
            var item=page.path("items").get(i);
            assertEquals("st-"+topics[i].id(),item.path("id").asText());
            assertEquals("SIGNAL_THREAD",item.path("type").asText());
            assertEquals("SYSTEM",item.path("author").path("type").asText());
        }
    }

    @Test void 임계값_전역순위_기간없음_시각과숫자ID동률_페이지() throws Exception {
        var nine=topic(9); var ten=topic(10); var eleven=topic(11); var tie=topic(10);
        jdbc.update("UPDATE posts SET created_at='2026-09-21T00:00:00.123456Z' WHERE id IN (?,?)",ten.id(),tie.id());
        jdbc.update("UPDATE posts SET created_at='2000-01-01T00:00:00Z' WHERE id=?",eleven.id());
        for (int i=0;i<25;i++) jdbc.update("INSERT INTO posts(kind,user_id,board,tag,title,body,status) VALUES ('user',?,'free','GENERAL','최신 글','본문','visible')",viewer);
        ids(read("?size=3"),eleven,tie,ten);
        var first=read("?size=1"); ids(first,eleven); assertTrue(first.path("hasNext").asBoolean());
        var second=read("?size=1&cursor="+first.path("nextCursor").asText()); ids(second,tie);
        var last=read("?size=1&cursor="+second.path("nextCursor").asText()); ids(last,ten);
        assertFalse(last.path("hasNext").asBoolean()); assertTrue(last.path("nextCursor").isNull());
        var summary=last.path("items").get(0).path("judgmentSummary");
        assertEquals(10,summary.path("participantCount").asInt());
        assertEquals(4,summary.path("likelyPlanet").asInt()); assertEquals(3,summary.path("unlikelyPlanet").asInt()); assertEquals(3,summary.path("unsure").asInt());
        jdbc.update("UPDATE posts SET created_at='2026-09-22T00:00:00Z' WHERE id=?",ten.id());
        ids(read("?size=3"),eleven,ten,tie);
        assertFalse(read("").toString().contains("st-"+nine.id()+"\""));
    }

    @Test void 반복판단_최신취소시과거복귀_마지막취소탈락_복원과개별숨김() throws Exception {
        var t=topic(9); long user=member();
        long old=publish(t,user,"LIKELY_PLANET"); long recent=publish(t,user,"UNSURE");
        var summary=read("").path("items").get(0).path("judgmentSummary");
        assertEquals(10,summary.path("participantCount").asInt()); assertEquals(4,summary.path("unsure").asInt());
        jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE id=?",recent);
        summary=read("").path("items").get(0).path("judgmentSummary");
        assertEquals(10,summary.path("participantCount").asInt()); assertEquals(4,summary.path("likelyPlanet").asInt());
        jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE id=?",old); ids(read(""));
        jdbc.update("UPDATE published_analyses SET unpublished_at=NULL WHERE id=?",old); ids(read(""),t);
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE id=?",old); ids(read(""));
        jdbc.update("UPDATE published_analyses SET hidden_at=NULL WHERE id=?",old); ids(read(""),t);
    }

    @Test void 부모숨김삭제복원_별미공개미발견_댓글반응무영향() throws Exception {
        var t=topic(10);
        long post=jdbc.queryForObject("INSERT INTO posts(kind,user_id,board,tag,title,body,status) VALUES ('user',?,'free','GENERAL','글','본문','visible') RETURNING id",Long.class,viewer);
        jdbc.update("INSERT INTO post_reactions(post_id,user_id,reaction) VALUES (?,?,'agree')",post,viewer);
        jdbc.update("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'댓글','visible'),(?,?,'숨김','hidden'),(?,?,'삭제','deleted')",
                t.id(),viewer,t.id(),viewer,t.id(),viewer);
        var page=read(""); ids(page,t);
        assertEquals(1,page.path("items").get(0).path("commentCount").asInt());
        assertEquals(10,page.path("items").get(0).path("judgmentSummary").path("participantCount").asInt());
        for (String state:List.of("hidden","deleted")) {
            jdbc.update("UPDATE posts SET status=? WHERE id=?",state,t.id()); ids(read(""));
            jdbc.update("UPDATE posts SET status='visible' WHERE id=?",t.id()); ids(read(""),t);
        }
        jdbc.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic); ids(read(""));
        jdbc.update("UPDATE stars SET service_status='published' WHERE tic_id=?",tic); ids(read(""),t);
        jdbc.update("DELETE FROM star_unlocks WHERE tic_id=?",tic); ids(read(""),t);
    }

    @Test void 동시취소에도_선정N과요약N은동일_다음요청재평가() throws Exception {
        var t=topic(10);
        doAnswer(call -> {
            var tx=new TransactionTemplate(transactions);
            tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            tx.executeWithoutResult(s -> jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE post_id=?",t.id()));
            return call.callRealMethod();
        }).when(summaries).statistics(eq(t.candidate()),any());
        var first=read(""); ids(first,t);
        assertEquals(10,first.path("items").get(0).path("judgmentSummary").path("participantCount").asInt());
        ids(read(""));
    }

    @Test void 순위변경시_페이지는현재값재평가_새로고침은최신순위() throws Exception {
        var a=topic(11); var b=topic(10);
        var first=read("?size=1"); ids(first,a);
        publish(b,member(),"UNSURE"); publish(b,member(),"UNSURE");
        ids(read("?size=1&cursor="+first.path("nextCursor").asText()));
        ids(read("?size=1"),b);
    }

    @Test void 인증_빈목록_잘못된쿼리와커서_크기바인딩_경로분리() throws Exception {
        mvc.perform(get(PATH)).andExpect(status().isUnauthorized());
        var empty=read(""); ids(empty); assertTrue(empty.path("nextCursor").isNull()); assertFalse(empty.path("hasNext").asBoolean());
        for (String query:List.of("size=0","size=101","size=01","size=-1","size=1.5","size=9223372036854775808","size=2&size=2","cursor=","cursor=bad","ticId=1","board=STAR"))
            mvc.perform(get(PATH+"?"+query).session(session())).andExpect(status().isBadRequest());
        topic(10); topic(11);
        String cursor=read("?size=1").path("nextCursor").asText();
        mvc.perform(get(PATH+"?size=2&cursor="+cursor).session(session())).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/community/feed?size=1&cursor="+cursor).session(session())).andExpect(status().isBadRequest());
        String feed=JSON.readTree(mvc.perform(get("/api/v1/community/feed?size=1").session(session())).andReturn().getResponse().getContentAsString()).path("nextCursor").asText();
        mvc.perform(get(PATH+"?size=1&cursor="+feed).session(session())).andExpect(status().isBadRequest());
        for (String raw:List.of("hot-v1|1|9|2026-09-21T00:00Z|1","hot-v1|1|10|2026-09-21T00:00:00.123456789Z|1","hot-v1|1|10|bad|1","hot-v1|1|10|2026-09-21T00:00Z|0","analyses-v1|1|10|2026-09-21T00:00Z|1")) {
            String bad=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            mvc.perform(get(PATH).param("size","1").param("cursor",bad).session(session())).andExpect(status().isBadRequest());
        }
    }

    @Test void 앱역할_동일트랜잭션_조회는데이터불변() {
        var t=topic(10);
        long before=jdbc.queryForObject("SELECT count(*) FROM published_analyses",Long.class);
        var tx=new TransactionTemplate(transactions);
        tx.setReadOnly(true); tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        tx.executeWithoutResult(s -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            var page=community.hotTopics(viewer,HotTopicsQuery.parse(new LinkedMultiValueMap<>()));
            assertEquals("st-"+t.id(),page.items().getFirst().id());
            assertEquals(10L,page.items().getFirst().judgmentSummary().get("participantCount"));
        });
        assertEquals(before,jdbc.queryForObject("SELECT count(*) FROM published_analyses",Long.class));
    }

    @Test void 선정쿼리_합성스레드100개_조회와실행계획측정() throws Exception {
        for (int i=0;i<100;i++) topic(9+i%3);
        jdbc.execute("ANALYZE");
        var page=read("?size=20"); assertEquals(20,page.path("items").size());
        var sql=org.mockito.ArgumentCaptor.forClass(String.class);
        verify(client,atLeastOnce()).sql(sql.capture());
        String selection=sql.getAllValues().stream().filter(s -> s.contains("WITH ranked AS")).findFirst().orElseThrow();
        var params=new org.springframework.jdbc.core.namedparam.MapSqlParameterSource()
                .addValue("count",null).addValue("at",null).addValue("id",null).addValue("limit",21);
        var named=new org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate(jdbc);
        for (int i=0;i<3;i++) {
            var plan=named.queryForList("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + selection,params,String.class);
            assertTrue(plan.getFirst().contains("Execution Time"));
            System.out.println("HOT_TOPICS_PLAN_"+i+" "+plan.getFirst());
        }
    }
}
