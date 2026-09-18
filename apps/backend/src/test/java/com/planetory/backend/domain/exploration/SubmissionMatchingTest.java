package com.planetory.backend.domain.exploration;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

import com.planetory.backend.domain.exploration.service.SubmissionMatching;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Evaluation;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Match;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.MatchStatus;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Observation;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.ObservedWindow;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Reason;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Rejection;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Rules;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Selection;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Validation;
import com.planetory.backend.domain.gold.GoldCatalogViews;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 제출 매칭의 입력 경계와 판 입력 만들기 [S15P21C206-142]. 판정 규칙 자체는 {@link SubmissionMatchingCasesTest}가
 * 공통 표본으로 본다.
 */
class SubmissionMatchingTest {

    /** 공통 표본과 같은 합성 별: 60일 관측에 5일 공백, 10분 간격. */
    private static final Observation OBSERVATION = new Observation(2000, 1990, 2050,
            List.of(new ObservedWindow(1990, 2015, 10 / 1440.0), new ObservedWindow(2020, 2050, 10 / 1440.0)),
            0.5, 40);
    private static final Rules RULE_0 = new Rules(20 / 1440.0, 0.25, 3, false, List.of(1.0, 2.0, 0.5), null,
            0.5, 2, 1, 0.5, 0.1, 0.1);

    // ---------- AT-09 입력 경계 ----------

    @Test
    void 주기가_0_음수_무한대_NaN이면_거절한다() {
        for (double period : new double[] {0, -5, Double.POSITIVE_INFINITY, Double.NaN}) {
            assertEquals(new Rejection("selection.periodDays", Reason.VALIDATION_FAILED),
                    validate(new Selection(period, 0.19, 0.21, null)).rejection(), "주기 " + period);
        }
        assertEquals(new Rejection("selection.periodDays", Reason.VALIDATION_FAILED),
                validate(new Selection(5, Double.NaN, 0.21, null)).rejection(), "위상이 유한하지 않다");
    }

    @Test
    void 위상_범위를_벗어나거나_폭이_0이거나_한_바퀴_이상이면_거절한다() {
        for (Selection selection : List.of(new Selection(5, -0.01, 0.01, null), new Selection(5, 1.0, 1.02, null),
                new Selection(5, 0.2, 0.2, null), new Selection(5, 0.2, 1.2, null), new Selection(5, 0.3, 0.2, null))) {
            assertEquals(new Rejection("selection.phaseEnd", Reason.VALIDATION_FAILED),
                    validate(selection).rejection(), selection.toString());
        }
    }

    /** {@code phaseStart < 1 < phaseEnd}는 경계 통과이며 정상이다. 서버가 epoch·duration을 다시 산정한다. */
    @Test
    void 위상_경계를_넘는_선택은_받고_epoch와_duration을_서버가_산정한다() {
        Validation validation = validate(new Selection(5, 0.99, 1.01, null));

        assertTrue(validation.ok(), () -> String.valueOf(validation.rejection()));
        assertEquals(0.0, validation.derived().phaseCenter(), 1e-12);
        assertEquals(2000.0, validation.derived().epochBtjd(), 1e-9, "기준 시각에 가장 가까운 통과");
        assertEquals(0.02 * 5 * 24, validation.derived().durationHours(), 1e-9);
        assertNull(validation.derived().durationLimitHours(), "봉우리를 고르지 않았으면 추천 상한이 없다");
    }

    // ---------- 8단계 판단·근거 ----------

