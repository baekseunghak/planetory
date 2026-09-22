package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.statistics.dto.StatisticsDtos.BlockStatus;
import com.planetory.backend.domain.statistics.dto.StatisticsDtos.MetricStatus;
import com.planetory.backend.global.security.MemberPrincipal;
import java.sql.DriverManager;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.json.JsonMapper;
import static com.planetory.backend.domain.statistics.dto.StatisticsDtos.ZONE;
import static com.planetory.backend.domain.statistics.service.StatisticsAggregationService.Result.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class StatisticsAggregationTest {
    @Container static final PostgreSQLContainer<?> DB=new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url",DB::getJdbcUrl);
        r.add("spring.datasource.username",DB::getUsername);
        r.add("spring.datasource.password",DB::getPassword);
    }
    @Autowired JdbcTemplate jdbc;
    @Autowired StatisticsAggregationService aggregation;
    @Autowired StatisticsSnapshotService snapshots;
    @Autowired GlobalStatisticsService global;
    @Autowired PlatformTransactionManager transactions;
    @Autowired MockMvc mvc;
    @Autowired JsonMapper json;
    @Autowired ComparisonMetricQuery comparisonMetrics;
    long member,bundle,candidate;
    OffsetDateTime cutoff;

    @BeforeEach void seed() {
        jdbc.execute("TRUNCATE users,stars,stats_snapshots CASCADE");
        jdbc.execute("REFRESH MATERIALIZED VIEW global_stats WITH NO DATA");
        cutoff=LocalDate.now(ZONE).atStartOfDay(ZONE).toOffsetDateTime();
        member=member();
        jdbc.update("INSERT INTO stars VALUES (101,NULL,NULL,NULL,1,'published')");
        bundle=jdbc.queryForObject("""
                INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days)
                VALUES (101,'test','current','{"segment_ids":[1],"array_checksums":{},"residual_model_version":"r",
                "periodogram_config_version":"p","binning":{},"period_grid":{},"fine_tune":{},"curve_steps":{}}',1,10) RETURNING id
                """,Long.class);
        candidate=candidate();
    }

    long member() {
        String id=UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname,created_at) VALUES ('test',?,?,now()-interval '1 year') RETURNING id",
                Long.class,id,id);
    }
    long candidate() {
        long id=jdbc.queryForObject("""
                INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,
                depth_ppm,bls_power,transit_model,discoverable,is_confirmed)
                VALUES (101,'active',?,1,1,1,1,1,1,'{}',true,true) RETURNING id
                """,Long.class,bundle);
        jdbc.update("INSERT INTO candidate_dispositions VALUES (?,'confirmed','graded','planet','rule-0',now(),'[]')",id);
        return id;
    }
    long submit(long who,long signal,String judgment,OffsetDateTime at,String evidence) {
        return jdbc.queryForObject("""
                INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,removed_candidate_ids,
                submitted_period,phase_start,phase_end,fold_reference_time_btjd,user_judgment,evidence_checks,match_result,
                matched_candidate_id,achievement_result,created_at,residual_model_version,periodogram_config_version,rule_version)
                VALUES (?,101,?,?,'candidate',0,'{}',1,0,0.1,1,?,?::jsonb,'matched',?,'judgment_mismatch',?,'r','p','rule-0') RETURNING id
                """,Long.class,who,bundle,UUID.randomUUID(),judgment,evidence,signal,at);
    }
    long publish(long submission,long who,long signal) {
        long history=jdbc.queryForObject("INSERT INTO analysis_histories(submission_id,user_id,tic_id,snapshot_params,versions) VALUES (?,?,101,'{}','{}') RETURNING id",Long.class,submission,who);
        Long post=jdbc.queryForObject("""
                INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',101,'test','test','visible')
                ON CONFLICT (candidate_id) WHERE kind='system_thread' DO UPDATE SET title='test' RETURNING id
                """,Long.class,signal);
        return jdbc.queryForObject("INSERT INTO published_analyses(post_id,user_id,candidate_id,history_id,published_at) VALUES (?,?,?,?,now()) RETURNING id",Long.class,post,who,signal,history);
    }
    <T> T job(java.util.function.Supplier<T> action) {
        var tx=new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        return tx.execute(status->{jdbc.execute("SET LOCAL ROLE planetory_stats_job"); return action.get();});
    }
    MockHttpSession session() {
        var session=new MockHttpSession(); var context=SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new UsernamePasswordAuthenticationToken(new MemberPrincipal(member),null,List.of(new SimpleGrantedAuthority("ROLE_MEMBER"))));
        session.setAttribute("SPRING_SECURITY_CONTEXT",context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",java.time.Instant.now());
        return session;
    }

    @Test void 최초준비중과정상영건을구분하고인증된조회만허용한다() throws Exception {
        mvc.perform(get("/api/v1/statistics")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/statistics").session(session())).andExpect(status().isOk())
                .andExpect(jsonPath("$.global.status").value("UNAVAILABLE")).andExpect(jsonPath("$.global.data").isEmpty());
        assertEquals(CREATED,job(aggregation::refresh));
        mvc.perform(get("/api/v1/statistics").session(session())).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control","no-store"))
                .andExpect(jsonPath("$.global.status").value("READY"))
                .andExpect(jsonPath("$.global.data.metrics.discoveredStars.value").value(0))
                .andExpect(jsonPath("$.global.data.metrics.firstMatchAccuracy.status").value("NO_SAMPLE"))
                .andExpect(jsonPath("$.global.data.weeklySubmissions.length()").value(8));
        assertEquals(CREATED,job(()->aggregation.snapshot(null)));
        assertEquals(0,snapshots.latest().cohortMemberCount());
        assertNull(snapshots.latest().metrics().get("submissionsPerStar").median());
        mvc.perform(get("/api/v1/statistics").session(session()).param("memberId","1")).andExpect(status().isBadRequest());
    }

    @Test void 전체합산과회원중앙값은다르고첫매칭재판단및정정후성공본은불변이다() {
        submit(member,candidate,"LIKELY_PLANET",cutoff.minusDays(100),"[\"oddeven\",\"oddeven\",\"secondary\",\"unavailable\"]");
        submit(member,candidate,"UNLIKELY_PLANET",cutoff.minusSeconds(1),"[]");
        long second=member();
        for(int i=0;i<9;i++) submit(second,i==0?candidate:candidate(),i==0?"LIKELY_PLANET":"UNLIKELY_PLANET",cutoff.minusDays(1),"[]");
        submit(second,candidate,"LIKELY_PLANET",cutoff,"[]"); // D 당일은 일별 모수/값에서 제외
        assertEquals(CREATED,job(aggregation::refresh));
        assertEquals(20,global.current().data().path("metrics").path("firstMatchAccuracy").path("value").asInt());
        assertEquals(CREATED,job(()->aggregation.snapshot(null)));
        var saved=snapshots.latest();
        assertEquals(2,saved.cohortMemberCount());
        assertEquals(55.55555555555556,saved.metrics().get("firstMatchAccuracy").median().doubleValue(),1e-12);
        assertEquals(5.5,saved.metrics().get("submissionsPerStar").median().doubleValue());
        assertEquals(0.5,saved.metrics().get("evidencePerSubmission").median().doubleValue());
        assertEquals(cutoff.toInstant(),saved.asOf());
        assertTrue(!saved.sourceObservedAt().isBefore(saved.asOf()));
        assertTrue(!saved.generatedAt().isBefore(saved.sourceObservedAt()));
        jdbc.update("UPDATE users SET status='withdrawn',withdrawn_at=now() WHERE id=?",second);
        jdbc.update("UPDATE candidate_dispositions SET planet_truth='not_planet',disposition='fp'");
        assertEquals(ALREADY_EXISTS,job(()->aggregation.snapshot(null)));
        assertEquals(saved,snapshots.latest());
        assertEquals(CREATED,job(aggregation::refresh));
        assertEquals(0,global.current().data().path("metrics").path("firstMatchAccuracy").path("value").asInt());
        assertFalse(json.writeValueAsString(saved).contains("memberId"));
    }

    @Test void 개인비교쿼리는양수회원만허용하고다른회원은반환하지않는다() {
        submit(member, candidate, "LIKELY_PLANET", cutoff.minusDays(1), "[]");
        submit(member(), candidate, "UNLIKELY_PLANET", cutoff.minusDays(1), "[]");
        for (long invalidId : List.of(0L, -1L)) {
            var failure = assertThrows(org.springframework.dao.InvalidDataAccessApiUsageException.class,
                    () -> comparisonMetrics.read(invalidId, cutoff));
            assertInstanceOf(IllegalArgumentException.class, failure.getCause());
        }
        var result = comparisonMetrics.read(member, cutoff);
        assertEquals(1, result.size());
        assertEquals(member, result.get(0).memberId());
        assertEquals(100, result.get(0).metrics().get("firstMatchAccuracy").value().intValue());
    }

    @Test void 공개대표취소복귀와AI최신불명및챌린지고유회원을검증한다() {
        long old=submit(member,candidate,"LIKELY_PLANET",cutoff.minusDays(2),"[]");
        publish(old,member,candidate);
        long latest=submit(member,candidate,"UNSURE",cutoff.minusDays(1),"[]");
        long pa=publish(latest,member,candidate);
        long other=candidate(); publish(submit(member,other,"UNLIKELY_PLANET",cutoff.minusDays(1),"[]"),member,other);
        jdbc.update("INSERT INTO challenge_rounds(round_no,starts_on,ends_on,target_tic_id,description,status) VALUES (1,current_date,current_date+7,101,'test','active')");
        jdbc.update("UPDATE published_analyses SET published_at=?", cutoff.minusDays(1));
        long execution=jdbc.queryForObject("INSERT INTO ai_executions(model_version,checkpoint,status,started_at) VALUES ('m','test','success',now()) RETURNING id",Long.class);
        jdbc.update("INSERT INTO ai_evaluations(candidate_id,execution_id,score,verdict,threshold_version) VALUES (?,?,0,'rejected','t')",candidate,execution);
        jdbc.update("INSERT INTO ai_executions(model_version,checkpoint,status,started_at) VALUES ('m','test','failed',now())");
        job(aggregation::refresh);
        var data=global.current().data();
        assertEquals(2,data.path("metrics").path("aiAttemptUnknown").path("value").asInt());
        assertEquals(data.path("metrics").path("publicParticipations").path("value"),
                data.path("metrics").path("aiAttemptUnknown").path("value"));
        assertEquals("AVAILABLE", data.path("metrics").path("aiAttemptUnknown").path("status").asString());
        assertEquals("AI_ATTEMPT_UNKNOWN",data.path("aiJudgmentBands").path("reason").asString());
        assertEquals(1,data.path("challenges").get(0).path("participantCount").asInt());
        assertEquals(2,data.path("challenges").get(0).path("participationCount").asInt());
        jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE id=?",pa);
        job(aggregation::refresh);
        assertEquals(1,global.current().data().path("metrics").path("publicLikelyPlanet").path("value").asInt());
        assertEquals(0,global.current().data().path("metrics").path("publicUnsure").path("value").asInt());
    }

    @Test void 잡중첩및실패는성공본을변경하지않고과거신규생성을거절한다() throws Exception {
        assertEquals(CREATED,job(aggregation::refresh));
        var saved=global.current();
        try(var conn=DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());var st=conn.createStatement()) {
            st.execute("SELECT pg_advisory_lock("+StatisticsAggregationService.LOCK+")");
            try(var executor=Executors.newSingleThreadExecutor()) {
                assertEquals(BUSY,executor.submit(()->job(aggregation::refresh)).get(10,TimeUnit.SECONDS));
                assertEquals(BUSY,executor.submit(()->job(()->aggregation.snapshot(null))).get(10,TimeUnit.SECONDS));
            }
        }
        assertEquals(saved,global.current());
        assertEquals(HISTORICAL_SOURCE_UNAVAILABLE,job(()->aggregation.snapshot(LocalDate.now(ZONE).minusDays(1))));
        assertEquals(FUTURE_CUTOFF_NOT_ALLOWED,job(()->aggregation.snapshot(LocalDate.now(ZONE).plusDays(1))));
        assertEquals(BlockStatus.UNAVAILABLE,snapshots.latest().status());
        assertThrows(RuntimeException.class,()->job(()->{
            aggregation.refresh(); throw new IllegalStateException("synthetic rollback");
        }));
        assertEquals(saved,global.current());
        assertThrows(RuntimeException.class,()->job(()->{
            aggregation.snapshot(null); throw new IllegalStateException("synthetic rollback");
        }));
        assertEquals(BlockStatus.UNAVAILABLE,snapshots.latest().status());
        assertEquals(CREATED,job(()->aggregation.snapshot(null)));
        assertEquals(ALREADY_EXISTS,job(()->aggregation.snapshot(null)));
    }

    @Test void 앱과잡역할은원천변경이나성공본덮어쓰기를못한다() {
        assertEquals(CREATED,job(aggregation::refresh));
        assertEquals(CREATED,job(()->aggregation.snapshot(null)));
        for(String sql:List.of("REFRESH MATERIALIZED VIEW global_stats","DELETE FROM stats_snapshots",
                "UPDATE stats_snapshots SET metrics='{}'","INSERT INTO stats_snapshots(snapshot_date,scope,metrics) VALUES (current_date,'global','{}')")) {
            assertThrows(RuntimeException.class,()->new TransactionTemplate(transactions).execute(s->{jdbc.execute("SET LOCAL ROLE planetory_app");jdbc.execute(sql);return null;}));
        }
        for(String sql:List.of("DELETE FROM stats_snapshots","UPDATE stats_snapshots SET metrics='{}'","UPDATE users SET status='withdrawn'","INSERT INTO submissions DEFAULT VALUES")) {
            assertThrows(RuntimeException.class,()->job(()->{jdbc.execute(sql);return null;}));
        }
        assertThrows(RuntimeException.class,()->job(()->{jdbc.update("INSERT INTO stats_snapshots(snapshot_date,scope,metrics) VALUES (?,'global','{}')",cutoff.toLocalDate().minusDays(1));return null;}));
    }

    @Test void Sector발견집합중복제거와현재완료감소및원글순위를검증한다() {
        jdbc.update("INSERT INTO stars VALUES (102,NULL,NULL,NULL,0,'published'),(103,NULL,NULL,NULL,0,'published')");
        for(int i=0;i<2;i++) jdbc.update("""
                INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal)
                VALUES (?,?,'tutorial',0,now(),0,0,'test',?)
                """,member,101+i,i);
        assertThrows(org.springframework.dao.DuplicateKeyException.class, () -> jdbc.update("""
                INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal)
                VALUES (?,101,'challenge',0,now(),0,0,'test',2)
                """, member));
        jdbc.update("INSERT INTO user_star_progress(user_id,tic_id,progress_stage,completed_at) VALUES (?,101,'completed',now()),(?,103,'completed',now())",member,member);
        jdbc.update("""
                INSERT INTO observation_datasets(tic_id,sector,start_btjd,end_btjd,cadence,source_version,time_system)
                VALUES (101,1,1,2,'x','v1','BTJD'),(101,1,1,2,'x','v2','BTJD'),(101,2,1,2,'x','v1','BTJD'),
                    (102,1,1,2,'x','v1','BTJD'),(103,1,1,2,'x','v1','BTJD')
                """);
        publish(submit(member,candidate,"LIKELY_PLANET",cutoff.minusSeconds(1),"[]"),member,candidate);
        for(int i=0;i<2;i++) jdbc.update("INSERT INTO posts(kind,user_id,board,tic_id,tag,title,body,status) VALUES ('user',?,'star',101,'GENERAL','t','t','visible')",member);
        jdbc.update("INSERT INTO posts(kind,user_id,board,tic_id,tag,title,body,status) VALUES ('user',?,'star',101,'GENERAL','t','t','hidden')",member);
        job(aggregation::refresh);
        var data=global.current().data();
        assertEquals(2,data.path("sectorCompletion").get(0).path("denominator").asInt());
        assertEquals(50,data.path("sectorCompletion").get(0).path("value").asInt());
        assertEquals(100,data.path("sectorCompletion").get(1).path("value").asInt());
        assertEquals(3,data.path("mostPostsStars").get(0).path("postCount").asInt());
        jdbc.update("UPDATE user_star_progress SET progress_stage='in_progress' WHERE tic_id=101");
        job(aggregation::refresh);
        assertEquals(0,global.current().data().path("sectorCompletion").get(0).path("value").asInt());
    }

    @Test void 모수90일경계와건너뛰기포함및중앙값영을검증한다() {
        submit(member,candidate,"LIKELY_PLANET",cutoff.minusDays(90).minusNanos(1000),"[]");
        long included=member(),excluded=member();
        submit(excluded,candidate,"LIKELY_PLANET",cutoff,"[]");
        jdbc.update("""
                INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,removed_candidate_ids,
                fold_reference_time_btjd,evidence_checks,match_result,achievement_result,created_at,residual_model_version,periodogram_config_version,rule_version)
                VALUES (?,101,?,?,'skipped',0,'{}',1,'[]','skipped','none',?,'r','p','rule-0')
                """,included,bundle,UUID.randomUUID(),cutoff.minusDays(90));
        assertEquals(CREATED,job(()->aggregation.snapshot(null)));
        var saved=snapshots.latest();
        assertEquals(1,saved.cohortMemberCount());
        assertEquals(1,saved.metrics().get("submissionsPerStar").median().intValue());
        assertEquals(0,saved.metrics().get("evidencePerSubmission").sampleCount());
        assertEquals(MetricStatus.NO_SAMPLE,saved.metrics().get("evidencePerSubmission").status());
        // 관측 뒤 저장된 D 이전 기록도 기존 성공본을 다시 계산하지 않는다.
        submit(member,candidate,"UNLIKELY_PLANET",cutoff.minusDays(1),"[]");
        assertEquals(ALREADY_EXISTS,job(()->aggregation.snapshot(null)));
        assertEquals(saved,snapshots.latest());
    }

    @Test void 인정근거고조파만계산하며영표본도중앙값에포함한다() {
        long a=submit(member,candidate,"LIKELY_PLANET",cutoff.minusDays(1),"[]");
        jdbc.update("INSERT INTO user_candidate_achievements(user_id,candidate_id,achievement_type,recognized_submission_id,recognized_at) VALUES (?,?,'confirmed',?,?)",member,candidate,a,cutoff.minusHours(1));
        long second=member();
        long b=submit(second,candidate,"LIKELY_PLANET",cutoff.minusDays(1),"[]");
        jdbc.update("UPDATE submissions SET match_result='matched_harmonic',matched_period=1,harmonic_multiplier=2 WHERE id=?",b);
        jdbc.update("INSERT INTO user_candidate_achievements(user_id,candidate_id,achievement_type,recognized_submission_id,recognized_at) VALUES (?,?,'confirmed',?,?)",second,candidate,b,cutoff.minusHours(1));
        assertEquals(CREATED,job(()->aggregation.snapshot(null)));
        assertEquals(50,snapshots.latest().metrics().get("harmonicRecognitionRate").median().intValue());
        assertEquals(2,snapshots.latest().metrics().get("harmonicRecognitionRate").sampleCount());
        assertEquals(0,snapshots.latest().metrics().get("evidencePerSubmission").median().intValue());
    }

    @Test void 지연표시는성공기준시각과값을보존한다() {
        job(aggregation::refresh);
        var saved=global.current();
        var delayed=new GlobalStatisticsService(org.springframework.jdbc.core.simple.JdbcClient.create(jdbc),null,json,
                java.time.Clock.fixed(saved.asOf().plusSeconds(601),java.time.ZoneOffset.UTC),snapshots).current();
        assertEquals(BlockStatus.STALE,delayed.status());
        assertEquals(saved.asOf(),delayed.asOf()); assertEquals(saved.data(),delayed.data());
        job(()->aggregation.snapshot(null));
        var old=snapshots.latest();
        var tomorrow=new StatisticsSnapshotService(org.springframework.jdbc.core.simple.JdbcClient.create(jdbc),json,
                java.time.Clock.fixed(cutoff.plusDays(1).toInstant(),java.time.ZoneOffset.UTC)).latest();
        assertEquals(BlockStatus.STALE,tomorrow.status());
        assertEquals(old.asOf(),tomorrow.asOf()); assertEquals(old.metrics(),tomorrow.metrics());
    }

    @Test void 앱역할에서전체조회와공통기준선이같은메타데이터로연결된다() {
        submit(member,candidate,"LIKELY_PLANET",cutoff.minusDays(1),"[]");
        job(aggregation::refresh); job(()->aggregation.snapshot(null));
        var tx=new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        tx.execute(status->{
            jdbc.execute("SET LOCAL ROLE planetory_app");
            try {
                mvc.perform(get("/api/v1/statistics").session(session())).andExpect(status().isOk())
                        .andExpect(jsonPath("$.comparison.cohortMemberCount").value(1))
                        .andExpect(jsonPath("$.comparison.status").value("READY"))
                        .andExpect(jsonPath("$.comparison.sourceObservedAt").isNotEmpty())
                        .andExpect(jsonPath("$.comparison.metrics.firstMatchAccuracy.median").value(100));
                assertEquals(global.read(member).comparison(), snapshots.latest());
            } catch(Exception e) { throw new RuntimeException(e); }
            return null;
        });
    }

    @Test void 합성규모별갱신조회비용을측정한다() {
        submit(member,candidate,"LIKELY_PLANET",cutoff.minusDays(1),"[]");
        int previous=0;
        for(int size:List.of(100,10000,100000)) {
            jdbc.update("""
                    INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,removed_candidate_ids,
                    submitted_period,phase_start,phase_end,fold_reference_time_btjd,user_judgment,evidence_checks,match_result,
                    matched_candidate_id,achievement_result,created_at,residual_model_version,periodogram_config_version,rule_version)
                    SELECT ?,101,?,gen_random_uuid(),'candidate',0,'{}',1,0,0.1,1,'LIKELY_PLANET','[]','matched',?,
                    'judgment_mismatch',?,'r','p','rule-0' FROM generate_series(1,?)
                    """,member,bundle,candidate,cutoff.minusDays(1),size-previous);
            long start=System.nanoTime(); job(aggregation::refresh); long refreshed=System.nanoTime();
            assertEquals(size+1,global.current().data().path("weeklySubmissions").valueStream()
                    .mapToLong(v->v.path("submissions").asLong()).sum());
            long read=System.nanoTime();
            jdbc.update("DELETE FROM stats_snapshots");
            job(()->aggregation.snapshot(null)); long finished=System.nanoTime();
            System.out.printf("statistics benchmark submissions=%d refreshMs=%.1f readMs=%.1f snapshotMs=%.1f%n",
                    size+1,(refreshed-start)/1e6,(read-refreshed)/1e6,(finished-read)/1e6);
            previous=size;
        }
    }
}
