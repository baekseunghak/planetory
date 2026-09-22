package com.planetory.backend.domain.member;

import com.planetory.backend.domain.member.service.FollowService;
import com.planetory.backend.domain.member.service.FollowTokens;
import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.global.security.MemberPrincipal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.LinkedMultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 실제 앱 로그인 역할로 HTTP·서비스 경합을 실행한다. 시드는 별도 소유자 연결이며 공유 DB를 쓰지 않는다. */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class FollowTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    static JdbcTemplate owner;
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        var flyway = Flyway.configure().dataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword())
                .locations("classpath:db/migration").load();
        assertTrue(flyway.migrate().migrations.stream().anyMatch(m -> m.version.equals("20")));
        flyway.validate();
        assertEquals(0, flyway.migrate().migrationsExecuted);
        owner = new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword()));
        owner.execute("CREATE USER follow_test_app PASSWORD 'test'");
        owner.execute("GRANT planetory_app TO follow_test_app");
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", () -> "follow_test_app");
        r.add("spring.datasource.password", () -> "test");
        r.add("spring.flyway.url", DB::getJdbcUrl);
        r.add("spring.flyway.user", DB::getUsername);
        r.add("spring.flyway.password", DB::getPassword);
    }
    @Autowired MockMvc mvc;
    @Autowired GalaxyLayout layout;
    @Autowired FollowService follows;
    @Autowired FollowTokens tokens;
    @Autowired com.planetory.backend.domain.member.service.MemberService members;
    @Autowired com.planetory.backend.domain.exploration.service.StarService stars;
    @Autowired PlatformTransactionManager transactions;
    @Autowired JdbcTemplate app;
    @MockitoSpyBean org.springframework.jdbc.core.simple.JdbcClient client;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String BASE = "/api/v1/me/following/";
    private static final String FEED = "/api/v1/community/following-feed";
    long viewer, other, third, tic;

    @BeforeEach void seed() {
        viewer=member(); other=member(); third=member();
        tic=Math.abs(UUID.randomUUID().getMostSignificantBits()%900_000_000)+1;
        owner.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",tic);
        var p=layout.place(0);
        owner.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                other,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
    }
    long member() {
        return owner.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",
                Long.class,UUID.randomUUID().toString(),UUID.randomUUID().toString());
    }
    long post(Long star, long author) {
        return owner.queryForObject("INSERT INTO posts(kind,user_id,board,tic_id,tag,title,body,status) VALUES ('user',?,?,?,?, 'fixture','text','visible') RETURNING id",
                Long.class,author,star==null ? "free":"star",star,star==null ? "GENERAL":null);
    }
    long thread() {
        String manifest="""
                {"segment_ids":[1],"array_checksums":{},"residual_model_version":"rm-1","periodogram_config_version":"pg-1",
                "binning":{"minutes":10},"period_grid":{"spacing":"log"},"fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """;
        long bundle=owner.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",
                Long.class,tic,UUID.randomUUID().toString(),manifest);
        long candidate=owner.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3,100.3,2.4,1000,10,'{}',true,true) RETURNING id",
                Long.class,tic,bundle);
        return owner.queryForObject("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'fixture','','visible') RETURNING id",Long.class,candidate,tic);
    }
    MockHttpSession session(long user) {
        var s=new MockHttpSession(); var c=SecurityContextHolder.createEmptyContext();
        c.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(user),null,"ROLE_USER"));
        s.setAttribute("SPRING_SECURITY_CONTEXT",c);
        s.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",Instant.now());
        return s;
    }
    JsonNode read(String path) throws Exception { return read(path,viewer); }
    JsonNode read(String path,long user) throws Exception {
        return JSON.readTree(mvc.perform(get(path).session(session(user))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control","no-store")).andReturn().getResponse().getContentAsString());
    }
    JsonNode write(String method,String path) throws Exception {
        return JSON.readTree(mvc.perform(request(org.springframework.http.HttpMethod.valueOf(method),path)
                .session(session(viewer)).with(csrf().asHeader())).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
    }
    String memberPath(long member) { return BASE+"members/u-"+member; }
    String starPath() { return BASE+"stars/"+tic; }
    String summary(long member) { return "/api/v1/members/u-"+member+"/follow-summary"; }
    FollowTokens.Page page(String scope,int size) {
        var params=new LinkedMultiValueMap<String,String>(); params.add("size",Integer.toString(size));
        return tokens.page(viewer,scope,params);
    }

    @Test void 실제앱권한_멱등_자기없는대상_공개수치와본인명단() throws Exception {
        assertEquals("follow_test_app",app.queryForObject("SELECT current_user",String.class));
        assertTrue(write("PUT",memberPath(other)).path("following").asBoolean());
        var at=owner.queryForObject("SELECT created_at FROM follows WHERE user_id=?",java.time.OffsetDateTime.class,viewer);
        write("PUT",memberPath(other));
        assertEquals(at,owner.queryForObject("SELECT created_at FROM follows WHERE user_id=?",java.time.OffsetDateTime.class,viewer));
        write("PUT",starPath()); // 본인은 발견한 적이 없다.
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id=?",Long.class,viewer));
        assertEquals(1,read(summary(viewer),third).path("followingMembers").asInt());
        assertEquals(1,read(summary(viewer),third).path("followingStars").asInt());
        assertEquals(1,read(summary(other)).path("followers").asInt());
        assertEquals("u-"+other,read(BASE+"members").path("items").get(0).path("id").asText());
        assertEquals("u-"+viewer,read("/api/v1/me/followers",other).path("items").get(0).path("id").asText());
        assertEquals(0,read(BASE+"members",third).path("items").size());
        assertFalse(read(memberPath(viewer)).path("following").asBoolean());
        assertFalse(write("DELETE",memberPath(viewer)).path("following").asBoolean());
        mvc.perform(put(memberPath(viewer)).session(session(viewer)).with(csrf().asHeader())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("FOLLOW_SELF"));
        for (String method:List.of("GET","PUT","DELETE")) mvc.perform(request(org.springframework.http.HttpMethod.valueOf(method),memberPath(Long.MAX_VALUE))
                .session(session(viewer)).with(csrf().asHeader())).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("FOLLOW_TARGET_UNAVAILABLE"));
        write("DELETE",memberPath(other)); write("DELETE",memberPath(other));
        assertFalse(read(memberPath(other)).path("following").asBoolean());
        mvc.perform(get("/api/v1/members/u-"+other+"/following").session(session(viewer))).andExpect(status().isNotFound());
        assertThrows(org.springframework.dao.DataAccessException.class,()->app.update("UPDATE follows SET created_at=now() WHERE user_id=?",viewer));
    }

    @Test void 숨김관리_타인소유권_재시작_재공개_해제후재팔로우분리() throws Exception {
        write("PUT",starPath());
        owner.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        assertEquals(0,read(BASE+"stars").path("items").size());
        assertEquals(0,read(summary(viewer)).path("followingStars").asInt());
        mvc.perform(get(starPath()).session(session(viewer))).andExpect(status().isNotFound());
        mvc.perform(put(starPath()).session(session(viewer)).with(csrf().asHeader())).andExpect(status().isNotFound());
        var item=read(BASE+"unavailable-stars").path("items").get(0);
        assertEquals(2,item.size()); assertTrue(item.path("canUnfollow").asBoolean());
        String id=item.path("relationId").asText(), path=BASE+"relations/"+id;
        assertTrue(read(path).path("following").asBoolean());
        // 새 서비스/토큰 인스턴스로 앱 재시작의 관리 ID 재사용 경계를 검증한다.
        var restartedTokens=new FollowTokens();
        assertEquals(tokens.relation(id),restartedTokens.relation(id));
        var restarted=new FollowService(client,members,stars,restartedTokens);
        var tx=new TransactionTemplate(transactions);
        assertTrue(tx.execute(s->restarted.managed(viewer,id)).following());
        for (String method:List.of("GET","DELETE")) mvc.perform(request(org.springframework.http.HttpMethod.valueOf(method),path)
                .session(session(third)).with(csrf().asHeader())).andExpect(status().isNotFound());
        assertTrue(read(path).path("following").asBoolean());
        owner.update("UPDATE stars SET service_status='published' WHERE tic_id=?",tic);
        assertEquals(1,read(BASE+"stars").path("items").size());
        assertFalse(tx.execute(s->restarted.removeManaged(viewer,id)).following());
        write("DELETE",path); assertFalse(read(path).path("following").asBoolean());
        assertFalse(tx.execute(s->restarted.managed(viewer,id)).following());
        write("PUT",starPath());
        write("DELETE",path); assertTrue(read(starPath()).path("following").asBoolean());
        assertFalse(read(path,third).path("following").asBoolean());
        String memberRelation=tokens.management(owner.queryForObject("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'user',?) RETURNING id",Long.class,viewer,other));
        mvc.perform(delete(BASE+"relations/"+memberRelation).session(session(viewer)).with(csrf().asHeader())).andExpect(status().isNotFound());
        for(String malformed:List.of("bad","cmVsYXRpb24tdjF8MA","cmVsYXRpb24tdjF8MDE","cmVsYXRpb24tdjF8OTk5OTk5OTk5OTk5OTk5OTk5OTk5"))
            mvc.perform(get(BASE+"relations/"+malformed).session(session(viewer))).andExpect(status().isNotFound());
        owner.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        write("DELETE",starPath()); // 기존 TIC를 알고 있더라도 본인 관계만 해제한다.
        assertEquals(0,read(BASE+"unavailable-stars").path("items").size());
    }

    @Test void 과거원글_이중일치_동률숫자ID_size1_탈퇴및숨김조건은페이지이전() throws Exception {
        long a=post(null,other), b=post(tic,other), system=thread(), c=post(tic,third);
        owner.update("UPDATE posts SET created_at='2020-01-01T00:00:00.123456Z' WHERE id IN (?,?,?,?)",a,b,system,c);
        write("PUT",memberPath(other)); write("PUT",starPath());
        String cursor="";
        for(String expected:List.of("p-"+c,"p-"+b,"p-"+a,"st-"+system)) {
            var result=read(FEED+"?size=1"+cursor);
            assertEquals(1,result.path("items").size());
            var item=result.path("items").get(0); assertEquals(expected,item.path("id").asText());
            if(expected.equals("p-"+b)) assertEquals("[\"MEMBER\",\"STAR\"]",item.path("matchedBy").toString());
            if(expected.startsWith("st-")) { assertFalse(result.path("hasNext").asBoolean()); assertTrue(result.path("nextCursor").isNull()); }
            cursor="&cursor="+result.path("nextCursor").asText();
        }
        owner.update("INSERT INTO comments(post_id,user_id,body,status) VALUES (?,?,'new comment','visible')",b,viewer);
        assertEquals(4,read(FEED).path("items").size());
        write("DELETE",memberPath(other));
        var onlyStar=read(FEED); assertEquals(3,onlyStar.path("items").size());
        assertEquals("[\"STAR\"]",onlyStar.path("items").get(1).path("matchedBy").toString());
        write("PUT",memberPath(other)); follows.change(other,"MEMBER",viewer,true);
        owner.update("UPDATE users SET status='withdrawn',withdrawn_at=now() WHERE id=?",other);
        var after=read(FEED+"?size=1"); assertEquals("p-"+c,after.path("items").get(0).path("id").asText());
        var last=read(FEED+"?size=1&cursor="+after.path("nextCursor").asText());
        assertEquals("st-"+system,last.path("items").get(0).path("id").asText()); assertFalse(last.path("hasNext").asBoolean());
        assertEquals(0,read(summary(viewer)).path("followingMembers").asInt()); assertEquals(0,read(summary(viewer)).path("followers").asInt());
        assertEquals(0,read(BASE+"members").path("items").size()); assertEquals(0,read("/api/v1/me/followers").path("items").size());
        mvc.perform(get(memberPath(other)).session(session(viewer))).andExpect(status().isNotFound());
        owner.update("UPDATE posts SET status='hidden' WHERE id=?",c);
        assertEquals(1,read(FEED).path("items").size());
        owner.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        assertEquals(0,read(FEED).path("items").size());
    }

    @Test void 목록커서_회원API크기변조_보안필터_의존장애() throws Exception {
        write("PUT",memberPath(other)); write("PUT",memberPath(third));
        owner.update("UPDATE follows SET created_at='2026-09-01T00:00:00.123456Z' WHERE user_id=?",viewer);
        var first=read(BASE+"members?size=1"); assertEquals("u-"+third,first.path("items").get(0).path("id").asText());
        String cursor=first.path("nextCursor").asText();
        var last=read(BASE+"members?size=1&cursor="+cursor); assertEquals("u-"+other,last.path("items").get(0).path("id").asText()); assertFalse(last.path("hasNext").asBoolean());
        for (String path:List.of(BASE+"members?size=2",BASE+"stars?size=1","/api/v1/me/followers?size=1",FEED+"?size=1",BASE+"unavailable-stars?size=1"))
            mvc.perform(get(path+"&cursor="+cursor).session(session(viewer))).andExpect(status().isBadRequest());
        mvc.perform(get(BASE+"members?size=1&cursor="+cursor).session(session(other))).andExpect(status().isBadRequest());
        for (String query:List.of("?size=0","?size=101","?size=1&size=2","?q=x","?cursor=","?cursor="+cursor.substring(1)))
            mvc.perform(get(BASE+"members"+query).session(session(viewer))).andExpect(status().isBadRequest());
        mvc.perform(put(starPath()).session(session(viewer))).andExpect(status().isForbidden());
        mvc.perform(get(BASE+"members")).andExpect(status().isUnauthorized());
        mvc.perform(put(starPath()).with(csrf().asHeader())).andExpect(status().isUnauthorized());
        doThrow(new org.springframework.dao.DataAccessResourceFailureException("fixture outage")).when(client).sql(contains("FROM follows"));
        try { mvc.perform(get(BASE+"members").session(session(viewer))).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("DEPENDENCY_UNAVAILABLE")); }
        finally { reset(client); }
    }

    @Test void 같은관계_동시PUT과반대요청_행잠금확정순서() throws Exception {
        try(var pool=Executors.newFixedThreadPool(6)) {
            var start=new CountDownLatch(1);
            var jobs=new java.util.ArrayList<Future<?>>();
            for(int i=0;i<6;i++) jobs.add(pool.submit(()->{ start.await(); return follows.change(viewer,"MEMBER",other,true); }));
            start.countDown(); for(var job:jobs) job.get(20,TimeUnit.SECONDS);
            assertEquals(1,owner.queryForObject("SELECT count(*) FROM follows WHERE user_id=? AND target_type='user' AND target_id=?",Long.class,viewer,other));
            for(boolean first:List.of(true,false)) {
                var written=new CountDownLatch(1); var release=new CountDownLatch(1);
                var one=pool.submit(()->new TransactionTemplate(transactions).execute(s->{
                    var result=follows.change(viewer,"MEMBER",other,first); written.countDown();
                    try { if(!release.await(10,TimeUnit.SECONDS)) throw new IllegalStateException("release timeout"); }
                    catch(InterruptedException e) { throw new IllegalStateException(e); }
                    return result;
                }));
                assertTrue(written.await(10,TimeUnit.SECONDS));
                var two=pool.submit(()->follows.change(viewer,"MEMBER",other,!first));
                try { assertThrows(TimeoutException.class,()->two.get(200,TimeUnit.MILLISECONDS)); }
                finally { release.countDown(); }
                assertEquals(first,one.get(10,TimeUnit.SECONDS).following());
                assertEquals(!first,two.get(10,TimeUnit.SECONDS).following());
                assertEquals(!first,follows.relation(viewer,"MEMBER",other).following());
            }
        }
    }

    @Test void 합성관계10000개_역방향목록_관계정렬_TIC자격_실행계획() {
        owner.update("INSERT INTO users(id,provider,provider_user_id,nickname) SELECT 900000000+n,'perf',n::text,'follow-perf-'||n FROM generate_series(1,10000) n");
        owner.update("INSERT INTO follows(user_id,target_type,target_id) SELECT 900000000+n,'user',900000001+n FROM generate_series(1,10000) n");
        owner.update("INSERT INTO stars(tic_id,confirmed_count,service_status) SELECT 900000000+n,1,'published' FROM generate_series(1,10000) n");
        var point=layout.place(0);
        owner.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) SELECT 900000000+n,900000000+n,'tutorial',?,now(),?,?,?,0 FROM generate_series(1,10000) n",
                point.depthZ(),point.worldX(),point.worldY(),point.layoutVersion());
        follows.change(viewer,"MEMBER",other,true); follows.change(viewer,"STAR",tic,true); follows.change(other,"MEMBER",viewer,true);
        follows.change(viewer,"STAR",900010000L,true); // 발견 테이블 끝의 TIC도 조회한다.
        owner.execute("ANALYZE follows"); owner.execute("ANALYZE star_unlocks");
        clearInvocations(client);
        for(String scope:List.of("members","stars","followers")) follows.list(viewer,scope,page(scope,20));
        var capture=org.mockito.ArgumentCaptor.forClass(String.class); verify(client,atLeastOnce()).sql(capture.capture());
        var named=new org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate(app);
        var params=new org.springframework.jdbc.core.namedparam.MapSqlParameterSource().addValue("member",viewer)
                .addValue("at",null).addValue("id",null).addValue("limit",21);
        for(String sql:capture.getAllValues().stream().filter(s->s.contains("AS label,f.created_at")).toList()) {
            for(int sample=0;sample<3;sample++) {
                var plan=named.queryForObject("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+sql,params,String.class);
                assertTrue(plan.contains("Execution Time"));
                System.out.println("FOLLOW_PLAN "+plan);
            }
        }
    }

    @Test void 팔로워_별_관리목록_동일시각_숫자ID페이지와현재자격() throws Exception {
        long second=tic+1000000000;
        owner.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",second);
        var p=layout.place(0);
        owner.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",third,second,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
        follows.change(viewer,"STAR",tic,true); follows.change(viewer,"STAR",second,true);
        follows.change(other,"MEMBER",viewer,true); follows.change(third,"MEMBER",viewer,true);
        owner.update("UPDATE follows SET created_at='2026-09-01T00:00:00.123456Z' WHERE user_id IN (?,?,?)",viewer,other,third);
        var first=read(BASE+"stars?size=1"); assertEquals(Long.toString(second),first.path("items").get(0).path("id").asText());
        var last=read(BASE+"stars?size=1&cursor="+first.path("nextCursor").asText()); assertEquals(Long.toString(tic),last.path("items").get(0).path("id").asText()); assertFalse(last.path("hasNext").asBoolean());
        var follower=read("/api/v1/me/followers?size=1"); assertEquals("u-"+third,follower.path("items").get(0).path("id").asText());
        assertEquals("u-"+other,read("/api/v1/me/followers?size=1&cursor="+follower.path("nextCursor").asText()).path("items").get(0).path("id").asText());
        owner.update("UPDATE stars SET service_status='hidden' WHERE tic_id IN (?,?)",tic,second);
        assertEquals(0,read(BASE+"stars?size=1&cursor="+first.path("nextCursor").asText()).path("items").size());
        var hidden=read(BASE+"unavailable-stars?size=1"); var hiddenLast=read(BASE+"unavailable-stars?size=1&cursor="+hidden.path("nextCursor").asText());
        assertFalse(hiddenLast.path("hasNext").asBoolean());
        assertTrue(tokens.relation(hidden.path("items").get(0).path("relationId").asText())>tokens.relation(hiddenLast.path("items").get(0).path("relationId").asText()));
        owner.update("UPDATE stars SET service_status='published' WHERE tic_id IN (?,?)",tic,second);
        assertEquals(0,read(BASE+"unavailable-stars?size=1&cursor="+hidden.path("nextCursor").asText()).path("items").size());
    }

    @Test void 관리해제경합_재팔로우는새관계_커서재시작은별도복구() throws Exception {
        follows.change(viewer,"STAR",tic,true);
        String id=tokens.management(owner.queryForObject("SELECT id FROM follows WHERE user_id=?",Long.class,viewer));
        try(var pool=Executors.newFixedThreadPool(2)) {
            var written=new CountDownLatch(1); var release=new CountDownLatch(1);
            var deleting=pool.submit(()->new TransactionTemplate(transactions).execute(s->{
                var result=follows.removeManaged(viewer,id); written.countDown();
                try { if(!release.await(10,TimeUnit.SECONDS)) throw new IllegalStateException("release timeout"); }
                catch(InterruptedException e) { throw new IllegalStateException(e); }
                return result;
            }));
            assertTrue(written.await(10,TimeUnit.SECONDS));
            assertTrue(follows.managed(viewer,id).following()); // 아직 미커밋이므로 기존 관계만 보인다.
            var inserting=pool.submit(()->follows.change(viewer,"STAR",tic,true));
            try { assertThrows(TimeoutException.class,()->inserting.get(200,TimeUnit.MILLISECONDS)); }
            finally { release.countDown(); }
            assertFalse(deleting.get(10,TimeUnit.SECONDS).following()); assertTrue(inserting.get(10,TimeUnit.SECONDS).following());
            follows.removeManaged(viewer,id);
            assertFalse(follows.managed(viewer,id).following()); assertTrue(follows.relation(viewer,"STAR",tic).following());
        }
        String cursor=tokens.next(page("stars",1),java.time.OffsetDateTime.parse("2026-09-01T00:00:00Z"),0,tic);
        var params=new LinkedMultiValueMap<String,String>();params.add("size","1");params.add("cursor",cursor);
        assertThrows(com.planetory.backend.global.error.BusinessException.class,()->new FollowTokens().page(viewer,"stars",params));
        assertEquals(1,read(BASE+"stars").path("items").size());
        assertEquals(tokens.relation(id),new FollowTokens().relation(id));
    }
}
