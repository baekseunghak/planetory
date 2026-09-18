package com.planetory.backend.domain.exploration;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import com.planetory.backend.domain.exploration.service.AnalysisService;
import com.planetory.backend.domain.exploration.service.AnalysisViews.AnalysisContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurrentCurveContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.TutorialState;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Curve;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveQuery;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Periodogram;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Segment;
import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.ResidualResultReader;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * 분석 화면의 곡선·주기도 조회 [S15P21C206-140].
 *
 * <p>탐사 API 5.2·5.3절과 2.1·2.3절의 요청 규칙을 따른다. 잔차 결과는 온라인 잔차 작업
 * (S15P21C206-147) 전이라 읽기 인터페이스를 바꿔 끼워 본다. 실행마다 별도 스키마를 만들고 끝나면 지운다.
 */
@ActiveProfiles("local")
@SpringBootTest
class AnalysisDataTest {

    private static final String SCHEMA =
            "analysis_data_" + UUID.randomUUID().toString().replace("-", "");

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired AnalysisService analysis;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;
    @MockitoBean ResidualResultReader residuals;

    /**
     * 문자열로 정렬하면 순서가 뒤집히는 두 id를 테스트마다 새로 만든다({@code 9xxxxxx} < {@code 10xxxxxx}).
     * 숫자 순이어야 같은 조합이 하나의 캐시 키가 된다. 같은 스키마를 쓰므로 테스트끼리 겹치면 안 된다.
     */
    private static final AtomicLong NEXT_ID_PAIR = new AtomicLong();

    private long smallerId;
    private long largerId;

    private long memberId;
    private long strangerId;
    private long ticId;
    private long currentBundleId;
    private long archivedBundleId;
    private long sector14;
    private long sector41;
    private long unmatchedId;
    private long retiredId;

    @BeforeEach
    void seed() {
        when(residuals.lookup(any())).thenReturn(ResidualResultReader.Lookup.none());
        memberId = insertMember();
        strangerId = insertMember();
        ticId = insertStar("published");
        unlock(memberId, ticId);

        // 매니페스트 순서와 달리 응답은 섹터 순이어야 한다.
        sector41 = insertSegment(ticId, 41, 2419.99, new Float[] {0.9999f, 1.0002f}, "[]", null);
        sector14 = insertSegment(ticId, 14, 1683.35, new Float[] {1.0001f, 0.9998f, null, 1.0003f},
                "[[2, 2]]", "0.0012");
        archivedBundleId = insertBundle(ticId, "archived", "rm-1", List.of(sector14));
        currentBundleId = insertBundle(ticId, "current", "rm-1", List.of(sector41, sector14));
        jdbc.update("INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power)"
                + " VALUES (?, 0.5, 46.0, 3, ?)", currentBundleId, new Float[] {0.012f, 0.015f, 0.011f});

        long pair = NEXT_ID_PAIR.getAndIncrement();
        smallerId = insertCandidate(9_000_000L + pair, "active");
        largerId = insertCandidate(10_000_000L + pair, "active");
        unmatchedId = insertCandidate(null, "active");
        retiredId = insertCandidate(null, "retired");
        match(memberId, smallerId);
        match(memberId, largerId);
        match(memberId, retiredId);
    }

    // ---------- 분석 진입 (5.1) ----------

