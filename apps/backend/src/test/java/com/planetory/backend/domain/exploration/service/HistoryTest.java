package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
import tools.jackson.databind.json.JsonMapper;
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 143 실제 제출 → 148 조회. 외부 잔차 공급자만 대체하고 HTTP·DB·보안 필터는 실제로 실행한다. */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class HistoryTest {
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
    @MockitoSpyBean HistoryRepository repository;
    @MockitoSpyBean GoldCatalogRepository gold;
    long member,tic,bundle,segment,candidate;
    Float[] flux;
    private static final JsonMapper JSON=JsonMapper.builder().build();

    @BeforeEach void seed() {
        when(residuals.lookup(any())).thenReturn(ResidualResultReader.Lookup.none());
        member=member(); tic=Math.abs(UUID.randomUUID().getMostSignificantBits()%900_000_000)+1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')",tic);
        var p=layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                member,tic,p.depthZ(),p.worldX(),p.worldY(),p.layoutVersion());
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
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,rule_version,applied_at,source_refs) VALUES (?,'confirmed','graded','planet','rule-0',now(),'[]')",candidate);
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
    long replaceBundle(double reference) {
        var tx=new TransactionTemplate(transactions);
        tx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return tx.execute(status -> {
            jdbc.update("UPDATE publication_bundles SET status='archived' WHERE tic_id=? AND status='current'",tic);
            return jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,fold_reference_time_btjd,base_days) SELECT tic_id,?,'current',manifest,?,base_days FROM publication_bundles WHERE id=? RETURNING id",
                    Long.class,"history-"+UUID.randomUUID(),reference,bundle);
        });
    }

    @Test void 실제제출에서_목록_상세_당시그래프까지() throws Exception {
        String id=submit(1.5);
        var page=histories.list(member,query(null,null));
        assertEquals(1,page.items().size()); assertTrue(page.items().getFirst().snapshotAvailable());
        assertTrue(page.items().getFirst().detailAvailable());
        assertTrue(page.items().getFirst().achievementGranted()); assertFalse(page.hasNext());
        var detail=histories.detail(member,id);
        assertEquals("matched_harmonic",detail.submission().match().status());
        assertEquals(1.5,detail.submission().original().periodDays());
        assertEquals(2.0,detail.submission().match().harmonicMultiplier());
        assertEquals("folded-mad-v1",detail.versions().snapshotVersion());
        assertEquals(2.0,detail.snapshotParams().foldedXZoomRatio());
        assertNull(detail.versions().preprocess());
        var graph=histories.graph(member,id,"SUBMITTED");
        assertNull(graph.curve()); assertEquals(150,graph.snapshot().bins());
        assertEquals(1.5,graph.selection().userPeriodDays());
        Float[] saved=jdbc.queryForObject("SELECT folded_flux FROM analysis_snapshots WHERE history_id=?",(r,n)->(Float[])r.getArray(1).getArray(),number(id));
        assertArrayEquals(saved,graph.snapshot().foldedFlux());
        mvc.perform(get("/api/v1/histories/"+id+"/graph").param("mode","SUBMITTED").session(session(member)))
                .andExpect(status().isOk()).andExpect(header().string("X-Current-Bundle","b-"+bundle))
                .andExpect(jsonPath("$.curve").isEmpty()).andExpect(jsonPath("$.snapshot.foldedFlux.length()").value(150))
                .andExpect(jsonPath("$.selection.currentPhaseStart").value(org.hamcrest.Matchers.nullValue()))
                .andExpect(jsonPath("$.selection.currentPhaseEnd").value(org.hamcrest.Matchers.nullValue()))
                .andExpect(jsonPath("$.snapshotVersion").value("folded-mad-v1"));
        mvc.perform(get("/api/v1/histories/"+id).session(session(member)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.submission.original.periodDays").value(1.5));
        mvc.perform(get("/api/v1/me/histories").session(session(member))).andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].historyId").value(id))
                .andExpect(jsonPath("$.items[0].detailAvailable").value(true));
    }
    @Test void 타인과_비로그인_잘못된경로_모드를_차단() throws Exception {
        String id=submit(3); long other=member();
        assertTrue(histories.list(other,query(null,null)).items().isEmpty());
        error(ErrorCode.FORBIDDEN,()->histories.detail(other,id));
        error(ErrorCode.FORBIDDEN,()->histories.graph(other,id,"CURRENT"));
        error(ErrorCode.RESOURCE_NOT_FOUND,()->histories.detail(member,"h-999999999999999999"));
        for(String bad:List.of("abc","h-01","h-0","h--1")) error(ErrorCode.RESOURCE_NOT_FOUND,()->histories.graph(member,bad,null));
        error(ErrorCode.VALIDATION_FAILED,()->histories.graph(member,id,"other"));
        mvc.perform(get("/api/v1/histories/"+id)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/histories/"+id+"/graph").session(session(other))).andExpect(status().isForbidden());
        verifyNoInteractions(residuals);
    }
    @Test void 같은시각_정렬과_필터변경커서_회원격리() {
        String first=submit(3),second=submit(1.5),third=submit(5);
        jdbc.update("UPDATE submissions SET created_at='2026-09-19T12:00:00Z' WHERE user_id=?",member);
        var page=histories.list(member,query(null,"2"));
        assertEquals(List.of(third,second),page.items().stream().map(HistoryViews.Item::historyId).toList());
        assertEquals(first,histories.list(member,query(page.nextCursor(),"2")).items().getFirst().historyId());
        error(ErrorCode.VALIDATION_FAILED,()->histories.list(member,query(page.nextCursor(),"1")));
        error(ErrorCode.VALIDATION_FAILED,()->histories.list(member(),query(page.nextCursor(),"2")));
        error(ErrorCode.VALIDATION_FAILED,()->histories.list(member,new HistoryViews.Query(Long.toString(tic),null,null,null,null,page.nextCursor(),"2")));
        var filtered=histories.list(member,new HistoryViews.Query(Long.toString(tic),"c-"+candidate,"matched","2026-09-19T12:00:00Z","2026-09-19T12:00:01Z",null,"20"));
        assertEquals(List.of(second,first),filtered.items().stream().map(HistoryViews.Item::historyId).toList());
        assertTrue(histories.list(member,new HistoryViews.Query(null,null,null,null,"2026-09-19T12:00:00Z",null,null)).items().isEmpty());
    }
    @Test void 목록_입력검증() throws Exception {
        for(var entry:Map.of("ticId","abc","candidateId","c-0","result","wrong","size","101","from","2026-09-19","cursor","%%%" ).entrySet()) {
            mvc.perform(get("/api/v1/me/histories").param(entry.getKey(),entry.getValue()).session(session(member)))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        }
        error(ErrorCode.VALIDATION_FAILED,()->histories.list(member,new HistoryViews.Query(null,null,null,"2026-09-20T00:00:00Z","2026-09-19T00:00:00Z",null,null)));
    }
    @Test void 미매칭은_스냅샷null이고_현재원본과_분리() {
        String id=submit(5);
        var submitted=histories.graph(member,id,"SUBMITTED");
        assertNull(submitted.snapshot()); assertNull(submitted.curve());
        var current=histories.graph(member,id,null);
        assertNull(current.snapshot()); assertEquals(0,current.curve().curveContext().curveStep());
        assertArrayEquals(flux,current.curve().segments().getFirst().flux());
        assertFalse(histories.list(member,query(null,null)).items().getFirst().snapshotAvailable());
        assertTrue(histories.list(member,query(null,null)).items().getFirst().detailAvailable());
    }
    @Test void 과거버전_배열과_오차null_영값은_그대로() {
        String id=submit(3);
        jdbc.update("UPDATE analysis_histories SET versions=jsonb_set(versions,'{snapshotVersion}','\"folded-mad-v0\"') WHERE id=?",number(id));
        jdbc.update("UPDATE analysis_snapshots SET folded_flux[1]=NULL,folded_err[1]=NULL,folded_err[2]=0 WHERE history_id=?",number(id));
        var graph=histories.graph(member,id,"SUBMITTED");
        assertEquals("folded-mad-v0",graph.snapshotVersion());
        assertNull(graph.snapshot().foldedFlux()[0]); assertNull(graph.snapshot().foldedError()[0]);
        assertEquals(0f,graph.snapshot().foldedError()[1]);
    }
    @Test void 판교체_절대값유지_현재위상환산_당시배열불변() {
        // v1의 관측 bin 중심에 실제 통과를 넣어 당시 선택 창과 저장 배열을 함께 검증한다.
        for (int i=0;i<flux.length;i++) {
            double offset=((i+.5)*10/1440)%3;
            if (offset>=.25 && offset<.35) flux[i]=.98f;
        }
        jdbc.update("UPDATE light_curve_segments SET flux=? WHERE id=?",flux,segment);
        String id=submit(3); var old=histories.graph(member,id,"SUBMITTED");
        var original=histories.detail(member,id).submission().original();
        assertEquals(.25/3,original.phaseStart(),1e-10);
        assertEquals(.35/3,original.phaseEnd(),1e-10);
        assertEquals(original.phaseStart(),histories.graph(member,id,"CURRENT").selection().currentPhaseStart(),1e-10);
        int firstBin=(int)Math.floor((original.phaseStart()+.5)*150);
        int lastBin=(int)Math.floor((original.phaseEnd()+.5)*150);
        assertEquals(87,firstBin); assertEquals(92,lastBin);
        assertTrue(Arrays.stream(old.snapshot().foldedFlux()).anyMatch(v -> v!=null && v<1f));
        for (int i=0;i<150;i++) {
            Float value=old.snapshot().foldedFlux()[i];
            if (value!=null && value<1f) assertTrue(i>=firstBin && i<=lastBin,"당시 선택 밖 통과: "+i);
        }
        long next=replaceBundle(101);
        var current=histories.graph(member,id,"CURRENT");
        assertEquals("b-"+next,current.reproduction().currentBundleId()); assertTrue(current.reproduction().isPreviousSubmission());
        assertEquals(old.selection().epochBtjd(),current.selection().epochBtjd());
        assertEquals(old.selection().durationHours(),current.selection().durationHours());
        assertEquals(.75,current.selection().currentPhaseStart(),1e-10);
        assertEquals(.75+.1/3,current.selection().currentPhaseEnd(),1e-10);
        for (var submitted:List.of(old,histories.graph(member,id,"SUBMITTED"),histories.publicGraph(id,"SUBMITTED",()->{}))) {
            assertNull(submitted.selection().currentPhaseStart()); assertNull(submitted.selection().currentPhaseEnd());
            assertNull(submitted.curve());
            assertArrayEquals(old.snapshot().foldedFlux(),submitted.snapshot().foldedFlux());
            assertArrayEquals(old.snapshot().foldedError(),submitted.snapshot().foldedError());
            assertEquals(old.snapshotVersion(),submitted.snapshotVersion());
        }
        assertEquals(original,histories.detail(member,id).submission().original());
        var content=histories.publicContent(id,()->{});
        assertEquals(original.phaseStart(),content.original().phaseStart());
        assertEquals(original.phaseEnd(),content.original().phaseEnd());
        assertEquals(current.selection(),histories.publicGraph(id,"CURRENT",()->{}).selection());
        assertTrue(histories.detail(member,id).isPreviousBundle());
    }
    @Test void 버전누락은_null로전달하고_저장배열을_보존() {
        String id=submit(3); var saved=histories.graph(member,id,"SUBMITTED").snapshot();
        jdbc.update("UPDATE analysis_histories SET versions=versions-'snapshotVersion' WHERE id=?",number(id));
        assertNull(histories.detail(member,id).versions().snapshotVersion());
        assertNull(histories.publicContent(id,()->{}).versions().snapshotVersion());
        for (var graph:List.of(histories.graph(member,id,"SUBMITTED"),histories.publicGraph(id,"SUBMITTED",()->{}))) {
            assertNull(graph.snapshotVersion());
            assertArrayEquals(saved.foldedFlux(),graph.snapshot().foldedFlux());
            assertArrayEquals(saved.foldedError(),graph.snapshot().foldedError());
        }
    }
    @Test void C02_4일주기_위상경계와_32배표시보존() {
        jdbc.update("UPDATE candidates SET period_days=4,epoch_btjd=101,duration_hours=9.6 WHERE id=?",candidate);
        var r=request(4);
        var request=new SubmissionRequest(r.requestId(),r.submissionKind(),r.curveContext(),new SubmissionRequest.Selection(4.0,null,.2,.3),
                r.userJudgment(),r.evidenceChecks(),r.memo(),new SubmissionRequest.ViewState(r.viewState().periodogramViewport(),32.0),null);
        String id=submissions.submit(member,tic,request).body().path("historyId").asText();
        assertEquals(32.0,histories.detail(member,id).snapshotParams().foldedXZoomRatio());
        replaceBundle(101);
        var graph=histories.graph(member,id,"CURRENT");
        assertEquals(101,graph.selection().epochBtjd()); assertEquals(9.6,graph.selection().durationHours(),1e-9);
        assertEquals(.95,graph.selection().currentPhaseStart(),1e-9); assertEquals(1.05,graph.selection().currentPhaseEnd(),1e-9);
        replaceBundle(102);
        graph=histories.graph(member,id,"CURRENT");
        assertEquals(.70,graph.selection().currentPhaseStart(),1e-9); assertEquals(.80,graph.selection().currentPhaseEnd(),1e-9);
    }
    @Test void 후보없음_제출은_선택값과_스냅샷없음() {
        var r=request(3);
        String id=submissions.submit(member,tic,new SubmissionRequest(r.requestId(),"no_candidate",r.curveContext(),null,null,null,null,null,null))
                .body().path("historyId").asText();
        assertEquals("none_wrong",histories.detail(member,id).submission().match().status());
        var graph=histories.graph(member,id,"SUBMITTED");
        assertNull(graph.snapshot()); assertNull(graph.selection().userPeriodDays()); assertNull(graph.selection().currentPhaseStart());
    }
    String residualHistory() {
        submit(3);
        when(residuals.lookup(any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED","job-private",null,Map.of(segment,flux),null));
        var r=request(5);
        String id=submissions.submit(member,tic,new SubmissionRequest(r.requestId(),r.submissionKind(),
                new SubmissionRequest.Context("b-"+bundle,1,List.of("c-"+candidate),"rm-1","pg-1"),r.selection(),r.userJudgment(),r.evidenceChecks(),r.memo(),r.viewState(),null)).body().path("historyId").asText();
        clearInvocations(residuals); return id;
    }
    @Test void 잔차없는_개인조회와_공개원본대체를_구분() {
        String id=residualHistory(); when(residuals.lookup(any())).thenReturn(ResidualResultReader.Lookup.none());
        var own=histories.graph(member,id,"CURRENT");
        assertNull(own.curve().segments()); assertNull(own.curve().residual().status()); assertNull(own.curve().residual().jobId());
        var publicGraph=histories.publicGraph(id,"CURRENT",()->{});
        assertEquals(0,publicGraph.curve().curveContext().curveStep());
        assertEquals("RESIDUAL_NOT_AVAILABLE",publicGraph.reproduction().fallbackReason());
        assertFalse(publicGraph.reproduction().residualReproducible()); assertNull(publicGraph.curve().residual().jobId());
    }
    @Test void 진행중과_완료잔차_타인작업ID비노출() {
        String id=residualHistory();
        when(residuals.lookup(any())).thenReturn(new ResidualResultReader.Lookup("QUEUED","job-private",null,Map.of(),null));
        assertEquals("job-private",histories.graph(member,id,"CURRENT").curve().residual().jobId());
        assertNull(histories.publicGraph(id,"CURRENT",()->{}).curve().residual().jobId());
        Float[] residual=flux.clone(); Arrays.fill(residual,.9f);
        when(residuals.lookup(any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED","job-private",OffsetDateTime.now(),Map.of(segment,residual),null));
        var graph=histories.publicGraph(id,"CURRENT",()->{});
        assertEquals(1,graph.curve().curveContext().curveStep()); assertEquals(.9f,graph.curve().segments().getFirst().flux()[0]);
        assertNull(graph.curve().residual().jobId());
    }
    @Test void 은퇴제거후보는_일부제거가아닌_원본대체() {
        String id=residualHistory(); var saved=histories.graph(member,id,"SUBMITTED").snapshot();
        jdbc.update("UPDATE candidates SET status='retired' WHERE id=?",candidate);
        clearInvocations(residuals);
        var graph=histories.graph(member,id,"CURRENT");
        assertEquals("RETIRED_CANDIDATE",graph.reproduction().fallbackReason());
        assertEquals(List.of(),graph.curve().curveContext().removedCandidateIds());
        assertFalse(graph.reproduction().residualReproducible());
        for (var submitted:List.of(histories.graph(member,id,"SUBMITTED"),histories.publicGraph(id,"SUBMITTED",()->{}))) {
            assertEquals("RETIRED_CANDIDATE",submitted.reproduction().fallbackReason());
            assertFalse(submitted.reproduction().residualReproducible()); assertNull(submitted.curve());
            // 이 fixture는 미매칭이다. 은퇴 안내 때문에 당시 배열을 만들거나 원본으로 대체하지 않는다.
            assertEquals(saved,submitted.snapshot());
        }
        verifyNoInteractions(residuals);
    }
    @Test void 공개투영은_내부키를_중첩에서도_제외() {
        String id=submit(3);
        var content=histories.publicContent(id,()->{});
        assertEquals("공개 메모",content.memo()); assertNull(content.graph());
        String json=JSON.writeValueAsString(content);
        for(String key:List.of("viewState","answerViewed","achievementResult","retryOfSubmissionId","originalMatch","requestId","skyVersion","targetKind")) assertFalse(json.contains('"'+key+'"'),key);
        assertEquals("folded-mad-v1",content.versions().snapshotVersion());
        var graph=histories.publicGraph(id,"SUBMITTED",()->{});
        assertEquals(graph,content.withGraph(graph).graph());
        var another=histories.publicGraph(submit(5),"SUBMITTED",()->{});
        assertThrows(IllegalArgumentException.class,()->content.withGraph(another));
        error(ErrorCode.FORBIDDEN,()->histories.publicContent(id,()->{throw new BusinessException(ErrorCode.FORBIDDEN);}));
    }
    @Test void 공개_반환직전_권한철회와_재시도도_재검사() {
        String id=submit(3); var calls=new AtomicInteger();
        error(ErrorCode.FORBIDDEN,()->histories.publicContent(id,()->{
            if(calls.incrementAndGet()>1) throw new BusinessException(ErrorCode.FORBIDDEN);
        }));
        assertEquals(2,calls.get()); calls.set(0);
        error(ErrorCode.FORBIDDEN,()->histories.publicGraph(id,"CURRENT",()->{
            if(calls.incrementAndGet()>1) throw new BusinessException(ErrorCode.FORBIDDEN);
        }));
        assertEquals(2,calls.get());
        doReturn(false).when(repository).stillCurrent(anyLong(),anyLong()); calls.set(0);
        error(ErrorCode.FORBIDDEN,()->histories.publicGraph(id,"CURRENT",()->{
            if(calls.incrementAndGet()==3) throw new BusinessException(ErrorCode.FORBIDDEN);
        }));
        assertEquals(3,calls.get());
    }
    @Test void 판전환은_새트랜잭션에서_전체한번재조회() {
        String id=submit(3); var calls=new AtomicInteger(); var txids=new java.util.ArrayList<Long>();
        doAnswer(call->{ txids.add(jdbc.queryForObject("SELECT txid_current()",Long.class)); return call.callRealMethod(); }).when(repository).find(number(id));
        doAnswer(call->{ if(calls.incrementAndGet()==1) { replaceBundle(101); return false; } return call.callRealMethod(); }).when(repository).stillCurrent(anyLong(),anyLong());
        var graph=histories.graph(member,id,"CURRENT");
        assertNotEquals("b-"+bundle,graph.curve().bundleId()); assertEquals(graph.curve().bundleId(),graph.reproduction().currentBundleId());
        assertEquals(2,calls.get()); assertEquals(4,txids.stream().distinct().count());
    }
    @Test void 재시도후_다시판전환은_그래프503() throws Exception {
        String id=submit(3); doReturn(false).when(repository).stillCurrent(anyLong(),anyLong());
        mvc.perform(get("/api/v1/histories/"+id+"/graph").session(session(member))).andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("GRAPH_TEMPORARILY_UNAVAILABLE"));
        verify(repository,times(2)).stillCurrent(anyLong(),anyLong());
    }
    @Test void 판전환으로_잔차읽기실패해도_최신판에서_재조회() {
        String id=residualHistory(); var calls=new AtomicInteger();
        when(residuals.lookup(any())).thenAnswer(call->{
            if(calls.incrementAndGet()==1) { replaceBundle(101); throw new IllegalStateException("archived cache removed"); }
            return ResidualResultReader.Lookup.none();
        });
        var graph=histories.graph(member,id,"CURRENT");
        assertNotEquals("b-"+bundle,graph.reproduction().currentBundleId());
        assertNull(graph.curve().segments()); assertEquals(2,calls.get());
    }
    @Test void current없음은_의존성503_공개내용은_계속조회() {
        String id=submit(3); jdbc.update("UPDATE publication_bundles SET status='archived' WHERE id=?",bundle);
        for(String mode:List.of("CURRENT","SUBMITTED")) error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->histories.graph(member,id,mode));
        assertEquals("공개 메모",histories.publicContent(id,()->{}).memo());
        assertEquals(id,histories.detail(member,id).historyId());
        assertTrue(histories.list(member,query(null,null)).items().getFirst().isPreviousBundle());
    }
    @Test void 잔차손상은_503_공개내용과_당시스냅샷은_유지() {
        String id=residualHistory();
        when(residuals.lookup(any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED",null,null,Map.of(segment,new Float[]{1f}),null));
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->histories.graph(member,id,"CURRENT"));
        assertEquals("공개 메모",histories.publicContent(id,()->{}).memo());
        assertNull(histories.graph(member,id,"SUBMITTED").curve());
    }
    @Test void 원본배열_계약손상도_의존성503_당시스냅샷은_독립() {
        String id=submit(3);
        doThrow(new IllegalStateException("invalid Gold array")).when(gold).findSegments(any());
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->histories.graph(member,id,"CURRENT"));
        assertNotNull(histories.graph(member,id,"SUBMITTED").snapshot());
    }
    @Test void 실제HTTP제출에서_히스토리조회로_연결() throws Exception {
        var session=session(member);
        var response=mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/v1/stars/"+tic+"/submissions")
                .session(session).with(org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf())
                .contentType("application/json").content(JSON.writeValueAsString(request(3))))
                .andExpect(status().isCreated()).andReturn().getResponse();
        String id=JSON.readTree(response.getContentAsString()).path("historyId").asText();
        mvc.perform(get("/api/v1/histories/"+id+"/graph").session(session).param("mode","SUBMITTED"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.snapshot.bins").value(150));
    }
    @Test void 공개취소와_성과_재분류_당시판정은_독립() {
        String id=submit(3); var before=histories.detail(member,id);
        long post=jdbc.queryForObject("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status) VALUES ('system_thread',?,'star',?,'test','','visible') RETURNING id",Long.class,candidate,tic);
        jdbc.update("INSERT INTO published_analyses(post_id,user_id,candidate_id,history_id,published_at) VALUES (?,?,?,?,now())",post,member,candidate,number(id));
        assertTrue(histories.list(member,query(null,null)).items().getFirst().publication().isPublic());
        jdbc.update("UPDATE published_analyses SET unpublished_at=now() WHERE history_id=?",number(id));
        jdbc.update("UPDATE user_candidate_achievements SET relabeled_at=now(),relabel_disposition='fp' WHERE user_id=? AND candidate_id=?",member,candidate);
        jdbc.update("UPDATE submissions SET answer_viewed=true WHERE id=(SELECT submission_id FROM analysis_histories WHERE id=?)",number(id));
        var item=histories.list(member,query(null,null)).items().getFirst();
        assertFalse(item.publication().isPublic()); assertTrue(item.achievementGranted()); assertEquals("FP",item.relabel().newDisposition());
        var after=histories.detail(member,id);
        assertEquals(before.submission().judgment(),after.submission().judgment());
        assertEquals(before.submission().match(),after.submission().match()); assertTrue(after.submission().detail().answerViewed());
    }
    @Test void 구기록의_최초응답이없어도_목록투영그래프는_저장값으로조회() throws Exception {
        String id=submit(3);
        jdbc.update("UPDATE submissions SET response_snapshot=NULL,request_hash=NULL,request_hash_version=NULL WHERE user_id=?",member);
        assertEquals(id,histories.list(member,query(null,null)).items().getFirst().historyId());
        assertFalse(histories.list(member,query(null,null)).items().getFirst().detailAvailable());
        assertTrue(histories.list(member,query(null,null)).items().getFirst().snapshotAvailable());
        mvc.perform(get("/api/v1/me/histories").session(session(member))).andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].detailAvailable").value(false));
        assertEquals("공개 메모",histories.publicContent(id,()->{}).memo());
        assertNotNull(histories.graph(member,id,"SUBMITTED").snapshot());
        error(ErrorCode.DEPENDENCY_UNAVAILABLE,()->histories.detail(member,id));
    }
    @Test void 앱역할_목록상세그래프_읽기와_불변기록유지() {
        String id=submit(3);
        String before=jdbc.queryForObject("SELECT to_jsonb(s)::text FROM submissions s WHERE user_id=?",String.class,member);
        // 서비스의 새 트랜잭션 안에서도 앱 역할을 적용한다.
        doAnswer(call->{jdbc.execute("SET LOCAL ROLE planetory_app");return call.callRealMethod();}).when(repository).find(number(id));
        var tx=new TransactionTemplate(transactions);
        tx.executeWithoutResult(status->{jdbc.execute("SET LOCAL ROLE planetory_app"); assertEquals(1,histories.list(member,query(null,null)).items().size());});
        assertEquals(id,histories.detail(member,id).historyId());
        histories.graph(member,id,"CURRENT"); histories.graph(member,id,"SUBMITTED"); histories.publicContent(id,()->{});
        assertEquals(before,jdbc.queryForObject("SELECT to_jsonb(s)::text FROM submissions s WHERE user_id=?",String.class,member));
    }
}
