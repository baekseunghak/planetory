package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.sql.Connection;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.json.JsonMapper;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.when;

/** 실제 PostgreSQL 저장·멱등·권한 검증. 봉우리/잔차 생산자는 담당 티켓의 경계에서 대체한다. */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
class SubmissionTest {
    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource
    static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", DB::getUsername);
        r.add("spring.datasource.password", DB::getPassword);
    }
    @Autowired SubmissionService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired DataSource dataSource;
    @Autowired GalaxyLayout layout;
    @Autowired PlatformTransactionManager transactions;
    @MockitoBean ResidualResultReader residuals;
    @MockitoBean SubmissionPeakReader peaks;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean SubmissionRepository repository;
    @Autowired org.springframework.test.web.servlet.MockMvc mvc;
    @Autowired com.planetory.backend.domain.statistics.service.PersonalStatisticsService personalStatistics;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean
    com.planetory.backend.domain.statistics.service.PersonalStatisticsQuery personalQuery;
    @Autowired com.planetory.backend.domain.statistics.service.ComparisonMetricQuery comparisonQuery;
    @Autowired com.planetory.backend.domain.post.service.PublicAnalysisService publications;
    long member, tic, bundle, segment, candidate;
    Float[] flux;

    @BeforeEach
    void seed() {
        when(residuals.lookup(anyLong(), any())).thenReturn(ResidualResultReader.Lookup.none());
        member = member();
        tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000) + 1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')", tic);
        var p = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal)"
                + " VALUES (?,?,'tutorial',?,now(),?,?,?,0)", member,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
        flux = new Float[4320]; Arrays.fill(flux, 1.0f);
        segment = jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id,sector,binning_revision,start_btjd,bin_minutes,n_points,flux,gaps)"
                + " VALUES (?,1,'10m-v1',100,10,?,?, '[]') RETURNING id", Long.class,tic,flux.length,flux);
        String manifest = """
                {"segment_ids":[%d],"array_checksums":{},"residual_model_version":"rm-1",
                 "periodogram_config_version":"pg-1","binning":{"minutes":10},
                 "period_grid":{"spacing":"log"},"fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """.formatted(segment);
        bundle = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days)"
                + " VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",Long.class,tic,"test-"+UUID.randomUUID(),manifest);
        jdbc.update("INSERT INTO periodograms(bundle_id,period_min_days,period_max_days,n_periods,power) VALUES (?,0.5,20,3,?)",
                bundle,new Float[]{1f,2f,1f});
        candidate = candidate(3.0, "confirmed");
    }
    long member() {
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?) RETURNING id",
                Long.class,UUID.randomUUID().toString(),UUID.randomUUID().toString());
    }
    long candidate(double period, String disposition) {
        long id = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed)"
                + " VALUES (?,'active',?,1,?,100.3,2.4,1000,10,'{}',true,?) RETURNING id",
                Long.class,tic,bundle,period,"confirmed".equals(disposition));
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,rule_version,applied_at,source_refs)"
                + " VALUES (?,?,?,?, 'rule-0',now(),'[]')", id,disposition,"pc".equals(disposition)?"analysis":"graded",
                "pc".equals(disposition)?null:"confirmed".equals(disposition)?"planet":"not_planet");
        return id;
    }
    SubmissionRequest request() {
        return new SubmissionRequest(UUID.randomUUID().toString(),"candidate",
                new SubmissionRequest.Context("b-"+bundle,0,List.of(),"rm-1","pg-1"),
                new SubmissionRequest.Selection(3.0,null,1.0/12,7.0/60),"LIKELY_PLANET",List.of("ushape"),null,null,null);
    }
    SubmissionRequest change(SubmissionRequest r, String kind, String judgment, Double period, String memo) {
        return new SubmissionRequest(r.requestId(),kind,r.curveContext(),period==null?null:
                new SubmissionRequest.Selection(period,null,0.25/period,0.35/period),judgment,
                period==null?null:r.evidenceChecks(),memo,r.viewState(),null);
    }
    long count(String table) { return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE user_id=?",Long.class,member); }
    void error(ErrorCode code, Runnable call) { assertEquals(code,assertThrows(BusinessException.class,call::run).getErrorCode()); }

    @Test void 개인통계_첫매칭_재전송_당시근거_현재완료() {
        var first=change(request(),"candidate","UNLIKELY_PLANET",3.0,null);
        service.submit(member,tic,first);
        for(int i=0;i<3;i++) service.submit(member,tic,first);
        service.submit(member,tic,request());
        var result=personalStatistics.read(member).current();
        assertEquals(2,result.metrics().get("submissionCount").value().intValueExact());
        assertEquals(0,result.metrics().get("firstMatchAccuracy").value().intValueExact());
        assertEquals(1,result.metrics().get("firstMatchAccuracy").denominator());
        assertEquals(1,result.metrics().get("retryRecognitionCount").value().intValueExact());
        assertEquals(1,result.metrics().get("completedStarCount").value().intValueExact());
        var evidence=result.evidence().stream().filter(e->e.key().equals("ushape")).findFirst().orElseThrow();
        assertEquals(2,evidence.useCount()); assertEquals(50,evidence.accuracy().value().intValueExact());
        jdbc.update("UPDATE candidate_dispositions SET disposition='fp',planet_truth='not_planet' WHERE candidate_id=?",candidate);
        var changed=personalStatistics.read(member).current();
        assertEquals(100,changed.metrics().get("firstMatchAccuracy").value().intValueExact());
        assertEquals(1,changed.metrics().get("retryRecognitionCount").value().intValueExact());
        assertEquals(50,changed.evidence().stream().filter(e->e.key().equals("ushape")).findFirst().orElseThrow().accuracy().value().intValueExact());
        jdbc.update("UPDATE user_star_progress SET progress_stage='in_progress' WHERE user_id=?",member);
        assertEquals(0,personalStatistics.read(member).current().metrics().get("completedStarCount").value().intValueExact());
        jdbc.update("UPDATE submissions SET response_snapshot=NULL WHERE request_id=?",UUID.fromString(first.requestId()));
        var missing=personalStatistics.read(member).current().metrics().get("retryRecognitionCount");
        assertNull(missing.value()); assertEquals("MISSING_BASIS",missing.reason());
    }

    @Test void 개인통계_빈값_본인제한_탈퇴제외() throws Exception {
        var empty=personalStatistics.read(member);
        assertEquals(0,empty.current().metrics().get("submissionCount").value().intValueExact());
        assertNull(empty.current().metrics().get("firstMatchAccuracy").value());
        assertEquals("NO_SAMPLE",empty.current().metrics().get("firstMatchAccuracy").status().name());
        assertEquals(8,empty.current().weeks().size());
        assertTrue(empty.current().weeks().stream().allMatch(w->w.submissionCount()==0));
        assertEquals("UNAVAILABLE",empty.comparison().status().name());
        assertNull(empty.comparison().metrics().get("firstMatchAccuracy").myValue().value());
        service.submit(member,tic,request());
        assertEquals(0,personalStatistics.read(member()).current().metrics().get("submissionCount").value().intValueExact());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/me/statistics"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isUnauthorized());
        var session=new org.springframework.mock.web.MockHttpSession();
        var context=org.springframework.security.core.context.SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new org.springframework.security.authentication.TestingAuthenticationToken(
                new com.planetory.backend.global.security.MemberPrincipal(member),null,"ROLE_USER"));
        session.setAttribute(org.springframework.security.web.context.HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY,context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",java.time.Instant.now());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/me/statistics")
                .session(session))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.header().string("Cache-Control","no-store"));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/me/statistics?memberId=123")
                .session(session))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest());
        jdbc.update("UPDATE users SET status='withdrawn' WHERE id=?",member);
        error(ErrorCode.AUTH_REQUIRED,()->personalStatistics.read(member));
    }

    @Test void 개인통계_주경계_중복근거_자료없음제외() {
        var first=service.submit(member,tic,request()).body();
        var second=service.submit(member,tic,change(request(),"candidate","UNSURE",3.0,null)).body();
        long firstId=ExplorationIds.parse(first.get("submissionId").asText(),ExplorationIds.SUBMISSION).orElseThrow();
        long secondId=ExplorationIds.parse(second.get("submissionId").asText(),ExplorationIds.SUBMISSION).orElseThrow();
        jdbc.update("UPDATE submissions SET created_at='2026-09-20T14:59:59Z',evidence_checks='[\"ushape\",\"ushape\",\"centroid\",\"disabled\"]' WHERE id=?",firstId);
        jdbc.update("UPDATE submissions SET created_at='2026-09-20T15:00:00Z',evidence_checks='[]' WHERE id=?",secondId);
        var weeks=personalQuery.weeks(member,java.time.LocalDate.of(2026,9,21));
        assertEquals(8,weeks.size()); assertEquals(1,weeks.get(6).submissionCount()); assertEquals(1,weeks.get(7).submissionCount());
        assertTrue(weeks.get(7).partial()); assertFalse(weeks.get(6).partial());
        var current=personalStatistics.read(member).current();
        assertEquals(2,current.metrics().get("activeDays").value().intValueExact());
        assertEquals(0,new BigDecimal("0.5").compareTo(current.metrics().get("evidencePerSubmission").value()));
        assertEquals(1,current.evidence().stream().filter(e->e.key().equals("ushape")).findFirst().orElseThrow().useCount());
    }

    @Test void 개인통계_미공개duplicate_공개대표복귀_취소이력() {
        jdbc.update("UPDATE candidate_dispositions SET disposition='pc',answer_class='analysis',planet_truth=NULL WHERE candidate_id=?",candidate);
        var first=service.submit(member,tic,request()).body();
        publications.publish(member,first.get("historyId").asText());
        var second=service.submit(member,tic,change(request(),"candidate","UNSURE",3.0,null)).body();
        assertEquals("duplicate",second.at("/match/status").asText());
        assertEquals(1,personalStatistics.read(member).current().metrics().get("unpublishedSignalCount").value().intValueExact());
        var published=publications.publish(member,second.get("historyId").asText());
        assertEquals(100,personalStatistics.read(member).current().publicJudgmentDistribution().get("UNSURE").value().intValueExact());
        publications.visibility(member,published.analysisId(),false);
        var reverted=personalStatistics.read(member).current();
        assertEquals(100,reverted.publicJudgmentDistribution().get("LIKELY_PLANET").value().intValueExact());
        assertEquals(0,reverted.metrics().get("unpublishedSignalCount").value().intValueExact());
        assertNull(reverted.metrics().get("firstMatchAccuracy").value());
    }

    @Test void 개인통계_고조파는_성과인정근거만_계산() {
        var failed=service.submit(member,tic,change(request(),"candidate","UNLIKELY_PLANET",1.5,null)).body();
        assertEquals("matched_harmonic",failed.at("/match/status").asText());
        service.submit(member,tic,request());
        service.submit(member,tic,change(request(),"candidate","LIKELY_PLANET",1.5,null));
        assertEquals(0,personalStatistics.read(member).current().metrics().get("harmonicRecognitionRate").value().intValueExact());
        seed();
        var recognized=service.submit(member,tic,change(request(),"candidate","LIKELY_PLANET",1.5,null)).body();
        assertEquals("matched_harmonic",recognized.at("/match/status").asText());
        assertEquals(100,personalStatistics.read(member).current().metrics().get("harmonicRecognitionRate").value().intValueExact());
    }

    @Test void 개인통계_과거중앙값과_현재내값을_혼합하지않음() {
        var zone=com.planetory.backend.domain.statistics.dto.StatisticsDtos.ZONE;
        var date=java.time.LocalDate.now(zone);
        var cutoff=date.atStartOfDay(zone).toInstant();
        var observed=java.time.Instant.now();
        var baseline=new com.planetory.backend.domain.statistics.service.StatisticsSnapshotService.Baseline(
                "PERCENT",BigDecimal.valueOf(25),10,
                com.planetory.backend.domain.statistics.dto.StatisticsDtos.MetricStatus.AVAILABLE,null);
        var snapshot=new com.planetory.backend.domain.statistics.service.StatisticsSnapshotService.ComparisonSnapshot(
                com.planetory.backend.domain.statistics.dto.StatisticsDtos.BlockStatus.READY,
                cutoff,observed,observed,date.minusDays(1),date.minusDays(90).atStartOfDay(zone).toInstant(),cutoff,10L,
                Map.of("firstMatchAccuracy",baseline));
        long id=jdbc.queryForObject("INSERT INTO stats_snapshots(snapshot_date,scope,metrics) VALUES (?,'global',?::jsonb) RETURNING id",
                Long.class,date.minusDays(1),JsonMapper.builder().build().writeValueAsString(snapshot));
        try {
            assertEquals("JOINED_AFTER_CUTOFF",personalStatistics.read(member).comparison().metrics().get("firstMatchAccuracy").myValue().reason());
            jdbc.update("UPDATE users SET created_at=? WHERE id=?",java.sql.Timestamp.from(cutoff.minusSeconds(1)),member);
            service.submit(member,tic,request());
            var response=personalStatistics.read(member);
            assertEquals(100,response.current().metrics().get("firstMatchAccuracy").value().intValueExact());
            assertEquals(25,response.comparison().metrics().get("firstMatchAccuracy").median().intValueExact());
            assertNull(response.comparison().metrics().get("firstMatchAccuracy").myValue().value());
            assertEquals("HISTORICAL_SOURCE_UNAVAILABLE",response.comparison().metrics().get("firstMatchAccuracy").myValue().reason());
            assertEquals(observed,response.comparison().sourceObservedAt());
            assertEquals(cutoff,response.comparison().asOf());
            assertNull(response.comparison().inCohort());
        } finally { jdbc.update("DELETE FROM stats_snapshots WHERE id=?",id); }
    }

    @Test void 개인통계_응답중_새제출이_커밋되어도_동일스냅샷() {
        service.submit(member,tic,request());
        org.mockito.Mockito.doAnswer(call->{
            try(var pool=Executors.newSingleThreadExecutor()) {
                pool.submit(()->service.submit(member,tic,request())).get(10,TimeUnit.SECONDS);
            }
            return call.callRealMethod();
        }).when(personalQuery).activity(member);
        var current=personalStatistics.read(member).current();
        assertEquals(1,current.metrics().get("submissionCount").value().intValueExact());
        assertEquals(1,current.metrics().get("submissionsPerStar").numerator());
        assertEquals(1,current.judgmentDistribution().get("LIKELY_PLANET").numerator());
        assertEquals(2,count("submissions"));
    }

    @Test void 개인통계_현재원천은_앱역할로_조회가능() {
        service.submit(member,tic,request());
        new TransactionTemplate(transactions).execute(status->{
            jdbc.execute("SET LOCAL ROLE planetory_app");
            var asOf=jdbc.queryForObject("SELECT transaction_timestamp()",java.time.OffsetDateTime.class);
            assertEquals(1,comparisonQuery.read(member,asOf).getFirst().metrics().get("submissionsPerStar").value().intValueExact());
            assertEquals(1,personalQuery.activity(member).get("submissionCount").value().intValueExact());
            assertDoesNotThrow(()->personalQuery.weeks(member,java.time.LocalDate.now()));
            assertDoesNotThrow(()->personalQuery.judgmentAccuracy(member));
            assertDoesNotThrow(()->personalQuery.judgmentDistribution(member,true));
            assertDoesNotThrow(()->personalQuery.evidence(member));
            assertDoesNotThrow(()->personalQuery.retryRecognition(member));
            assertDoesNotThrow(()->personalQuery.community(member));
            return null;
        });
    }

    @Test void 저장_성과_완료_그리고_판교체후_재요청은_최초본문() {
        var r=request(); var first=service.submit(member,tic,r);
        assertFalse(first.replay());
        assertEquals("matched",first.body().at("/match/status").asText());
        assertEquals("recognized",first.body().at("/achievement/result").asText());
        assertEquals("completed",first.body().at("/progress/stage").asText());
        assertEquals(1,count("analysis_histories")); assertEquals(1,count("user_candidate_achievements"));
        assertEquals(150,jdbc.queryForObject("SELECT cardinality(folded_flux) FROM analysis_snapshots a JOIN analysis_histories h ON h.id=a.history_id WHERE h.user_id=?",Integer.class,member));
        jdbc.update("UPDATE publication_bundles SET status='archived' WHERE id=?",bundle);
        long current=jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days)"
                + " SELECT tic_id,?,'current',manifest,fold_reference_time_btjd,base_days FROM publication_bundles WHERE id=? RETURNING id",
                Long.class,"test-"+UUID.randomUUID(),bundle);
        var replay=service.submit(member,tic,r);
        assertTrue(replay.replay()); assertEquals(first.body(),replay.body()); assertEquals(1,count("submissions"));
        assertEquals("b-"+current,replay.currentBundleId());
        assertEquals("b-"+bundle,replay.body().get("bundleId").asText());
        error(ErrorCode.IDEMPOTENCY_CONFLICT,()->service.submit(member,tic,change(r,"candidate","LIKELY_PLANET",3.0,"changed")));
        error(ErrorCode.IDEMPOTENCY_CONFLICT,()->service.submit(member(),tic,r));
    }
    @Test void 고조파_원본주기_보존_중복은_정정열없이_응답보존() {
        var first=service.submit(member,tic,change(request(),"candidate","LIKELY_PLANET",1.5,null));
        assertEquals("matched_harmonic",first.body().at("/match/status").asText());
        assertEquals(2,first.body().at("/match/harmonicMultiplier").asDouble());
        var duplicate=service.submit(member,tic,change(request(),"candidate","LIKELY_PLANET",1.5,null));
        assertEquals("duplicate",duplicate.body().at("/match/status").asText());
        assertEquals(2,duplicate.body().at("/match/harmonicMultiplier").asDouble());
        assertEquals(1,count("user_candidate_achievements"));
        jdbc.update("UPDATE user_candidate_achievements SET relabeled_at=now(),relabel_disposition='fp' WHERE user_id=? AND candidate_id=?",member,candidate);
        assertEquals("FP",service.submit(member,tic,request()).body().at("/signal/relabel/newDisposition").asText());
    }
    @Test void 오판과_미확정은_매칭해도_성과를_주지_않는다() {
        assertEquals("judgment_mismatch",service.submit(member,tic,change(request(),"candidate","UNSURE",3.0,null)).body().at("/achievement/result").asText());
        jdbc.update("UPDATE candidate_dispositions SET disposition='pc',answer_class='analysis',planet_truth=NULL WHERE candidate_id=?",candidate);
        assertEquals("pending_publish",service.submit(member,tic,request()).body().at("/achievement/result").asText());
        assertEquals(0,count("user_candidate_achievements"));
    }
    @Test void 특수제출과_모호한매칭은_스냅샷과_성과없음() {
        assertEquals("none_wrong",service.submit(member,tic,change(request(),"no_candidate",null,null,null)).body().at("/match/status").asText());
        error(ErrorCode.SKIP_NOT_AVAILABLE,()->service.submit(member,tic,change(request(),"skipped",null,null,null)));
        candidate(3.0,"confirmed");
        var body=service.submit(member,tic,request()).body();
        assertEquals("ambiguous_match",body.at("/match/status").asText());
        assertTrue(body.get("signal").isNull()); assertEquals("RETRY",body.at("/nextActions/0").asText());
        assertEquals(1,body.get("nextActions").size()); assertEquals(0,count("user_candidate_achievements"));
    }
    @Test void 잔차미준비는_미접수_준비후_같은ID로_저장() {
        service.submit(member,tic,request());
        candidate(4.0,"pc");
        var r=change(request(),"candidate","LIKELY_PLANET",4.0,null);
        r=new SubmissionRequest(r.requestId(),r.submissionKind(),new SubmissionRequest.Context("b-"+bundle,1,List.of("c-"+candidate),"rm-1","pg-1"),r.selection(),r.userJudgment(),r.evidenceChecks(),null,null,null);
        var retry=r;
        error(ErrorCode.SUBMISSION_CONTEXT_NOT_READY,()->service.submit(member,tic,retry));
        assertEquals(1,count("submissions"));
        Float[] residual=flux.clone(); Arrays.fill(residual,2f);
        when(residuals.lookup(anyLong(), any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED","rj-test",null,Map.of(segment,residual),new Float[]{1f,2f,1f}));
        assertEquals("matched",service.submit(member,tic,retry).body().at("/match/status").asText());
        assertEquals(2f,jdbc.queryForObject("SELECT max(v) FROM analysis_snapshots a JOIN analysis_histories h ON h.id=a.history_id CROSS JOIN LATERAL unnest(a.folded_flux) v WHERE h.user_id=?",Float.class,member));
    }
    @Test void 다음튜토리얼_설정누락은_전체롤백_설정행도_남지않음() {
        jdbc.update("UPDATE tutorial_stars SET active=false WHERE active");
        jdbc.update("INSERT INTO tutorial_stars(seq,tic_id,intent,active) VALUES (1,?,'deep_confirmed',true) ON CONFLICT(seq) DO UPDATE SET tic_id=excluded.tic_id,active=true",tic);
        try {
            error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,request()));
            for(String table:List.of("submissions","analysis_histories","user_candidate_achievements","user_settings","user_star_progress")) assertEquals(0,count(table),table);
            assertEquals(1,count("star_unlocks"));
        } finally { jdbc.update("UPDATE tutorial_stars SET active=false WHERE tic_id=?",tic); }
    }
    @Test void 앱권한으로_전체저장과_재요청() {
        var tx=new TransactionTemplate(transactions); tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        var r=request();
        tx.execute(status->{jdbc.execute("SET LOCAL ROLE planetory_app"); assertFalse(service.submit(member,tic,r).replay()); return null;});
        tx.execute(status->{jdbc.execute("SET LOCAL ROLE planetory_app"); assertTrue(service.submit(member,tic,r).replay()); return null;});
    }
    @Test void 같은회원_다른ID_동시제출은_성과한번() throws Exception {
        try(var pool=Executors.newFixedThreadPool(2)) {
            var a=pool.submit(()->service.submit(member,tic,request()));
            var b=pool.submit(()->service.submit(member,tic,request()));
            assertNotNull(a.get(20,TimeUnit.SECONDS)); assertNotNull(b.get(20,TimeUnit.SECONDS));
        }
        assertEquals(2,count("submissions")); assertEquals(1,count("user_candidate_achievements"));
    }
    @Test void 스냅샷에_안보인_기존요청의_중복키는_새트랜잭션에서_재현() {
        var r=request(); var first=service.submit(member,tic,r);
        var transactionIds=new java.util.ArrayList<Long>();
        // 짧은 경합 대신 첫 조회만 안 보이게 한다. INSERT의 UNIQUE 위반은 실제 PostgreSQL이 발생시킨다.
        org.mockito.Mockito.doAnswer(call->{
            transactionIds.add(jdbc.queryForObject("SELECT txid_current()",Long.class));
            return transactionIds.size()==1 ? java.util.Optional.empty() : call.callRealMethod();
        }).when(repository).existing(UUID.fromString(r.requestId()));
        var replay=service.submit(member,tic,r);
        assertTrue(replay.replay()); assertEquals(first.body(),replay.body());
        assertEquals(2,transactionIds.size()); assertNotEquals(transactionIds.get(0),transactionIds.get(1));
        assertEquals(1,count("submissions")); assertEquals(1,count("analysis_histories"));
        assertEquals(1,count("user_candidate_achievements"));
    }
    @Test void 중복키_재시도는_세번으로_제한하고_기존기록을_보존() {
        var r=request(); service.submit(member,tic,r);
        org.mockito.Mockito.doReturn(java.util.Optional.empty()).when(repository).existing(UUID.fromString(r.requestId()));
        org.mockito.Mockito.clearInvocations(repository);
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,r));
        org.mockito.Mockito.verify(repository,org.mockito.Mockito.times(3)).existing(UUID.fromString(r.requestId()));
        assertEquals(1,count("submissions")); assertEquals(1,count("analysis_histories"));
        assertEquals(1,count("user_candidate_achievements"));
    }
    @Test void 동일요청_진행중이면_409_미접수() throws Exception {
        var r=request(); UUID id=UUID.fromString(r.requestId());
        try(Connection c=dataSource.getConnection()) {
            c.setAutoCommit(false);
            try(var s=c.prepareStatement("SELECT pg_advisory_xact_lock(?)")) {s.setLong(1,id.getMostSignificantBits()^id.getLeastSignificantBits());s.execute();}
            error(ErrorCode.REQUEST_IN_PROGRESS,()->service.submit(member,tic,r));
            assertEquals(0,count("submissions")); c.rollback();
        }
        assertFalse(service.submit(member,tic,r).replay());
    }
    @Test void 정규화는_표기와_무시필드차이를_제거하지만_메모는_보존() {
        var r=request().normalized(); var json=JsonMapper.builder().build();
        var tree=json.valueToTree(r); ((tools.jackson.databind.node.ObjectNode)tree).put("epochBtjd",999);
        var parsed=json.treeToValue(tree,SubmissionRequest.class).normalized();
        assertEquals(SubmissionService.fingerprint(tic,r),SubmissionService.fingerprint(tic,parsed));
        assertNotEquals(SubmissionService.fingerprint(tic,r),SubmissionService.fingerprint(tic,change(r,"candidate","LIKELY_PLANET",3.0," ").normalized()));
    }
    @Test void 스냅샷은_MAD이며_빈구간과_단일점은_오차없음() {
        var s=new LightCurveSegment(1,1,(short)1,"daily",0,BigDecimal.valueOf(1440),4,new Float[]{1f,2f,3f,null},null,null);
        var result=FoldedSnapshot.calculate(List.of(s),1,0);
        assertEquals(2f,result.foldedFlux()[0]); assertEquals(1.4826f,result.foldedError()[0]);
        assertNull(result.foldedFlux()[75]);
        var singleton=new LightCurveSegment(2,1,(short)1,"daily",0.5,BigDecimal.ONE,1,new Float[]{4f},null,null);
        var boundary=FoldedSnapshot.calculate(List.of(singleton),1,0);
        assertEquals(4f,boundary.foldedFlux()[0]); assertNull(boundary.foldedError()[0]);
    }
    @Test void 중심시각은_세그먼트별간격과_위상순환경계를_반영() {
        var a=new LightCurveSegment(1,1,(short)1,"a",0,BigDecimal.valueOf(360),1,new Float[]{1f},null,null);
        var b=new LightCurveSegment(2,1,(short)1,"b",0,BigDecimal.valueOf(720),1,new Float[]{2f},null,null);
        var c=new LightCurveSegment(3,1,(short)1,"c",0.375,BigDecimal.valueOf(360),1,new Float[]{3f},null,null);
        var d=new LightCurveSegment(4,1,(short)1,"d",0.875,BigDecimal.valueOf(360),1,new Float[]{4f},null,null);
        var result=FoldedSnapshot.calculate(List.of(a,b,c,d),1,0);
        assertEquals("folded-mad-v1",FoldedSnapshot.VERSION);
        assertEquals(1f,result.foldedFlux()[93]); // 0.125
        assertEquals(2f,result.foldedFlux()[112]); // 0.25
        assertEquals(3f,result.foldedFlux()[0]); // +0.5 -> -0.5
        assertEquals(4f,result.foldedFlux()[75]); // 1 -> 0
    }
    @Test void 후속행동은_매칭과_미매칭과_신호없음을_구분() {
        var unmatched=service.submit(member,tic,change(request(),"candidate","LIKELY_PLANET",5.0,null)).body();
        assertEquals("not_matched",unmatched.at("/match/status").asText());
        assertTrue(unmatched.get("nextActions").toString().contains("DISCUSS"));
        assertFalse(unmatched.get("nextActions").toString().contains("GO_HOME"));
        var none=service.submit(member,tic,change(request(),"no_candidate",null,null,null)).body();
        assertFalse(none.get("nextActions").toString().contains("DISCUSS"));
        var matched=service.submit(member,tic,request()).body();
        assertTrue(matched.get("nextActions").toString().contains("GO_HOME"));
        assertFalse(matched.get("nextActions").toString().contains("DISCUSS"));
        assertTrue(service.submit(member,tic,request()).body().get("nextActions").toString().contains("GO_HOME"));
    }
    @Test void v0이력은_재전송시_새계산으로_덮어쓰지않음() {
        var r=request(); var first=service.submit(member,tic,r);
        assertEquals("folded-mad-v1",jdbc.queryForObject("SELECT versions->>'snapshotVersion' FROM analysis_histories WHERE user_id=?",String.class,member));
        // 이전 버전의 저장 기록을 구성한다. 앱 권한이 아닌 테스트 소유자만 수정한다.
        jdbc.update("UPDATE analysis_histories SET versions=jsonb_set(versions,'{snapshotVersion}','\"folded-mad-v0\"') WHERE user_id=?",member);
        jdbc.update("UPDATE analysis_snapshots SET folded_flux=array_fill(7::real,ARRAY[150]) WHERE history_id=(SELECT id FROM analysis_histories WHERE user_id=?)",member);
        var replay=service.submit(member,tic,r);
        assertTrue(replay.replay()); assertEquals(first.body(),replay.body());
        assertEquals("folded-mad-v0",jdbc.queryForObject("SELECT versions->>'snapshotVersion' FROM analysis_histories WHERE user_id=?",String.class,member));
        assertEquals(7f,jdbc.queryForObject("SELECT folded_flux[1] FROM analysis_snapshots WHERE history_id=(SELECT id FROM analysis_histories WHERE user_id=?)",Float.class,member));
    }
    @Test void 직렬화실패는_새트랜잭션에서_재시도하고_세번후_중단() {
        var ids=new java.util.ArrayList<Long>();
        org.mockito.Mockito.doAnswer(call->{
            ids.add(jdbc.queryForObject("SELECT txid_current()",Long.class));
            if(ids.size()==1) throw new org.springframework.dao.PessimisticLockingFailureException("serialization");
            return call.callRealMethod();
        }).when(repository).lockMember(member);
        assertFalse(service.submit(member,tic,request()).replay());
        assertEquals(2,ids.size()); assertNotEquals(ids.get(0),ids.get(1));
        org.mockito.Mockito.doThrow(new org.springframework.dao.PessimisticLockingFailureException("serialization"))
                .when(repository).lockMember(member);
        org.mockito.Mockito.clearInvocations(repository);
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,request()));
        org.mockito.Mockito.verify(repository,org.mockito.Mockito.times(3)).lockMember(member);
        assertEquals(1,count("submissions"));
    }
    @Test void 재시도대기_인터럽트는_복원하고_추가제출하지않음() {
        org.mockito.Mockito.doThrow(new org.springframework.dao.PessimisticLockingFailureException("serialization"))
                .when(repository).lockMember(member);
        try {
            Thread.currentThread().interrupt();
            error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,request()));
            assertTrue(Thread.currentThread().isInterrupted());
        } finally { Thread.interrupted(); }
        assertEquals(0,count("submissions"));
    }
    @Test void 스냅샷저장_실패는_제출과_이력까지_롤백() {
        org.mockito.Mockito.doThrow(new IllegalStateException("snapshot failure")).when(repository)
                .snapshot(org.mockito.ArgumentMatchers.anyLong(),any());
        assertThrows(org.springframework.dao.InvalidDataAccessApiUsageException.class,()->service.submit(member,tic,request()));
        for(String table:List.of("submissions","analysis_histories","user_candidate_achievements","user_star_progress")) assertEquals(0,count(table));
    }
    @Test void 첫튜토리얼_설정행이_없어도_온보딩완료() {
        jdbc.update("UPDATE tutorial_stars SET active=false WHERE active");
        jdbc.update("INSERT INTO tutorial_stars(seq,tic_id,intent,active) VALUES (1,?,'deep_confirmed',true) ON CONFLICT(seq) DO UPDATE SET tic_id=excluded.tic_id,active=true",tic);
        try {
            service.submit(member,tic,change(request(),"no_candidate",null,null,null));
            assertTrue(jdbc.queryForObject("SELECT onboarding_done FROM user_settings WHERE user_id=?",Boolean.class,member));
        } finally { jdbc.update("UPDATE tutorial_stars SET active=false WHERE tic_id=?",tic); }
    }
    @Test void 봉우리_선택은_생산자자료를_검증하고_없으면_미접수() {
        var r=request(); var selection=new SubmissionRequest.Selection(3.0,1,1.0/12,7.0/60);
        var withPeak=new SubmissionRequest(r.requestId(),r.submissionKind(),r.curveContext(),selection,r.userJudgment(),r.evidenceChecks(),null,null,null);
        when(peaks.read(any(),any())).thenReturn(null);
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,withPeak));
        assertEquals(0,count("submissions"));
        when(peaks.read(any(),any())).thenReturn(Map.of(1,new SubmissionMatching.Peak(1,2.9,3.1,2.4)));
        assertEquals(2.4,service.submit(member,tic,withPeak).body().at("/serverDerived/sourcePeakSuggestedDurationHours").asDouble());
    }
    @Test void 첫매칭_판단통계는_재제출로_뒤집히지않음() {
        var first=service.submit(member,tic,change(request(),"candidate","UNSURE",3.0,null));
        assertEquals(0,first.body().at("/judgmentStatistics/agreementPercent").asDouble());
        var second=service.submit(member,tic,request());
        assertEquals(0,second.body().at("/judgmentStatistics/agreementPercent").asDouble());
        assertEquals(1,second.body().at("/judgmentStatistics/matchedMemberCount").asInt());
    }
    @Test void 실제보안필터_HTTP_인증_CSRF_신규와재요청() throws Exception {
        var json=JsonMapper.builder().build(); String body=json.writeValueAsString(request());
        String path="/api/v1/stars/"+tic+"/submissions";
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(path)
                .contentType("application/json").content(body)).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isUnauthorized());
        var session=new org.springframework.mock.web.MockHttpSession();
        var context=org.springframework.security.core.context.SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new org.springframework.security.authentication.TestingAuthenticationToken(
                new com.planetory.backend.global.security.MemberPrincipal(member),null,"ROLE_USER"));
        session.setAttribute(org.springframework.security.web.context.HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY,context);
        session.setAttribute(com.planetory.backend.domain.auth.service.AuthSessionService.class.getName()+".lastActivity",java.time.Instant.now());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(path).session(session)
                .contentType("application/json").content(body)).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isForbidden());
        for(int status:List.of(201,200)) mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(path)
                .session(session).with(org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf())
                .contentType("application/json").content(body)).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().is(status))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.header().string("X-Current-Bundle","b-"+bundle));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/v1/stars/abc/submissions")
                .session(session).with(org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf())
                .contentType("application/json").content(body)).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isNotFound());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(path)
                .session(session).with(org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf())
                .contentType("application/json").content(body.replace("\"curveStep\":0","\"curveStep\":0.5")))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest());
    }
    @Test void 잠긴별_구판_입력오류는_저장하지않음() {
        error(ErrorCode.STAR_LOCKED,()->service.submit(member(),tic,request()));
        var r=request(); var stale=new SubmissionRequest(r.requestId(),r.submissionKind(),
                new SubmissionRequest.Context("b-999999",0,List.of(),"rm-1","pg-1"),r.selection(),r.userJudgment(),r.evidenceChecks(),null,null,null);
        error(ErrorCode.BUNDLE_CHANGED,()->service.submit(member,tic,stale));
        error(ErrorCode.VALIDATION_FAILED,()->service.submit(member,tic,change(r,"candidate","LIKELY_PLANET",-1.0,null)));
        assertEquals(0,count("submissions"));
    }
    @Test void 공개통계는_최신유효공개만_세고_숨김시_이전공개로_복귀() {
        jdbc.update("UPDATE candidate_dispositions SET disposition='pc',answer_class='analysis',planet_truth=NULL WHERE candidate_id=?",candidate);
        var first=service.submit(member,tic,request()).body();
        assertEquals(0,first.at("/judgmentStatistics/participantCount").asInt());
        assertTrue(first.at("/judgmentStatistics/percentages").isNull());
        long post=jdbc.queryForObject("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'test','','visible') RETURNING id",Long.class,candidate,tic);
        long h1=Long.parseLong(first.get("historyId").asText().substring(2));
        jdbc.update("INSERT INTO published_analyses(post_id,user_id,candidate_id,history_id,published_at) VALUES (?,?,?,?,now())",post,member,candidate,h1);
        var second=service.submit(member,tic,change(request(),"candidate","UNSURE",3.0,null)).body();
        assertEquals(1,second.at("/judgmentStatistics/likelyPlanet").asInt(),"미공개 재판단은 통계를 바꾸지 않는다");
        long h2=Long.parseLong(second.get("historyId").asText().substring(2));
        jdbc.update("INSERT INTO published_analyses(post_id,user_id,candidate_id,history_id,published_at) VALUES (?,?,?,?,now())",post,member,candidate,h2);
        var latest=service.submit(member,tic,request()).body();
        assertEquals(1,latest.at("/judgmentStatistics/unsure").asInt());
        assertEquals(1,latest.at("/judgmentStatistics/participantCount").asInt());
        jdbc.update("UPDATE published_analyses SET hidden_at=now() WHERE history_id=?",h2);
        assertEquals(1,service.submit(member,tic,request()).body().at("/judgmentStatistics/likelyPlanet").asInt());
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",post);
        assertEquals(0,service.submit(member,tic,request()).body().at("/judgmentStatistics/participantCount").asInt());
    }
    @Test void 손상잔차는_503이고_스냅샷으로_숨기지않음() {
        service.submit(member,tic,request());
        var r=request();
        var residualRequest=new SubmissionRequest(r.requestId(),r.submissionKind(),
                new SubmissionRequest.Context("b-"+bundle,1,List.of("c-"+candidate),"rm-1","pg-1"),r.selection(),r.userJudgment(),r.evidenceChecks(),null,null,null);
        for(Float[] bad:List.of(new Float[]{1f},new Float[flux.length])) {
            when(residuals.lookup(anyLong(), any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED","rj-test",null,Map.of(segment,bad),null));
            error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,residualRequest));
        }
        when(residuals.lookup(anyLong(), any())).thenThrow(new IllegalStateException("cache unavailable"));
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->service.submit(member,tic,residualRequest));
        assertEquals(1,count("submissions"));
    }
    @Test void 스냅샷_비유한값과_float32산포초과는_거절() {
        for(Float[] values:List.of(new Float[]{Float.NaN},new Float[]{Float.POSITIVE_INFINITY},new Float[]{-Float.MAX_VALUE,Float.MAX_VALUE})) {
            var s=new LightCurveSegment(1,1,(short)1,"daily",0,BigDecimal.valueOf(1440),values.length,values,null,null);
            assertThrows(IllegalStateException.class,()->FoldedSnapshot.calculate(List.of(s),1,0));
        }
    }
    @Test void 튜토리얼_오답상세확인후_건너뛰면_다음별만열림() {
        jdbc.update("INSERT INTO operation_settings(rule_version,values,applied_at,note) SELECT ?,jsonb_set(values,'{tutorial,skip_after}','3'),clock_timestamp(),'test' FROM operation_settings ORDER BY applied_at DESC LIMIT 1","test-"+UUID.randomUUID());
        jdbc.update("UPDATE tutorial_stars SET active=false WHERE active");
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,0,'published')",tic+1);
        for(int seq:List.of(1,2)) jdbc.update("INSERT INTO tutorial_stars(seq,tic_id,intent,active) VALUES (?,?,'deep_confirmed',true) ON CONFLICT(seq) DO UPDATE SET tic_id=excluded.tic_id,active=true",seq,tic+seq-1);
        try {
            for(int i=0;i<3;i++) service.submit(member,tic,change(request(),"no_candidate",null,null,null));
            error(ErrorCode.SKIP_NOT_AVAILABLE,()->service.submit(member,tic,change(request(),"skipped",null,null,null)));
            jdbc.update("UPDATE submissions SET answer_viewed=true WHERE id=(SELECT max(id) FROM submissions WHERE user_id=?)",member);
            var answer=service.submit(member,tic,change(request(),"skipped",null,null,null)).body();
            assertEquals("skipped",answer.at("/progress/completionReason").asText());
            assertEquals(0,count("user_candidate_achievements")); assertEquals(2,count("star_unlocks"));
            var statistics=personalStatistics.read(member).current();
            assertEquals(4,statistics.metrics().get("submissionCount").value().intValueExact());
            assertEquals(4,statistics.metrics().get("submissionsPerStar").value().intValueExact());
            assertNull(statistics.metrics().get("evidencePerSubmission").value());
            error(ErrorCode.STAR_ALREADY_COMPLETED,()->service.submit(member,tic,change(request(),"no_candidate",null,null,null)));
        } finally {jdbc.update("UPDATE tutorial_stars SET active=false WHERE tic_id IN (?,?)",tic,tic+1);}
    }
}