    @Test
    void 분석_진입은_현재_판과_선택_규칙과_진행_문맥을_준다() {
        OffsetDateTime publishedAt = OffsetDateTime.of(2026, 9, 9, 20, 0, 0, 0, ZoneOffset.UTC);
        jdbc.update("UPDATE publication_bundles SET published_at = ? WHERE id = ?", publishedAt, currentBundleId);
        insertObservation(41);
        insertObservation(14);

        Answer<AnalysisContext> answer = analysis.context(memberId, ticId);

        assertTrue(answer.ready());
        assertEquals("b-" + currentBundleId, answer.currentBundleId());
        AnalysisContext context = answer.body();
        assertEquals(String.valueOf(ticId), context.ticId());
        assertEquals(2, context.star().sectorCount());
        assertEquals(List.of(14, 41), context.star().sectors());
        assertEquals(9.8, context.star().tmag());
        assertFalse(context.hasConfirmedCandidate());

        var bundle = context.bundle();
        assertEquals("b-" + currentBundleId, bundle.bundleId());
        assertTrue(bundle.bundleVersion().startsWith("pv1-"));
        assertTrue(publishedAt.isEqual(bundle.publishedAt()));
        assertEquals(1683.4231, bundle.foldReferenceTimeBtjd());
        assertEquals(0, new BigDecimal("81.4").compareTo(bundle.baseDays()));
        assertArrayEquals(new double[] {1683.35, 2419.99 + 2 * 10.0 / 1440.0}, bundle.observationBounds(),
                "끝은 마지막 bin의 끝이다");
        assertEquals("rm-1", bundle.residualModelVersion());
        assertEquals("pg-1", bundle.periodogramConfigVersion());
        assertEquals("10m-v1", bundle.binningRevision());
        assertEquals("one_candidate_per_step", bundle.curveStepRule());

        var rules = context.selectionRules();
        assertEquals("rule-0", rules.version());
        assertEquals(2 * 10.0 / 1440.0, rules.minWindowDays(), "10분 bin 케이던스의 2배");
        assertEquals(0.25, rules.phaseWidthMax());
        assertEquals(3.0, rules.maxDurationMultipleOfSuggested());
        assertFalse(rules.allowEmptyPhaseSpan());
        assertEquals(3, rules.fineTune().halfWidthCells());
        assertEquals("rule-0", context.ruleVersion());

        var progress = context.progress();
        assertEquals("unexplored", progress.stage(), "진행 행이 없으면 시작 전이다");
        assertEquals(0, progress.currentCurveStep());
        assertEquals(List.of("c-" + smallerId, "c-" + largerId), progress.matchedCandidateIds(), "은퇴 후보는 빠진다");
        assertNull(progress.completionReason());
        assertFalse(progress.reopenPending());
        assertEquals(0, progress.achievementCount());
        assertNull(progress.grade());

        // 마지막 제출이 원본 단계였으므로 원본으로 돌아간다.
        CurrentCurveContext current = context.currentCurveContext();
        assertEquals(0, current.curveStep());
        assertEquals(List.of(), current.removedCandidateIds());
        assertNull(current.notice());
        assertEquals("COMPLETED", context.residualForCurrentStep().status());
        assertEquals(2, context.nextCurveContext().curveStep());
        assertEquals(List.of("c-" + smallerId, "c-" + largerId), context.nextCurveContext().removedCandidateIds());
        assertEquals("b-" + currentBundleId, context.nextCurveContext().bundleId());
        assertNull(context.residualForNextStep().status(), "조회는 작업을 만들지 않는다(D-14)");
        assertNull(context.tutorial().seq());
        assertFalse(context.tutorial().skipAvailable());
    }

    @Test
    void 분석_복귀는_마지막_제출의_제거_조합으로_돌아간다() {
        submit(memberId, List.of(smallerId), "not_matched", null, "none", false, 10);

        AnalysisContext context = analysis.context(memberId, ticId).body();

        CurrentCurveContext current = context.currentCurveContext();
        assertEquals(1, current.curveStep());
        assertEquals(List.of("c-" + smallerId), current.removedCandidateIds());
        assertEquals("b-" + currentBundleId, current.bundleId(), "옛 판에서 한 제출이어도 현재 판 문맥이다");
        assertNull(current.notice());
        assertNull(context.residualForCurrentStep().status());
        assertEquals(List.of("c-" + smallerId, "c-" + largerId), context.nextCurveContext().removedCandidateIds());
    }

    /** C02-R1: 옛 조합 {A,B}에서 B가 은퇴하면 {A}만 남기지 않고 현재 진행 {A,C}로 바꾼다. */
    @Test
    void 마지막_제출_조합에_은퇴_후보가_있으면_현재_진행_문맥으로_바꾸고_알린다() {
        submit(memberId, List.of(smallerId, retiredId), "not_matched", null, "none", false, 10);

        CurrentCurveContext current = analysis.context(memberId, ticId).body().currentCurveContext();

        assertEquals(2, current.curveStep());
        assertEquals(List.of("c-" + smallerId, "c-" + largerId), current.removedCandidateIds());
        assertEquals(CurrentCurveContext.STEP_NOT_RESTORABLE, current.notice());
    }