    @Test
    void 판단과_근거_체크는_허용_목록만_받는다() {
        Selection selection = new Selection(5, 0.19, 0.21, null);
        assertEquals(new Rejection("userJudgment", Reason.VALIDATION_FAILED),
                SubmissionMatching.validate(OBSERVATION, RULE_0, selection, "MAYBE", List.of(), Map.of()).rejection());
        assertEquals(new Rejection("userJudgment", Reason.VALIDATION_FAILED),
                SubmissionMatching.validate(OBSERVATION, RULE_0, selection, null, List.of(), Map.of()).rejection());
        assertEquals(new Rejection("evidenceChecks", Reason.VALIDATION_FAILED),
                SubmissionMatching.validate(OBSERVATION, RULE_0, selection, "UNSURE", List.of("center"), Map.of())
                        .rejection(), "중심 위치는 근거 체크가 아니다(POL-13)");
        assertEquals(new Rejection("evidenceChecks", Reason.VALIDATION_FAILED),
                SubmissionMatching.validate(OBSERVATION, RULE_0, selection, "UNSURE", List.of("ushape", "ushape"),
                        Map.of()).rejection());
        assertTrue(SubmissionMatching.validate(OBSERVATION, RULE_0, selection, "UNLIKELY_PLANET",
                List.of("oddeven", "secondary", "ushape"), Map.of()).ok());
    }

    // ---------- 판 입력 ----------

    /** 점 시각은 곡선 응답과 같은 bin 시작 시각이고, 결측이 아닌 점이 이어진 구간마다 창이 하나다. */
    @Test
    void 관측_창은_결측이_아닌_점이_이어진_구간이다() {
        double cadence = 10 / 1440.0;
        LightCurveSegment later = segment(2, 1700.0, new Float[] {1f, 1f, null, null, 1f});
        LightCurveSegment earlier = segment(1, 1680.0, new Float[] {null, 1f, 1f, 1f});
        LightCurveSegment empty = segment(3, 1720.0, new Float[] {null, null});

        List<ObservedWindow> windows = SubmissionMatching.windowsOf(List.of(later, empty, earlier));

        assertEquals(List.of(
                new ObservedWindow(1680.0 + cadence, 1680.0 + cadence * 3, cadence),
                new ObservedWindow(1700.0, 1700.0 + cadence, cadence),
                new ObservedWindow(1700.0 + cadence * 4, 1700.0 + cadence * 4, cadence)), windows);
    }

    @Test
    void 판의_관측_범위와_최소_창과_격자_범위를_세그먼트와_주기도에서_만든다() {
        LightCurveSegment first = segment(1, 1683.35, new Float[] {1f, 1f, null, 1f});
        LightCurveSegment second = segment(2, 2419.99, new Float[] {1f, 1f});
        var bundle = new GoldCatalogViews.Bundle(2, 9, "v1", GoldCatalogViews.Bundle.Status.CURRENT, null, 1683.4231,
                new BigDecimal("81.4"), null);
        var periodogram = new GoldCatalogViews.Periodogram(2, new BigDecimal("0.5"), new BigDecimal("46.0"), 3, null);

        Observation observation = SubmissionMatching.observationOf(bundle, List.of(first, second), periodogram);

        assertEquals(1683.4231, observation.foldReferenceTimeBtjd());
        assertEquals(1683.35, observation.observationStartBtjd());
        assertEquals(2419.99 + 2 * 10.0 / 1440.0, observation.observationEndBtjd(), "끝은 마지막 bin의 끝이다");
        assertEquals(0.5, observation.periodMinDays());
        assertEquals(46.0, observation.periodMaxDays());
        assertEquals(3, observation.windows().size());
        assertEquals(2 * 10.0 / 1440.0, SubmissionMatching.minWindowDays(List.of(first, second)));
    }

    @Test
    void 비교_후보는_활성이고_탐색_가능하며_제거하지_않은_것뿐이다() {
        var kept = candidate(1, GoldCatalogViews.Candidate.Status.ACTIVE, true);
        var retired = candidate(2, GoldCatalogViews.Candidate.Status.RETIRED, true);
        var undiscoverable = candidate(3, GoldCatalogViews.Candidate.Status.ACTIVE, false);
        var removed = candidate(4, GoldCatalogViews.Candidate.Status.ACTIVE, true);

        var compared = SubmissionMatching.candidatesToCompare(List.of(kept, retired, undiscoverable, removed), Set.of(4L));

        assertEquals(List.of(new SubmissionMatching.Candidate(1, 5, 2001, 2.4)), compared);
    }

    // ---------- 관측 통과 수 상한 ----------

