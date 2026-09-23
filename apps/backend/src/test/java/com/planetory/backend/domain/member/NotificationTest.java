package com.planetory.backend.domain.member;

import com.planetory.backend.domain.member.service.NotificationService;
import com.planetory.backend.domain.member.service.NotificationTokens;
import com.planetory.backend.global.security.MemberPrincipal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
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
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.json.JsonMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;

@Testcontainers
@ActiveProfiles("local")
@SpringBootTest(properties="NOTIFICATION_SIGNING_KEY=notification-test-only-key-at-least-32-bytes")
@AutoConfigureMockMvc
class NotificationTest {
    @Container static final PostgreSQLContainer<?> DB=new PostgreSQLContainer<>("postgres:18.6-alpine");
    static JdbcTemplate owner;
    static JdbcTemplate gold;
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword())
                .locations("classpath:db/migration").repeatableSqlMigrationPrefix("preupgrade").target("22").load().migrate();
        owner=new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword()));
        long legacy=owner.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test','legacy','legacy') RETURNING id",Long.class);
        owner.update("INSERT INTO user_settings(user_id) VALUES (?)",legacy);
        owner.update("INSERT INTO notifications(user_id,type,payload,read_at) VALUES (?,'reopen','{\"ticId\":\"99\",\"bundleId\":\"1\"}',now())",legacy);
        var original=owner.queryForMap("SELECT id,user_id,type,payload,read_at,created_at FROM notifications WHERE user_id=?",legacy);
        var f=Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword())
                .locations("classpath:db/migration").load();
        f.migrate(); f.validate(); assertEquals(0,f.migrate().migrationsExecuted);
        for(String table:new String[]{"notification_outbox","notification_events","notification_candidate_changes","notification_signal_state"})
            assertNotNull(owner.queryForObject("SELECT obj_description(?::regclass,'pg_class')",String.class,table));
        assertEquals(original,owner.queryForMap("SELECT id,user_id,type,payload,read_at,created_at FROM notifications WHERE user_id=?",legacy));
        assertTrue(owner.queryForObject("SELECT event_key IS NULL AND published_at IS NULL AND publication_seq IS NULL FROM notifications WHERE user_id=?",Boolean.class,legacy));
        assertTrue(owner.queryForObject("SELECT NOT (notification_prefs->>'follow')::boolean AND (notification_prefs->>'comment')::boolean AND (notification_prefs->>'relabel')::boolean FROM user_settings WHERE user_id=?",Boolean.class,legacy));
        owner.execute("CREATE USER notification_test_app PASSWORD 'test'");
        owner.execute("GRANT planetory_app TO notification_test_app");
        owner.execute("CREATE USER notification_test_gold PASSWORD 'test'");
        owner.execute("GRANT planetory_gold_writer TO notification_test_gold");
        gold=new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(),"notification_test_gold","test"));
        r.add("spring.datasource.url",DB::getJdbcUrl);
        r.add("spring.datasource.username",()->"notification_test_app");
        r.add("spring.datasource.password",()->"test");
        r.add("spring.flyway.url",DB::getJdbcUrl);
        r.add("spring.flyway.user",DB::getUsername);
        r.add("spring.flyway.password",DB::getPassword);
    }
    @Autowired NotificationService notices;
    @Autowired com.planetory.backend.domain.exploration.service.GalaxyLayout layout;
    @Autowired com.planetory.backend.domain.comment.service.CommentService comments;
    @Autowired PlatformTransactionManager manager;
    @Autowired JdbcTemplate app;
    @Autowired MockMvc mvc;
    @MockitoBean Clock clock;
    static final Instant NOW=Instant.parse("2026-09-23T01:00:00Z");
    static final JsonMapper JSON=JsonMapper.builder().build();
    static final String BASE="/api/v1/me/notifications";
    long recipient,actor,post;
    @BeforeEach void seed() {
        when(clock.instant()).thenReturn(NOW); when(clock.getZone()).thenReturn(ZoneOffset.UTC);
        recipient=member(); actor=member(); post=post(recipient);
    }
    long member() {
        long id=owner.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",
                Long.class,UUID.randomUUID().toString(),UUID.randomUUID().toString());
        owner.update("INSERT INTO user_settings(user_id) VALUES (?)",id); return id;
    }
    long post(long author) {
        return owner.queryForObject("INSERT INTO posts(kind,user_id,board,title,body,status) VALUES ('user',?,'free','제목','본문','visible') RETURNING id",Long.class,author);
    }
    TransactionTemplate tx() { return new TransactionTemplate(manager); }
    void capture(String key) { tx().executeWithoutResult(s->notices.record(recipient,"comment",key,
            Map.of("actorId",actor,"postId",post,"targetKind","POST"),null)); }
    String state(String key) { return owner.queryForObject("SELECT state FROM notification_outbox WHERE user_id=? AND event_key=?",String.class,recipient,key); }
    Map<String,Object> setting(String kind,boolean enabled) { return Map.of("preferences",Map.of(kind,enabled)); }
    MockHttpSession session(long member) {
        var session=new MockHttpSession(); var context=SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new TestingAuthenticationToken(new MemberPrincipal(member),null,"ROLE_USER"));
        session.setAttribute("SPRING_SECURITY_CONTEXT",context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",Instant.now());
        return session;
    }
    @Test void source_rollback_duplicate_retry_and_read_are_stable() {
        assertThrows(IllegalStateException.class,()->tx().executeWithoutResult(s->{ capture("rollback"); throw new IllegalStateException(); }));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE user_id=?",Integer.class,recipient));
        capture("event"); capture("event");
        assertEquals("pending",state("event"));
        var first=notices.list(recipient,20,false,null);
        assertEquals(1,first.items().size());
        long id=Long.parseLong(first.items().getFirst().notificationId().substring(2));
        notices.read(recipient,id);
        var before=owner.queryForMap("SELECT id,created_at,published_at,publication_seq,read_at FROM notifications WHERE id=?",id);
        capture("event"); notices.dispatch(recipient);
        assertEquals(before,owner.queryForMap("SELECT id,created_at,published_at,publication_seq,read_at FROM notifications WHERE id=?",id));
        assertEquals(0,notices.count(recipient).unreadCount());
    }
    @Test void off_on_excludes_pending_and_preserves_published_and_other_settings() {
        owner.update("UPDATE user_settings SET notification_prefs='{\"follow\":false}'::jsonb WHERE user_id=?",recipient);
        var prefs=notices.preferences(recipient).preferences();
        assertFalse(prefs.get("FOLLOW")); assertTrue(prefs.get("RELABEL")); assertTrue(prefs.get("COMMENT"));
        capture("published"); notices.dispatch(recipient); capture("pending");
        notices.changePreferences(recipient,setting("COMMENT",false));
        notices.changePreferences(recipient,setting("COMMENT",true)); notices.dispatch(recipient);
        assertEquals("excluded",state("pending")); assertEquals(1,notices.count(recipient).unreadCount());
        assertFalse(notices.preferences(recipient).preferences().get("FOLLOW"));
        assertTrue(owner.queryForObject("SELECT star_list_public AND NOT onboarding_done FROM user_settings WHERE user_id=?",Boolean.class,recipient));
    }
    @Test void off_epoch_excludes_source_that_commits_after_off_and_on() throws Exception {
        var captured=new CountDownLatch(1); var release=new CountDownLatch(1);
        try (var pool=Executors.newSingleThreadExecutor()) {
            Future<?> source=pool.submit(()->tx().executeWithoutResult(s->{ capture("late");captured.countDown();await(release); }));
            assertTrue(captured.await(10,TimeUnit.SECONDS));
            try { notices.changePreferences(recipient,setting("COMMENT",false)); notices.changePreferences(recipient,setting("COMMENT",true)); }
            finally { release.countDown(); }
            source.get(10,TimeUnit.SECONDS);
        }
        notices.dispatch(recipient); assertEquals("excluded",state("late")); assertEquals(0,notices.count(recipient).unreadCount());
    }
    @Test void read_boundary_excludes_late_commit_with_smaller_source_id_and_is_member_bound() throws Exception {
        var captured=new CountDownLatch(1);var release=new CountDownLatch(1);
        String boundary;
        try(var pool=Executors.newSingleThreadExecutor()) {
            Future<?> slow=pool.submit(()->tx().executeWithoutResult(s->{ capture("slow");captured.countDown();await(release); }));
            assertTrue(captured.await(10,TimeUnit.SECONDS));
            try {
                capture("fast"); boundary=notices.list(recipient,1,true,null).readBoundary();
            } finally {release.countDown();}
            slow.get(10,TimeUnit.SECONDS);
        }
        notices.dispatch(recipient);
        assertEquals(1,notices.readThrough(recipient,boundary).unreadCount());
        assertThrows(RuntimeException.class,()->notices.readThrough(actor,boundary));
        assertThrows(RuntimeException.class,()->notices.readThrough(recipient,boundary+"x"));
    }
    @Test void hidden_and_withdrawn_actor_remove_content_and_target_without_reading() {
        capture("event");var item=notices.list(recipient,20,false,null).items().getFirst();
        long id=Long.parseLong(item.notificationId().substring(2));
        owner.update("UPDATE posts SET status='hidden' WHERE id=?",post);
        assertFalse(notices.target(recipient,id).available());
        owner.update("UPDATE posts SET status='visible' WHERE id=?",post);
        owner.update("UPDATE users SET status='withdrawn',withdrawn_at=now() WHERE id=?",actor);
        var hidden=notices.list(recipient,20,false,null).items().getFirst();
        assertFalse(hidden.available());assertEquals("",hidden.title());assertEquals("",hidden.body());assertFalse(hidden.read());
        assertNull(notices.target(recipient,id).target());assertEquals(1,notices.count(recipient).unreadCount());
    }
    @Test void recipient_withdrawal_permanently_excludes_pending() {
        capture("event");owner.update("UPDATE users SET status='withdrawn',withdrawn_at=now() WHERE id=?",recipient);
        notices.dispatch(recipient);assertEquals("excluded",state("event"));
    }
    @Test void expiration_does_not_delete_source_or_restart_retention() {
        capture("event");var item=notices.list(recipient,20,false,null).items().getFirst();
        when(clock.instant()).thenReturn(NOW.plusSeconds(90L*86400).minusNanos(1000));
        assertEquals(1,notices.count(recipient).unreadCount());
        when(clock.instant()).thenReturn(NOW.plusSeconds(90L*86400));
        assertEquals(0,notices.count(recipient).unreadCount());assertTrue(notices.list(recipient,20,false,null).items().isEmpty());
        capture("event");notices.dispatch(recipient);assertEquals(0,notices.count(recipient).unreadCount());
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM notifications WHERE user_id=? AND id=?",Integer.class,recipient,Long.parseLong(item.notificationId().substring(2))));
    }
    @Test void existing_reopen_row_is_published_once_and_legacy_never_replayed() {
        long source=owner.queryForObject("INSERT INTO notifications(user_id,type,payload) VALUES (?,'reopen','{\"ticId\":\"11\",\"bundleId\":\"1\"}') RETURNING id",Long.class,recipient);
        assertEquals(0,notices.count(recipient).unreadCount());
        owner.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (11,1,'published')");
        var position=layout.place(0);
        owner.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,11,'tutorial',?,now(),?,?,?,0)",
                recipient,position.depthZ(),position.worldX(),position.worldY(),position.layoutVersion());
        var original=owner.queryForMap("SELECT id,payload,created_at,read_at FROM notifications WHERE id=?",source);
        tx().executeWithoutResult(s->notices.record(recipient,"reopen","reopen:new",Map.of("ticId","11","bundleId","1"),source));
        notices.dispatch(recipient);
        assertEquals(original,owner.queryForMap("SELECT id,payload,created_at,read_at FROM notifications WHERE id=?",source));
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM notifications WHERE user_id=?",Integer.class,recipient));
        assertEquals(source,Long.parseLong(notices.list(recipient,20,false,null).items().getFirst().notificationId().substring(2)));
        notices.read(recipient,source);capture("another");notices.dispatch(recipient);
        assertNotNull(owner.queryForObject("SELECT read_at FROM notifications WHERE id=?",java.sql.Timestamp.class,source));
    }
    @Test void follow_requires_original_relation_and_excludes_self_and_late_followers() {
        long tic=12345;
        long relation=owner.queryForObject("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?) RETURNING id",Long.class,recipient,tic);
        owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",actor,tic);
        tx().executeWithoutResult(s->notices.postCreated(actor,post,tic,false));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE user_id=?",Integer.class,actor));
        long late=member();owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",late,tic);
        owner.update("DELETE FROM follows WHERE id=?",relation);
        owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",recipient,tic);
        notices.dispatch(recipient);notices.dispatch(late);
        assertEquals("excluded",state("post:"+post));assertEquals(0,notices.count(late).unreadCount());
        tx().executeWithoutResult(s->notices.commentCreated(recipient,recipient,post,1));
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE user_id=?",Integer.class,recipient));
    }
    @Test void real_comment_write_notifies_owner_and_target_cursor_reaches_old_comment() {
        var parent=com.planetory.backend.domain.comment.service.CommentService.ParentType.POST;
        var command=new com.planetory.backend.domain.comment.service.CommentService.CreateCommand(parent,post,"댓글",java.util.List.of(),java.util.List.of());
        var created=comments.create(actor,command);
        for(int i=0;i<21;i++) comments.create(recipient,command);
        var page=notices.list(recipient,20,false,null);
        assertEquals(1,page.items().size());
        long id=Long.parseLong(page.items().getFirst().notificationId().substring(2));
        var target=notices.target(recipient,id).target();
        assertEquals(created.commentId(),target.get("commentId"));
        var discussion=comments.list(post,parent,20,(String)target.get("discussionCursor"));
        assertEquals(created.commentId(),discussion.items().getFirst().commentId());
    }
    @Test void failed_recipient_dispatch_rolls_back_and_other_recipient_can_finish() {
        long badSource=owner.queryForObject("INSERT INTO notifications(user_id,type,payload) VALUES (?,'comment','{}') RETURNING id",Long.class,actor);
        tx().executeWithoutResult(s->notices.record(recipient,"comment","broken",Map.of("postId",post,"targetKind","POST"),badSource));
        assertThrows(IllegalStateException.class,()->notices.dispatch(recipient));assertEquals("pending",state("broken"));
        tx().executeWithoutResult(s->notices.record(actor,"comment","healthy",Map.of("postId",post,"targetKind","POST"),null));
        notices.dispatch(actor);assertEquals(1,notices.count(actor).unreadCount());
    }
    @Test void crossed_actor_locks_and_recipient_capture_do_not_deadlock_and_parallel_dispatch_is_unique() throws Exception {
        var both=new CyclicBarrier(2);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var a=pool.submit(()->cross(actor,recipient,"a",both));var b=pool.submit(()->cross(recipient,actor,"b",both));
            a.get(10,TimeUnit.SECONDS);b.get(10,TimeUnit.SECONDS);
            var x=pool.submit(()->notices.dispatch(recipient));var y=pool.submit(()->notices.dispatch(recipient));
            x.get(10,TimeUnit.SECONDS);y.get(10,TimeUnit.SECONDS);
        }
        assertEquals(1,notices.count(recipient).unreadCount());
    }
    void cross(long source,long target,String key,CyclicBarrier barrier) {
        tx().executeWithoutResult(s->{
            app.queryForObject("SELECT id FROM users WHERE id=? FOR UPDATE",Long.class,source);
            try {barrier.await(10,TimeUnit.SECONDS);} catch(Exception e){throw new RuntimeException(e);}
            notices.record(target,"comment",key,Map.of("postId",post,"targetKind","POST"),null);
        });
    }
    @Test void http_ownership_validation_csrf_and_no_store() throws Exception {
        capture("event");
        var response=mvc.perform(get(BASE).session(session(recipient))).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control","no-store")).andReturn().getResponse().getContentAsString();
        String id=JSON.readTree(response).get("items").get(0).get("notificationId").asText();
        mvc.perform(get(BASE)).andExpect(status().isUnauthorized());
        mvc.perform(get(BASE+"/"+id+"/target").session(session(actor))).andExpect(status().isNotFound());
        mvc.perform(patch(BASE+"/"+id).session(session(recipient)).contentType("application/json").content("{\"read\":true}")).andExpect(status().isForbidden());
        mvc.perform(patch(BASE+"/"+id).session(session(recipient)).with(csrf().asHeader()).contentType("application/json").content("{\"read\":false}")).andExpect(status().isBadRequest());
        for(String body:new String[]{"{}","{\"preferences\":{}}","{\"preferences\":{\"FOLLOW\":null}}","{\"preferences\":{\"FOLLOW\":\"false\"}}","{\"preferences\":{\"UNKNOWN\":true}}"})
            mvc.perform(patch("/api/v1/me/notification-settings").session(session(recipient)).with(csrf().asHeader())
                    .contentType("application/json").content(body)).andExpect(status().isBadRequest());
        for(String q:new String[]{"?size=0","?size=x","?unreadOnly=yes","?cursor=forged","?size=1&size=2"})
            mvc.perform(get(BASE+q).session(session(recipient))).andExpect(status().isBadRequest());
    }
    @Test void signing_key_is_server_scoped_and_required_only_for_signed_tokens() {
        var key="notification-test-only-key-at-least-32-bytes";
        var first=new NotificationTokens(key);var second=new NotificationTokens(key);
        String token=first.sign(recipient,"read","1");assertEquals("1",second.verify(recipient,"read",token));
        assertThrows(RuntimeException.class,()->new NotificationTokens(key+"rotated").verify(recipient,"read",token));
        assertThrows(RuntimeException.class,()->new NotificationTokens("").sign(recipient,"read","1"));
        assertThrows(RuntimeException.class,()->second.verify(recipient,"page",token));
        assertTrue(app.queryForObject("SELECT has_column_privilege(current_user,'notifications','read_at','UPDATE')",Boolean.class));
        assertFalse(app.queryForObject("SELECT has_column_privilege(current_user,'notifications','payload','UPDATE')",Boolean.class));
        assertFalse(app.queryForObject("SELECT has_table_privilege(current_user,'notification_outbox','DELETE')",Boolean.class));
    }
    @Test void challenge_start_captures_eligible_members_atomically_without_late_replay() {
        String[] intents={"deep_confirmed","shallow_confirmed","fp","deep_fp","multi_fp"};
        for(int i=1;i<=5;i++) {
            owner.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",70000+i);
            owner.update("INSERT INTO tutorial_stars(seq,tic_id,intent,active) VALUES (?,?,?,true)",i,70000+i,intents[i-1]);
            owner.update("INSERT INTO user_star_progress(user_id,tic_id,progress_stage,completed_at) VALUES (?,?,'completed',now())",recipient,70000+i);
        }
        long round=owner.queryForObject("INSERT INTO challenge_rounds(round_no,starts_on,ends_on,target_tic_id,description,status) VALUES (1,current_date,current_date+7,70001,'회차','planned') RETURNING id",Long.class);
        new TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(owner.getDataSource())).executeWithoutResult(s->{
            owner.update("UPDATE challenge_rounds SET status='active' WHERE id=?",round);s.setRollbackOnly();
        });
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE event_key=?",Integer.class,"challenge:"+round));
        owner.update("UPDATE challenge_rounds SET status='active' WHERE id=?",round);
        for(int i=1;i<=5;i++) owner.update("INSERT INTO user_star_progress(user_id,tic_id,progress_stage,completed_at) VALUES (?,?,'completed',now())",actor,70000+i);
        owner.update("UPDATE challenge_rounds SET description='수정' WHERE id=?",round);
        assertEquals(0,notices.count(actor).unreadCount());
        var first=notices.list(recipient,20,false,null).items().getFirst();
        owner.update("UPDATE challenge_rounds SET status='closed' WHERE id=?",round);
        assertEquals("cr-"+round,notices.target(recipient,Long.parseLong(first.notificationId().substring(2))).target().get("roundId"));
        owner.update("UPDATE challenge_rounds SET status='active' WHERE id=?",round);
        assertEquals(1,notices.count(recipient).unreadCount());assertEquals(0,notices.count(actor).unreadCount());
        // 활성 개수가 바뀌어도 Java 자격과 사건 당시 수신 판정은 함께 false/true여야 한다.
        var tutorial=new com.planetory.backend.domain.exploration.service.TutorialRepository(
                org.springframework.jdbc.core.simple.JdbcClient.create(owner));
        for(int active:new int[]{0,4,5}) {
            new TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(owner.getDataSource())).executeWithoutResult(st->{
                owner.update("UPDATE challenge_rounds SET status='closed' WHERE id=?",round);
                owner.update("UPDATE tutorial_stars SET active=(seq<=?)",active);
                // 재개되어도 과거 완료 시각이 남으면 완료로 센다.
                owner.update("UPDATE user_star_progress SET progress_stage='in_progress' WHERE user_id=?",recipient);
                long next=owner.queryForObject("INSERT INTO challenge_rounds(round_no,starts_on,ends_on,target_tic_id,description,status) VALUES (?,current_date,current_date+7,70001,'판정 일치','active') RETURNING id",Long.class,active+2);
                boolean eligible=tutorial.isTutorialCompleted(recipient);
                assertEquals(active==5,eligible);
                assertEquals(eligible,owner.queryForObject("SELECT EXISTS(SELECT 1 FROM notification_outbox WHERE event_key=? AND user_id=?)",Boolean.class,"challenge:"+next,recipient));
                st.setRollbackOnly();
            });
        }
    }

    long[] signal() {
        long tic=Math.abs(UUID.randomUUID().getMostSignificantBits()%900000000)+100000;
        owner.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",tic);
        String manifest="{\"segment_ids\":[1],\"array_checksums\":{},\"residual_model_version\":\"rm-1\",\"periodogram_config_version\":\"pg-1\",\"binning\":{},\"period_grid\":{},\"fine_tune\":{},\"curve_steps\":{}}";
        long bundle=owner.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days) VALUES (?,?,'staging',?::jsonb,1500.5,27.4) RETURNING id",Long.class,tic,UUID.randomUUID().toString(),manifest);
        long candidate=owner.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) VALUES (?,'active',?,1,3.5,1501,2.8,400,12.5,'{}',true,false) RETURNING id",Long.class,tic,bundle);
        return new long[]{tic,bundle,candidate};
    }
    void unlock(long member,long tic) {
        var p=layout.place(0);
        owner.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",member,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
    }
    @Test void common_reopen_waits_for_publication_and_personal_reason_keeps_one_notice() {
        var signal=signal();long tic=signal[0],bundle=signal[1];unlock(actor,tic);
        owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",recipient,tic);
        assertEquals(0,notices.count(recipient).unreadCount());
        gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        var first=notices.list(recipient,20,false,null).items().getFirst();long id=Long.parseLong(first.notificationId().substring(2));
        assertEquals("STAR_BOARD",notices.target(recipient,id).target().get("kind"));
        assertTrue(first.title().contains("팔로우"));
        long source=owner.queryForObject("INSERT INTO notifications(user_id,type,payload) VALUES (?,'reopen',jsonb_build_object('ticId',?::text,'bundleId',?::text,'newDiscoverableCount',1)) RETURNING id",Long.class,recipient,Long.toString(tic),Long.toString(bundle));
        tx().executeWithoutResult(st->notices.record(recipient,"reopen","reopen:"+tic+":"+bundle,Map.of("ticId",Long.toString(tic),"bundleId",Long.toString(bundle)),source));
        notices.dispatch(recipient);
        assertEquals(1,notices.count(recipient).unreadCount());
        assertEquals(first.notificationId(),notices.list(recipient,20,false,null).items().getFirst().notificationId());
        assertEquals(2,owner.queryForObject("SELECT count(*) FROM notifications WHERE user_id=?",Integer.class,recipient));
        owner.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        assertEquals(1,notices.count(recipient).unreadCount());
    }
    @Test void relabel_uses_final_committed_values_and_matching_experience_without_achievement() {
        var signal=signal();long tic=signal[0],bundle=signal[1],candidate=signal[2];unlock(recipient,tic);
        owner.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        owner.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,rule_version,applied_at,source_refs) VALUES (?,'pc','analysis',NULL,'rule-0',now(),'[]')",candidate);
        owner.update("INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,removed_candidate_ids,submitted_period,phase_start,phase_end,user_judgment,fold_reference_time_btjd,evidence_checks,match_result,matched_candidate_id,achievement_result,residual_model_version,periodogram_config_version,rule_version) VALUES (?,?,?,?::uuid,'candidate',0,'{}',3.5,0.4,0.6,'LIKELY_PLANET',1500.5,'[]','matched',?,'pending_publish','rm-1','pg-1','rule-0')",recipient,tic,bundle,UUID.randomUUID().toString(),candidate);
        var tx=new TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(owner.getDataSource()));
        tx.executeWithoutResult(st->{owner.update("UPDATE candidate_dispositions SET disposition='none' WHERE candidate_id=?",candidate);owner.update("UPDATE candidate_dispositions SET disposition='pc' WHERE candidate_id=?",candidate);});
        assertEquals(0,notices.count(recipient).unreadCount());
        tx.executeWithoutResult(st->{owner.update("UPDATE candidate_dispositions SET disposition='none' WHERE candidate_id=?",candidate);st.setRollbackOnly();});
        assertEquals(0,notices.count(recipient).unreadCount());
        gold.update("UPDATE candidate_dispositions SET disposition='none' WHERE candidate_id=?",candidate);
        assertEquals("RELABEL",notices.list(recipient,20,false,null).items().getFirst().kind());
        assertEquals(1,notices.count(recipient).unreadCount());assertEquals(0,notices.count(actor).unreadCount());
        long execution=owner.queryForObject("INSERT INTO ai_executions(model_version,status,started_at) VALUES ('m','success',now()) RETURNING id",Long.class);
        long evaluation=owner.queryForObject("INSERT INTO ai_evaluations(candidate_id,execution_id,score,verdict,threshold_version) VALUES (?,?,0.8,'approved','v1') RETURNING id",Long.class,candidate,execution);
        owner.update("UPDATE ai_evaluations SET score=0.9 WHERE id=?",evaluation);
        assertEquals(1,notices.count(recipient).unreadCount());
        tx.executeWithoutResult(st->{owner.update("UPDATE ai_evaluations SET verdict='hold' WHERE id=?",evaluation);owner.update("UPDATE ai_executions SET status='failed' WHERE id=?",execution);});
        assertEquals(1,notices.count(recipient).unreadCount());
        owner.update("UPDATE ai_executions SET status='success' WHERE id=?",execution);
        assertEquals(2,notices.count(recipient).unreadCount());
        long older=owner.queryForObject("INSERT INTO ai_executions(model_version,status,started_at) VALUES ('old','success',now()-interval '1 day') RETURNING id",Long.class);
        owner.update("INSERT INTO ai_evaluations(candidate_id,execution_id,verdict,threshold_version) VALUES (?,?,'rejected','old')",candidate,older);
        assertEquals(2,notices.count(recipient).unreadCount());
        owner.update("UPDATE ai_executions SET status='failed' WHERE id=?",execution);
        assertEquals(2,notices.count(recipient).unreadCount());
    }

    @Test void gold_can_only_trigger_fixed_notification_paths_and_cannot_read_members_or_call_helpers() {
        assertThrows(org.springframework.dao.DataAccessException.class,()->gold.queryForList("SELECT id FROM users"));
        assertThrows(org.springframework.dao.DataAccessException.class,()->gold.queryForList("SELECT * FROM notification_outbox"));
        assertThrows(org.springframework.dao.DataAccessException.class,()->gold.execute("SELECT notification_signal_changed(1)"));
        assertThrows(org.springframework.dao.DataAccessException.class,()->app.execute("SELECT notification_signal_changed(1)"));
        assertFalse(gold.queryForObject("SELECT has_table_privilege(current_user,'user_settings','UPDATE')",Boolean.class));
        assertFalse(gold.queryForObject("SELECT has_schema_privilege(current_user,current_schema(),'CREATE')",Boolean.class));
    }
    @Test void personal_reopen_survives_follow_off_but_cannot_revive_after_its_own_off() {
        var signal=signal();long tic=signal[0],bundle=signal[1];unlock(recipient,tic);
        owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",recipient,tic);
        gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        notices.changePreferences(recipient,setting("FOLLOW",false));
        long source=owner.queryForObject("INSERT INTO notifications(user_id,type,payload) VALUES (?,'reopen',jsonb_build_object('ticId',?::text,'bundleId',?::text)) RETURNING id",Long.class,recipient,Long.toString(tic),Long.toString(bundle));
        var payload=Map.<String,Object>of("ticId",Long.toString(tic),"bundleId",Long.toString(bundle));String key="reopen:"+tic+":"+bundle;
        tx().executeWithoutResult(st->notices.record(recipient,"reopen",key,payload,source));
        assertEquals(source,Long.parseLong(notices.list(recipient,20,false,null).items().getFirst().notificationId().substring(2)));
        notices.changePreferences(recipient,setting("REOPEN",false));
        notices.changePreferences(recipient,setting("REOPEN",true));
        tx().executeWithoutResult(st->notices.record(recipient,"reopen",key,payload,source));
        assertEquals(1,notices.count(recipient).unreadCount());
        assertEquals(1,owner.queryForObject("SELECT count(*) FROM notifications WHERE user_id=?",Integer.class,recipient));
        long pending=owner.queryForObject("INSERT INTO notifications(user_id,type,payload) VALUES (?,'reopen','{}') RETURNING id",Long.class,recipient);
        tx().executeWithoutResult(st->notices.record(recipient,"reopen","pending-own",payload,pending));
        notices.changePreferences(recipient,setting("REOPEN",false));notices.changePreferences(recipient,setting("REOPEN",true));
        tx().executeWithoutResult(st->notices.record(recipient,"reopen","pending-own",payload,pending));
        assertEquals("excluded",state("pending-own"));assertEquals(1,notices.count(recipient).unreadCount());
    }

    @Test void bundle_rollback_and_final_undiscoverable_state_never_create_follower_news() {
        var signal=signal();long tic=signal[0],bundle=signal[1],candidate=signal[2];
        owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",recipient,tic);
        var tx=new TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(gold.getDataSource()));
        tx.executeWithoutResult(st->{gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);st.setRollbackOnly();});
        assertEquals(0,notices.count(recipient).unreadCount());
        tx.executeWithoutResult(st->{
            gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
            gold.update("UPDATE candidates SET discoverable=false WHERE id=?",candidate);
            gold.update("UPDATE candidates SET discoverable=true WHERE id=?",candidate);
            gold.update("UPDATE candidates SET discoverable=false WHERE id=?",candidate);
        });
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM notification_events WHERE event_key=?",Integer.class,"reopen:"+tic+":"+bundle));
        assertEquals(0,notices.count(recipient).unreadCount());
    }
    @Test void gold_event_to_two_account_http_settings_read_and_access() throws Exception {
        var signal=signal();long tic=signal[0],bundle=signal[1];unlock(actor,tic);
        for(long user:new long[]{recipient,actor}) owner.update("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,'star',?)",user,tic);
        var first=session(recipient);var second=session(actor);
        mvc.perform(patch("/api/v1/me/notification-settings").session(second).with(csrf().asHeader())
                .contentType("application/json").content(JSON.writeValueAsString(setting("FOLLOW",false))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.preferences.FOLLOW").value(false));
        gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        mvc.perform(patch("/api/v1/me/notification-settings").session(second).with(csrf().asHeader())
                .contentType("application/json").content(JSON.writeValueAsString(setting("FOLLOW",true)))).andExpect(status().isOk());
        mvc.perform(get(BASE+"/unread-count").session(second)).andExpect(status().isOk()).andExpect(jsonPath("$.unreadCount").value(0));
        var response=mvc.perform(get(BASE).session(first)).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1)).andExpect(jsonPath("$.items[0].kind").value("REOPEN"))
                .andReturn().getResponse().getContentAsString();
        var page=JSON.readTree(response);String id=page.get("items").get(0).get("notificationId").asText();
        String read=JSON.writeValueAsString(Map.of("through",page.get("readBoundary").asText()));
        mvc.perform(get(BASE+"/"+id+"/target").session(first)).andExpect(status().isOk())
                .andExpect(jsonPath("$.target.kind").value("STAR_BOARD"));
        assertEquals(0,owner.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id=? AND tic_id=?",Integer.class,recipient,tic));
        mvc.perform(get(BASE+"/"+id+"/target").session(second)).andExpect(status().isNotFound());
        mvc.perform(patch(BASE+"/read").session(second).with(csrf().asHeader()).contentType("application/json").content(read)).andExpect(status().isBadRequest());
        mvc.perform(patch(BASE+"/read").session(first).with(csrf().asHeader()).contentType("application/json").content(read))
                .andExpect(status().isOk()).andExpect(jsonPath("$.unreadCount").value(0));
        owner.update("UPDATE stars SET service_status='hidden' WHERE tic_id=?",tic);
        mvc.perform(get(BASE+"/"+id+"/target").session(first)).andExpect(status().isOk()).andExpect(jsonPath("$.available").value(false));
        mvc.perform(get(BASE).session(first)).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].title").value(""));
    }

    @Test void thousand_followers_are_captured_once_in_the_gold_commit() {
        var signal=signal();long tic=signal[0],bundle=signal[1];unlock(actor,tic);
        String prefix=UUID.randomUUID().toString();
        owner.update("INSERT INTO users(provider,provider_user_id,nickname) SELECT 'test',?||i,?||i FROM generate_series(1,1000) i",prefix,prefix);
        owner.update("INSERT INTO user_settings(user_id) SELECT id FROM users WHERE provider_user_id LIKE ?",prefix+"%");
        owner.update("INSERT INTO follows(user_id,target_type,target_id) SELECT id,'star',? FROM users WHERE provider_user_id LIKE ?",tic,prefix+"%");
        long start=System.nanoTime();
        gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        long captureNanos=System.nanoTime()-start;
        String key="reopen:"+tic+":"+bundle;
        assertEquals(1000,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE event_key=?",Integer.class,key));
        gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
        assertEquals(1000,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE event_key=?",Integer.class,key));
        long user=owner.queryForObject("SELECT min(user_id) FROM notification_outbox WHERE event_key=?",Long.class,key);
        start=System.nanoTime();assertEquals(1,notices.count(user).unreadCount());long deliveryNanos=System.nanoTime()-start;
        System.out.printf("notification local sample: recipients=1000 gold_commit_ms=%.1f single_recipient_dispatch_ms=%.1f%n",captureNanos/1e6,deliveryNanos/1e6);
    }

    @Test void bundle_candidate_count_commit_cost_is_measured_separately_from_recipients() {
        for(int count:new int[]{1,100,1000}) {
            var signal=signal();long tic=signal[0],bundle=signal[1];
            owner.update("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed) SELECT ?,'active',?,i,3.5,1501,2.8,400,12.5,'{}',true,false FROM generate_series(2,?) i",tic,bundle,count);
            long start=System.nanoTime();
            gold.update("UPDATE publication_bundles SET status='current' WHERE id=?",bundle);
            long nanos=System.nanoTime()-start;
            assertEquals(count,owner.queryForObject("SELECT count(*) FROM notification_signal_state s JOIN candidates c ON c.id=s.candidate_id WHERE c.updated_bundle_id=?",Integer.class,bundle));
            assertEquals(1,owner.queryForObject("SELECT count(*) FROM notification_events WHERE event_key=?",Integer.class,"reopen:"+tic+":"+bundle));
            assertEquals(0,owner.queryForObject("SELECT count(*) FROM notification_outbox WHERE event_key=?",Integer.class,"reopen:"+tic+":"+bundle));
            System.out.printf("notification candidate sample: candidates=%d recipients=0 gold_commit_ms=%.1f%n",count,nanos/1e6);
        }
    }

    static void await(CountDownLatch latch) {
        try { if(!latch.await(10,TimeUnit.SECONDS))throw new AssertionError("동시성 테스트 대기 초과"); }
        catch(InterruptedException e){Thread.currentThread().interrupt();throw new RuntimeException(e);}
    }
}