    @Test
    void 탐색_가능한_신호가_남지_않으면_다음_곡선이_없다() {
        match(memberId, unmatchedId);
        long undiscoverable = insertCandidate(null, "active");
        jdbc.update("UPDATE candidates SET discoverable = false WHERE id = ?", undiscoverable);

        AnalysisContext context = analysis.context(memberId, ticId).body();

        assertNull(context.nextCurveContext(), "탐색할 수 없는 후보는 남은 신호가 아니다");
        assertNull(context.residualForNextStep());
    }

    @Test
    void 확정_후보는_현재_후보표의_활성_후보로만_알린다() {
        jdbc.update("UPDATE candidates SET is_confirmed = true WHERE id = ?", retiredId);
        assertFalse(analysis.context(memberId, ticId).body().hasConfirmedCandidate(), "은퇴한 확정 후보는 세지 않는다");

        jdbc.update("UPDATE candidates SET is_confirmed = true WHERE id = ?", unmatchedId);
        assertTrue(analysis.context(memberId, ticId).body().hasConfirmedCandidate(), "매칭 여부와 무관하다");
    }

    @Test
    void 진행과_성과는_이_회원의_이_별_기록에서_온다() {
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, current_curve_step, reopen_pending)"
                + " VALUES (?, ?, 'in_progress', 1, true)", memberId, ticId);
        long recognizedBy = jdbc.queryForObject("SELECT id FROM submissions WHERE user_id = ? AND matched_candidate_id = ?",
                Long.class, memberId, smallerId);
        jdbc.update("INSERT INTO user_candidate_achievements(user_id, candidate_id, achievement_type,"
                + " recognized_submission_id, recognized_at) VALUES (?, ?, 'unconfirmed', ?, now())",
                memberId, smallerId, recognizedBy);

        var progress = analysis.context(memberId, ticId).body().progress();

        assertEquals("in_progress", progress.stage());
        assertEquals(1, progress.currentCurveStep());
        assertTrue(progress.reopenPending());
        assertEquals(1, progress.achievementCount());
        assertEquals("A", progress.grade());
    }

    /** SUB-12. 로컬 규칙(rule-0)의 기준은 오답 3회다. */
    @Test
    void 튜토리얼_별은_오답이_기준에_닿고_최근_오답의_해설을_봤을_때만_건너뛸_수_있다() {
        jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (2, ?, 'fp', true)"
                + " ON CONFLICT (seq) DO UPDATE SET tic_id = EXCLUDED.tic_id, active = true", ticId);
        assertEquals(new TutorialState(2, false), analysis.context(memberId, ticId).body().tutorial());

        submit(memberId, List.of(), "not_matched", null, "none", true, 10);
        submit(memberId, List.of(), "not_matched", null, "none", true, 20);
        assertFalse(analysis.context(memberId, ticId).body().tutorial().skipAvailable(), "오답 2회");

        long latest = submit(memberId, List.of(), "matched", smallerId, "judgment_mismatch", false, 30);
        assertFalse(analysis.context(memberId, ticId).body().tutorial().skipAvailable(),
                "판단 불일치도 오답으로 세지만 가장 최근 오답의 해설을 보지 않았다");

        jdbc.update("UPDATE submissions SET answer_viewed = true WHERE id = ?", latest);
        assertTrue(analysis.context(memberId, ticId).body().tutorial().skipAvailable());

        // 건너뛰기는 그 별을 완료 처리한다. 재개돼 진행 중이어도 한 번 완료했으면 열지 않는다.
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completed_at)"
                + " VALUES (?, ?, 'in_progress', now())", memberId, ticId);
        assertFalse(analysis.context(memberId, ticId).body().tutorial().skipAvailable());
    }

    /** 9.3절 (b): 탐색할 수 없는 신호만 남은 별에 들어오면 성과 없이 완료하고 재개를 기다린다(AT-69). */
    @Test
    void 진입하면_탐색_불가능한_신호만_남은_진행_중인_별을_완료한다() {
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, current_curve_step)"
                + " VALUES (?, ?, 'in_progress', 2)", memberId, ticId);
        jdbc.update("UPDATE candidates SET discoverable = false WHERE id = ?", unmatchedId);

        AnalysisContext context = analysis.context(memberId, ticId).body();

        assertEquals("completed", context.progress().stage());
        assertEquals("undiscoverable_only", context.progress().completionReason());
        assertTrue(context.progress().reopenPending());
        assertNull(context.nextCurveContext());
        assertNotNull(jdbc.queryForObject("SELECT completed_at FROM user_star_progress WHERE user_id = ? AND tic_id = ?",
                OffsetDateTime.class, memberId, ticId), "판정은 조회가 아니라 진행 행에 반영된다");
    }

    @Test
    void 분석_진입도_미공개는_404_미발견은_403_현재_판이_없으면_503이다() {
        long hidden = insertStar("hidden");
        unlock(memberId, hidden);
        long withoutCurrent = insertStar("published");
        unlock(memberId, withoutCurrent);

        assertCode(ErrorCode.STAR_NOT_PUBLISHED, () -> analysis.context(memberId, hidden));
        assertCode(ErrorCode.STAR_LOCKED, () -> analysis.context(strangerId, ticId));
        assertCode(ErrorCode.DEPENDENCY_UNAVAILABLE, () -> analysis.context(memberId, withoutCurrent));
    }

    // ---------- 원본 ----------

    @Test
    void 원본_곡선은_섹터_순_세그먼트와_완료_상태를_준다() {
        Answer<Curve> answer = analysis.curve(memberId, ticId, query(currentBundleId, "0"));

        assertTrue(answer.ready());
        assertEquals("b-" + currentBundleId, answer.currentBundleId());
        Curve curve = answer.body();
        assertEquals(String.valueOf(ticId), curve.ticId());
        assertEquals("b-" + currentBundleId, curve.bundleId());
        assertEquals(1683.4231, curve.foldReferenceTimeBtjd());
        assertEquals("normalized", curve.fluxUnit());
        assertEquals(0, curve.curveContext().curveStep());
        assertEquals(List.of(), curve.curveContext().removedCandidateIds());
        assertEquals("rm-1", curve.curveContext().residualModelVersion());
        assertEquals("pg-1", curve.curveContext().periodogramConfigVersion());
        assertEquals("COMPLETED", curve.residual().status(), "원본은 계산할 것이 없어 항상 완료다");
        assertNull(curve.residual().jobId());

        assertEquals(2, curve.segments().size());
        Segment first = curve.segments().get(0);
        assertEquals("seg-" + sector14, first.segmentId());
        assertEquals(14, first.sector());
        assertEquals("10m-v1", first.binningRevision());
        assertEquals(1683.35, first.startBtjd());
        assertEquals(0, new BigDecimal("10").compareTo(first.binMinutes()));
        assertEquals(4, first.nPoints());
        assertArrayEquals(new Float[] {1.0001f, 0.9998f, null, 1.0003f}, first.flux());
        assertEquals(0, new BigDecimal("0.0012").compareTo(first.fluxScatter()));
        assertEquals(1, first.gaps().size());
        assertArrayEquals(new int[] {2, 2}, first.gaps().get(0));
        assertEquals(41, curve.segments().get(1).sector());
        assertTrue(curve.segments().get(1).gaps().isEmpty());
    }

    @Test
    void 원본_주기도는_격자_규칙과_관측_기간의_절반을_준다() {
        Answer<Periodogram> answer = analysis.periodogram(memberId, ticId, query(currentBundleId, "0"));

        assertTrue(answer.ready());
        Periodogram periodogram = answer.body();
        assertEquals("b-" + currentBundleId, periodogram.bundleId());
        assertEquals("COMPLETED", periodogram.residual().status());
        assertEquals(0, new BigDecimal("0.5").compareTo(periodogram.periodMinDays()));
        assertEquals(0, new BigDecimal("46.0").compareTo(periodogram.periodMaxDays()));
        assertEquals(3, periodogram.nPeriods());
        assertEquals("log", periodogram.gridRule());
        assertEquals(0, new BigDecimal("40.7").compareTo(periodogram.baselineHalfDays()), "81.4일의 절반");
        assertArrayEquals(new Float[] {0.012f, 0.015f, 0.011f}, periodogram.power());
    }

    // ---------- 접근 ----------

    @Test
    void 미공개이거나_없는_별은_404_열지_않은_별은_403이다() {
        long hidden = insertStar("hidden");
        unlock(memberId, hidden);

        assertCode(ErrorCode.STAR_NOT_PUBLISHED, () -> analysis.curve(memberId, hidden, query(currentBundleId, "0")));
        assertCode(ErrorCode.STAR_NOT_PUBLISHED, () -> analysis.curve(memberId, 1L, query(currentBundleId, "0")));
        assertCode(ErrorCode.STAR_LOCKED, () -> analysis.curve(strangerId, ticId, query(currentBundleId, "0")));
        assertCode(ErrorCode.STAR_LOCKED, () -> analysis.periodogram(strangerId, ticId, query(currentBundleId, "0")));
    }

    @Test
    void 현재_판이_없으면_503이다() {
        long withoutCurrent = insertStar("published");
        unlock(memberId, withoutCurrent);

        assertCode(ErrorCode.DEPENDENCY_UNAVAILABLE,
                () -> analysis.curve(memberId, withoutCurrent, query(currentBundleId, "0")));
    }

    // ---------- 판 변경 ----------

    @Test
    void 요청_판이나_계산_버전이_다르면_현재_판과_함께_거절한다() {
        BusinessException oldBundle = assertCode(ErrorCode.BUNDLE_CHANGED,
                () -> analysis.curve(memberId, ticId, query(archivedBundleId, "0")));
        assertEquals(Map.of("currentBundleId", "b-" + currentBundleId), oldBundle.getDetails());

        assertCode(ErrorCode.BUNDLE_CHANGED, () -> analysis.periodogram(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "0", null, "rm-0", null)));
        assertCode(ErrorCode.BUNDLE_CHANGED, () -> analysis.curve(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "0", null, null, "pg-0")));
        assertTrue(analysis.curve(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "0", null, "rm-1", "pg-1")).ready(), "같은 버전은 통과");
    }

    /** 제거 가능 여부는 현재 판에서만 뜻이 있다. 옛 판 요청이면 제거 조합을 보기 전에 판 변경을 알린다. */
    @Test
    void 옛_판_요청은_제거_조합이_틀려도_판_변경이_먼저다() {
        assertCode(ErrorCode.BUNDLE_CHANGED, () -> analysis.curve(memberId, ticId,
                new CurveQuery("b-" + archivedBundleId, "1", List.of("c-" + unmatchedId), null, null)));
    }

    // ---------- 요청 검증 ----------

    @Test
    void 형식이_틀린_요청은_필드와_함께_400이다() {
        assertField("bundleId", () -> analysis.curve(memberId, ticId, new CurveQuery(null, "0", null, null, null)));
        assertField("bundleId", () -> analysis.curve(memberId, ticId, new CurveQuery(String.valueOf(currentBundleId), "0", null, null, null)));
        assertField("curveStep", () -> analysis.curve(memberId, ticId, query(currentBundleId, "-1")));
        assertField("curveStep", () -> analysis.curve(memberId, ticId, query(currentBundleId, "01")));
        assertField("curveStep", () -> analysis.curve(memberId, ticId, query(currentBundleId, "one")));
        assertField("removed", () -> analysis.curve(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "1", List.of(String.valueOf(smallerId)), null, null)));
    }

    @Test
    void 단계_수와_제거_후보_수가_다르면_400이다() {
        assertField("curveStep", () -> analysis.curve(memberId, ticId, query(currentBundleId, "1")));
        assertField("curveStep", () -> analysis.curve(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "0", List.of("c-" + smallerId), null, null)));
    }

    /** 매칭하지 않은 후보와 은퇴한 후보를 같은 사유로 거절한다. 구분하면 미매칭 후보 ID가 드러난다. */
    @Test
    void 매칭하지_않았거나_은퇴한_후보는_제거할_수_없다() {
        assertField("removed", () -> analysis.curve(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "1", List.of("c-" + unmatchedId), null, null)));
        assertField("removed", () -> analysis.curve(memberId, ticId,
                new CurveQuery("b-" + currentBundleId, "1", List.of("c-" + retiredId), null, null)));
        assertField("removed", () -> analysis.periodogram(strangerMatchedOnly(), ticId,
                new CurveQuery("b-" + currentBundleId, "1", List.of("c-" + smallerId), null, null)));
    }

    @Test
    void 제거_후보는_숫자_순으로_정렬하고_중복을_없앤다() {
        Answer<Curve> answer = analysis.curve(memberId, ticId, new CurveQuery("b-" + currentBundleId, "2",
                List.of("c-" + largerId, " c-" + smallerId, "c-" + largerId, ""), null, null));

        assertEquals(List.of("c-" + smallerId, "c-" + largerId), answer.body().curveContext().removedCandidateIds());
        assertEquals(2, answer.body().curveContext().curveStep());
    }

    // ---------- 잔차 단계 ----------

    /** 조회는 작업을 만들지 않는다. 결과도 작업도 없으면 가짜 QUEUED 없이 null로 알린다(D-14). */
    @Test
    void 잔차_결과가_없으면_202_표현으로_배열을_비운다() {
        CurveQuery step1 = new CurveQuery("b-" + currentBundleId, "1", List.of("c-" + smallerId), null, null);

        Answer<Curve> curve = analysis.curve(memberId, ticId, step1);
        assertFalse(curve.ready());
        assertNull(curve.body().segments());
        assertNull(curve.body().residual().status());
        assertNull(curve.body().residual().jobId());
        assertEquals(List.of("c-" + smallerId), curve.body().curveContext().removedCandidateIds());

        Answer<Periodogram> periodogram = analysis.periodogram(memberId, ticId, step1);
        assertFalse(periodogram.ready());
        assertNull(periodogram.body().power());
        assertEquals(3, periodogram.body().nPeriods(), "격자 정보는 준비 여부와 무관하게 준다");
    }

    @Test
    void 잔차_결과가_있으면_원본_격자에_잔차_값을_싣는다() {
        OffsetDateTime computedAt = OffsetDateTime.of(2026, 9, 10, 2, 31, 10, 0, ZoneOffset.UTC);
        when(residuals.lookup(any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED", "rj-77", computedAt,
                Map.of(sector14, new Float[] {1.0f, 1.0f, null, 1.0f}, sector41, new Float[] {1.0f, 1.0f}),
                new Float[] {0.2f, 0.3f, 0.1f}));
        CurveQuery step1 = new CurveQuery("b-" + currentBundleId, "1", List.of("c-" + smallerId), null, null);

        Curve curve = analysis.curve(memberId, ticId, step1).body();
        assertEquals("rj-77", curve.residual().jobId());
        assertEquals(computedAt, curve.residual().computedAt());
        Segment first = curve.segments().get(0);
        assertEquals("seg-" + sector14, first.segmentId());
        assertArrayEquals(new Float[] {1.0f, 1.0f, null, 1.0f}, first.flux());
        assertEquals(1683.35, first.startBtjd(), "잔차는 원본과 같은 격자다");
        assertArrayEquals(new int[] {2, 2}, first.gaps().get(0));

        Periodogram periodogram = analysis.periodogram(memberId, ticId, step1).body();
        assertArrayEquals(new Float[] {0.2f, 0.3f, 0.1f}, periodogram.power());
        assertEquals("COMPLETED", periodogram.residual().status());
    }

    @Test
    void 잔차_결과의_점_수가_원본과_다르면_내주지_않는다() {
        when(residuals.lookup(any())).thenReturn(new ResidualResultReader.Lookup("COMPLETED", "rj-78", null,
                Map.of(sector14, new Float[] {1.0f}, sector41, new Float[] {1.0f, 1.0f}), new Float[] {0.2f}));
        CurveQuery step1 = new CurveQuery("b-" + currentBundleId, "1", List.of("c-" + smallerId), null, null);

        assertThrows(IllegalStateException.class, () -> analysis.curve(memberId, ticId, step1));
        assertThrows(IllegalStateException.class, () -> analysis.periodogram(memberId, ticId, step1));
    }

    // ---------- 적재 계약 ----------

    @Test
    void 공백_구간이_점_범위를_벗어나면_곡선을_내주지_않는다() {
        long broken = insertStar("published");
        unlock(memberId, broken);
        long segment = insertSegment(broken, 7, 1500.0, new Float[] {1.0f, null}, "[[1, 5]]", null);
        insertBundle(broken, "current", "rm-1", List.of(segment));

        long bundle = jdbc.queryForObject("SELECT id FROM publication_bundles WHERE tic_id = ? AND status = 'current'",
                Long.class, broken);
        assertThrows(IllegalStateException.class, () -> analysis.curve(memberId, broken, query(bundle, "0")));
    }

    // ---------- 도우미 ----------

    private static CurveQuery query(long bundleId, String curveStep) {
        return new CurveQuery("b-" + bundleId, curveStep, null, null, null);
    }

    private static BusinessException assertCode(ErrorCode expected, Executable call) {
        BusinessException e = assertThrows(BusinessException.class, call);
        assertEquals(expected, e.getErrorCode());
        return e;
    }

    private static void assertField(String field, Executable call) {
        BusinessException e = assertCode(ErrorCode.VALIDATION_FAILED, call);
        assertEquals(field, e.getFieldErrors().get(0).field(), e.getFieldErrors().toString());
    }

    /** 별을 열었지만 매칭은 없는 회원. 남의 매칭으로 제거 조합을 만들 수 없어야 한다. */
    private long strangerMatchedOnly() {
        unlock(strangerId, ticId);
        return strangerId;
    }

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long insertStar(String serviceStatus) {
        long id = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, tmag, confirmed_count, service_status) VALUES (?, 9.8, 0, ?)",
                id, serviceStatus);
        return id;
    }

    private void unlock(long member, long star) {
        int ordinal = jdbc.queryForObject("SELECT COALESCE(MAX(layout_ordinal) + 1, 0) FROM star_unlocks"
                + " WHERE user_id = ?", Integer.class, member);
        var position = layout.place(ordinal);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                member, star, position.depthZ(), position.worldX(), position.worldY(),
                position.layoutVersion(), ordinal);
    }

    private long insertSegment(long star, int sector, double startBtjd, Float[] flux, String gaps, String scatter) {
        return jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd,"
                        + " bin_minutes, n_points, flux, flux_scatter, gaps)"
                        + " VALUES (?, ?, '10m-v1', ?, 10, ?, ?, ?::numeric, ?::jsonb) RETURNING id",
                Long.class, star, sector, startBtjd, flux.length, flux, scatter, gaps);
    }

    private long insertBundle(long star, String status, String residualModelVersion, List<Long> segmentIds) {
        String manifest = """
                {"segment_ids": %s, "array_checksums": {},
                 "residual_model_version": "%s", "periodogram_config_version": "pg-1",
                 "binning": {"minutes": 10}, "period_grid": {"spacing": "log"},
                 "fine_tune": {"half_width_cells": 3}, "curve_steps": {}}
                """.formatted(segmentIds, residualModelVersion);
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, ?, ?::jsonb, 1683.4231, 81.4) RETURNING id",
                Long.class, star, "pv1-" + UUID.randomUUID(), status, manifest);
    }

    /** id를 주면 그 값으로 넣는다. 문자열 정렬과 숫자 정렬이 갈리는 id가 필요할 때 쓴다. */
    private long insertCandidate(Long id, String status) {
        return jdbc.queryForObject("INSERT INTO candidates(id, tic_id, status, updated_bundle_id, removal_step,"
                        + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,"
                        + " discoverable, is_confirmed)"
                        + " VALUES (COALESCE(?, nextval(pg_get_serial_sequence('candidates', 'id'))), ?, ?, ?, 1,"
                        + " 3.0, 1684.0, 2.0, 900, 10.0, '{}'::jsonb, true, false) RETURNING id",
                Long.class, id, ticId, status, currentBundleId);
    }

    private void insertObservation(int sector) {
        jdbc.update("INSERT INTO observation_datasets(tic_id, sector, start_btjd, end_btjd, cadence, source_version,"
                + " time_system) VALUES (?, ?, 1683.0, 1710.0, '120s', 'spoc-test', 'BTJD')", ticId, sector);
    }

    /** 곡선 단계 제출. {@code secondsLater}로 시각을 뒤로 밀어 "마지막 제출"을 정한다. */
    private long submit(long member, List<Long> removed, String matchResult, Long matchedCandidateId,
                        String achievementResult, boolean answerViewed, int secondsLater) {
        return jdbc.queryForObject("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, answer_viewed, created_at,"
                        + " residual_model_version, periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', ?, ?, 3.0, 0.1, 0.2, 1683.4231,"
                        + " 'LIKELY_PLANET', '[]'::jsonb, ?, ?, ?, ?, now() + make_interval(secs => ?),"
                        + " 'rm-1', 'pg-1', 'rule-0') RETURNING id",
                Long.class, member, ticId, archivedBundleId, UUID.randomUUID().toString(), removed.size(),
                removed.toArray(new Long[0]), matchResult, matchedCandidateId, achievementResult, answerViewed,
                secondsLater);
    }

    private void match(long member, long candidateId) {
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.0, 0.1, 0.2, 1683.4231,"
                        + " 'LIKELY_PLANET', '[]'::jsonb, 'matched', ?, 'recognized', 'rm-1', 'pg-1', 'rule-0')",
                member, ticId, currentBundleId, UUID.randomUUID().toString(), candidateId);
    }
}