    /**
     * 상한({@code n_transits_cap})은 주기 누적 오차의 N에만 건다. 중첩 비율의 분모는 상한 전 관측 통과 수라
     * 0~1을 벗어나지 않는다. 상한을 분모에 쓰면 이 사례에서 11이 되어 우세 판정의 중첩 비교가 틀어진다.
     */
    @Test
    void 통과_수_상한은_주기_오차에만_걸고_중첩_비율은_관측된_통과_전체로_센다() {
        Rules capped = new Rules(20 / 1440.0, 0.25, 3, false, List.of(1.0, 2.0, 0.5), 1, 0.5, 2, 1, 0.5, 0.1, 0.1);
        Selection selection = new Selection(5.001, 0.19, 0.21, null);
        Validation validation = SubmissionMatching.validate(OBSERVATION, capped, selection, "LIKELY_PLANET", List.of(),
                Map.of());
        assertTrue(validation.ok(), () -> String.valueOf(validation.rejection()));

        Match match = SubmissionMatching.match(OBSERVATION, capped, selection, validation.derived(),
                List.of(new SubmissionMatching.Candidate(401, 5, 2001, 2.4)), List.of());

        Evaluation direct = match.evaluations().stream().filter(e -> e.multiplier() == 1).findFirst().orElseThrow();
        assertEquals(11, direct.observedTransits(), "2016년 통과는 공백이라 관측 통과는 11회다");
        assertEquals(1, direct.nTransits(), "주기 조건의 N은 상한 1이다");
        double halfWidth = Math.max(2.4 / 24 / 2, 20 / 1440.0 / 2);
        assertEquals(Math.abs(5.001 - 5) * 1 / halfWidth, direct.ePeriod(), 1e-12, "누적 오차는 상한을 건 N으로 잰다");
        assertEquals(11, direct.overlapTransits());
        assertEquals(1.0, direct.overlapRatio(), "중첩 비율 = 겹친 통과 / 관측 통과");
        assertTrue(match.evaluations().stream().allMatch(e -> e.overlapRatio() >= 0 && e.overlapRatio() <= 1));
    }

    // ---------- duplicate ----------

    @Test
    void 일치한_후보에_이미_성과가_있으면_duplicate이고_아니면_그대로다() {
        Match matched = new Match(MatchStatus.MATCHED_HARMONIC, 403L, 2.0, 11.8, "single passer", List.of(403L), null,
                List.of());
        Match duplicate = SubmissionMatching.markDuplicate(matched, Set.of(403L));
        assertEquals(MatchStatus.DUPLICATE, duplicate.status());
        assertEquals(403L, duplicate.candidateId(), "정정 결과는 남긴다");
        assertEquals(2.0, duplicate.harmonicMultiplier());

        assertSame(matched, SubmissionMatching.markDuplicate(matched, Set.of(401L)));
        Match ambiguous = new Match(MatchStatus.AMBIGUOUS_MATCH, null, null, null, "tie", List.of(401L, 402L), null,
                List.of());
        assertSame(ambiguous, SubmissionMatching.markDuplicate(ambiguous, Set.of(401L, 402L)),
                "후보를 고르지 못한 제출은 duplicate가 아니다");
    }

    private static Validation validate(Selection selection) {
        return SubmissionMatching.validate(OBSERVATION, RULE_0, selection, "LIKELY_PLANET", List.of(), Map.of());
    }

    private static LightCurveSegment segment(long id, double startBtjd, Float[] flux) {
        return new LightCurveSegment(id, 9, (short) id, "10m-v1", startBtjd, new BigDecimal("10"), flux.length, flux,
                null, null);
    }

    private static GoldCatalogViews.Candidate candidate(long id, GoldCatalogViews.Candidate.Status status,
                                                        boolean discoverable) {
        return new GoldCatalogViews.Candidate(id, 9, status, 2, (short) 1, new BigDecimal("5"), new BigDecimal("2001"),
                new BigDecimal("2.4"), new BigDecimal("900"), new BigDecimal("10"), null, discoverable, false);
    }
}
