package com.planetory.backend.domain.exploration.service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.planetory.backend.domain.gold.GoldCatalogViews;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;

/**
 * 제출 수치 검증·epoch·duration 산정·후보 매칭 (탐사 API 2.5·6.2·6.3 3단계, SRS 5.1·5.2) [S15P21C206-142].
 *
 * <p>판정은 제출 매칭 수치 규칙 v0({@code docs/api/exploration/matching-rules.v0.json}, S15P21C206-128)와
 * 참조 구현 {@code matching-v0.cjs}를 그대로 옮긴다. 같은 입력이면 언어와 무관하게 같은 판정이어야 하므로
 * 공통 표본 {@code matching-cases.v0.json}으로 대조한다. 계산은 float64이며 중간값을 반올림하지 않고,
 * 경계 비교에는 epsilon을 더하지 않는다.
 *
 * <p>DB와 트랜잭션을 모른다. 인증·판·곡선 문맥 검사(6.2절 1~3단계)와 저장은 제출 처리(S15P21C206-143)가 한다.
 */
public final class SubmissionMatching {

    /** 점수 동률 판정에만 쓰는 계산 오차(규칙 v0 {@code numerics.epsilon}). 통과·우세 비교에는 쓰지 않는다. */
    static final double EPSILON = 1e-9;

    private static final double HOURS_PER_DAY = 24.0;
    private static final double MINUTES_PER_DAY = 1440.0;
    /** 창 끝의 표본을 놓치지 않게 하는 여유. 참조 구현과 같은 값이다. */
    private static final double SAMPLE_TOLERANCE = 1e-12;

    private static final Set<String> USER_JUDGMENTS = Set.of("LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE");
    private static final Set<String> EVIDENCE_CHECKS = Set.of("oddeven", "secondary", "ushape");

    private SubmissionMatching() {
    }

    // ------------------------------------------------------------------ 입력

    /** 사용자가 고른 원본 입력(6.1절 {@code selection}). {@code phaseEnd > 1}인 경계 통과도 정상이다. */
    public record Selection(double periodDays, double phaseStart, double phaseEnd, Integer sourcePeakGridIndex) {
    }

    /**
     * 관측점이 이어진 시간 구간. 결측이 아닌 점이 연속한 {@code [첫 점, 마지막 점]}이며 점 시각은 곡선 응답과
     * 같은 bin 시작 시각이다(탐사 API 5.2, 2026-09-18 결정).
     *
     * @param cadenceDays 창 안의 점 간격. 선택 구간의 관측점 존재를 이 간격으로 표본화해 판정한다
     */
    public record ObservedWindow(double startBtjd, double endBtjd, double cadenceDays) {
    }

    /**
     * 판 하나의 관측 정보.
     *
     * @param observationStartBtjd epoch 산정 범위의 시작. 세그먼트 시작의 최솟값
     * @param observationEndBtjd   epoch 산정 범위의 끝. 세그먼트 마지막 bin 끝의 최댓값
     * @param periodMinDays        주기도 격자 범위(5.3절)
     */
    public record Observation(double foldReferenceTimeBtjd, double observationStartBtjd, double observationEndBtjd,
                              List<ObservedWindow> windows, double periodMinDays, double periodMaxDays) {
    }

    /** 같은 곡선 문맥의 봉우리(5.4절). 미세 조정 범위와 추천 duration만 쓴다. */
    public record Peak(int gridIndex, double fineTuneMinDays, double fineTuneMaxDays, Double suggestedDurationHours) {
    }

    /** 비교 대상 후보. {@link #candidatesToCompare}가 거른 뒤의 값이다. */
    public record Candidate(long id, double periodDays, double epochBtjd, double durationHours) {
    }

    /**
     * 판정 규칙. 선택 폭·허용 오차·배율은 운영 규칙 버전에서, 최소 창은 판의 bin 크기에서 온다.
     *
     * @param nTransitsCap 관측 통과 수 N 상한. null이면 상한이 없다
     */
    public record Rules(double minWindowDays, double phaseWidthMax, double maxDurationMultipleOfSuggested,
                        boolean allowEmptyPhaseSpan, List<Double> harmonicMultipliers, Integer nTransitsCap,
                        double durationRatioMin, double durationRatioMax, int minOverlapTransits,
                        double dominanceRatio, double minScoreGap, double overlapRatioTolerance) {

        public static Rules of(OperationRule rule, double minWindowDays) {
            OperationRule.Selection selection = rule.selection();
            OperationRule.Matching matching = rule.matching();
            return new Rules(minWindowDays, selection.phaseWidthMax(), selection.maxDurationMultipleOfSuggested(),
                    selection.allowEmptyPhaseSpan(), List.copyOf(matching.harmonicMultipliers()),
                    matching.nTransitsCap(), matching.durationRatioMin(), matching.durationRatioMax(),
                    matching.minOverlapTransits(), matching.dominanceRatio(), matching.minScoreGap(),
                    matching.overlapRatioTolerance());
        }
    }

    // ------------------------------------------------------------------ 판의 입력 만들기

    /**
     * 최소 허용 창 = 제공 곡선 케이던스의 2배(SRS 5.1). 제공 곡선의 케이던스는 bin 크기다(제출 매칭 규칙 v0).
     */
    public static double minWindowDays(List<LightCurveSegment> segments) {
        return 2 * segments.stream().mapToDouble(s -> s.binMinutes().doubleValue()).min().orElseThrow()
                / MINUTES_PER_DAY;
    }

    /** 판의 관측 정보. epoch 산정 범위의 끝은 마지막 bin의 끝이라 곡선 x축 범위와 같다(5.1절). */
    public static Observation observationOf(GoldCatalogViews.Bundle bundle, List<LightCurveSegment> segments,
                                            GoldCatalogViews.Periodogram periodogram) {
        double start = segments.stream().mapToDouble(LightCurveSegment::startBtjd).min().orElseThrow();
        double end = segments.stream()
                .mapToDouble(s -> s.startBtjd() + s.nPoints() * s.binMinutes().doubleValue() / MINUTES_PER_DAY)
                .max().orElseThrow();
        return new Observation(bundle.foldReferenceTimeBtjd(), start, end, windowsOf(segments),
                periodogram.periodMinDays().doubleValue(), periodogram.periodMaxDays().doubleValue());
    }

    /**
     * 제출 판정용 관측 창(6.2절). 표시·접기의 bin 중심과 별개로 시작 시각 {@code startBtjd + (binMinutes / 1440) × i}를 쓰며, 결측(null)이 아닌 점이
     * 이어진 구간마다 창 하나를 만든다. 공백에만 걸린 통과는 창과 겹치지 않으므로 세지 않는다.
     */
    public static List<ObservedWindow> windowsOf(List<LightCurveSegment> segments) {
        List<ObservedWindow> windows = new ArrayList<>();
        for (LightCurveSegment segment : segments) {
            double cadence = segment.binMinutes().doubleValue() / MINUTES_PER_DAY;
            Float[] flux = segment.flux();
            int runStart = -1;
            for (int i = 0; i <= flux.length; i++) {
                boolean observed = i < flux.length && flux[i] != null;
                if (observed && runStart < 0) {
                    runStart = i;
                } else if (!observed && runStart >= 0) {
                    windows.add(new ObservedWindow(segment.startBtjd() + cadence * runStart,
                            segment.startBtjd() + cadence * (i - 1), cadence));
                    runStart = -1;
                }
            }
        }
        windows.sort(Comparator.comparingDouble(ObservedWindow::startBtjd));
        return windows;
    }

    /**
     * 비교할 후보: 이 판의 활성·탐색 가능 후보 중 곡선에서 제거하지 않은 것(6.3절 3단계). 은퇴·탐색 불가능·
     * 제거 후보는 판정 대상이 아니다.
     */
    public static List<Candidate> candidatesToCompare(List<GoldCatalogViews.Candidate> candidates,
                                                      Collection<Long> removedCandidateIds) {
        return candidates.stream()
                .filter(c -> c.status() == GoldCatalogViews.Candidate.Status.ACTIVE)
                .filter(GoldCatalogViews.Candidate::discoverable)
                .filter(c -> !removedCandidateIds.contains(c.id()))
                .map(c -> new Candidate(c.id(), c.periodDays().doubleValue(), c.epochBtjd().doubleValue(),
                        c.durationHours().doubleValue()))
                .toList();
    }

    // ------------------------------------------------------------------ 6.2 검증

    /** 검증 실패 사유. 표본({@code matching-cases.v0.json})의 {@code code}와 같은 이름이다. */
    public enum Reason {
        VALIDATION_FAILED, MIN_WINDOW, PHASE_WIDTH_MAX, UNKNOWN_PEAK, OUTSIDE_FINE_TUNE, DURATION_LIMIT,
        EMPTY_PHASE_SPAN, EPOCH_OUT_OF_RANGE, OUTSIDE_PERIOD_GRID
    }

    /** 첫 실패. {@code field}는 6.2절 {@code fieldErrors[].field} 이름이다. */
    public record Rejection(String field, Reason reason) {
    }

    /**
     * 서버 산정값(2.5절). 브라우저 값은 미리보기이고 이 값만 저장한다.
     *
     * @param sourcePeakSuggestedDurationHours 고른 봉우리의 추천 duration. 직접 주기 선택이면 null
     * @param durationLimitHours               추천 duration × 배수 상한. 직접 주기 선택이면 null
     */
    public record Derived(double phaseCenter, double epochBtjd, double durationDays,
                          Double sourcePeakSuggestedDurationHours, Double durationLimitHours) {

        public double durationHours() {
            return durationDays * HOURS_PER_DAY;
        }
    }

    /** 검증 결과. 통과면 {@code derived}, 실패면 {@code rejection}만 있다. */
    public record Validation(Derived derived, Rejection rejection) {

        public boolean ok() {
            return rejection == null;
        }

        static Validation rejected(String field, Reason reason) {
            return new Validation(null, new Rejection(field, reason));
        }
    }

    /**
     * 6.2절 4~9단계를 순서대로 검사하고 첫 실패에서 멈춘다. 인증·판·곡선 문맥(1~3단계)은 호출자가 먼저 본다.
     *
     * <p>봉우리 상한은 사용자가 고른 봉우리({@code sourcePeakGridIndex})에만 적용하고, 주기만 보고 가까운
     * 봉우리를 역추정하지 않는다(C02-R3). 제출 주기는 상위 N 봉우리에 속하지 않아도 되며 격자 범위 안이면 된다.
     *
     * @param peaks 같은 곡선 문맥의 봉우리를 {@code gridIndex}로 찾는다
     */
    public static Validation validate(Observation observation, Rules rules, Selection selection,
                                      String userJudgment, List<String> evidenceChecks, Map<Integer, Peak> peaks) {
        double period = selection.periodDays();
        double phaseStart = selection.phaseStart();
        double phaseEnd = selection.phaseEnd();
        // 4. 입력 범위. 필드 이름은 참조 구현과 같다: 주기 문제는 periodDays, 위상 문제는 phaseEnd.
        if (!Double.isFinite(period) || period <= 0 || !Double.isFinite(phaseStart) || !Double.isFinite(phaseEnd)) {
            return Validation.rejected("selection.periodDays", Reason.VALIDATION_FAILED);
        }
        if (!(phaseStart >= 0 && phaseStart < 1 && phaseStart < phaseEnd && phaseEnd < phaseStart + 1)) {
            return Validation.rejected("selection.phaseEnd", Reason.VALIDATION_FAILED);
        }
        // 5. 선택 폭(DEC-19, C02-R3)
        double width = phaseEnd - phaseStart;
        if (width * period < rules.minWindowDays()) {
            return Validation.rejected("selection.phaseEnd", Reason.MIN_WINDOW);
        }
        if (width > rules.phaseWidthMax()) {
            return Validation.rejected("selection.phaseEnd", Reason.PHASE_WIDTH_MAX);
        }
        Double suggested = null;
        Double durationLimitHours = null;
        if (selection.sourcePeakGridIndex() != null) {
            Peak peak = peaks.get(selection.sourcePeakGridIndex());
            if (peak == null) {
                return Validation.rejected("selection.sourcePeakGridIndex", Reason.UNKNOWN_PEAK);
            }
            if (!(period >= peak.fineTuneMinDays() && period <= peak.fineTuneMaxDays())) {
                return Validation.rejected("selection.sourcePeakGridIndex", Reason.OUTSIDE_FINE_TUNE);
            }
            // 제안 duration은 판이 주기별 BLS 값을 실을 때만 있다. 모르면 상한을 걸지 않는다 —
            // 모르는 값으로 만든 상한은 사용자가 이유를 알 수 없는 거절이 된다. 폭 상한과 최소 창은
            // 그대로 적용된다(S15P21C206-141, 미결 5 후속).
            suggested = peak.suggestedDurationHours();
            if (suggested != null) {
                durationLimitHours = suggested * rules.maxDurationMultipleOfSuggested();
                if (width * period * HOURS_PER_DAY > durationLimitHours) {
                    return Validation.rejected("selection.phaseEnd", Reason.DURATION_LIMIT);
                }
            }
        }
        if (!rules.allowEmptyPhaseSpan() && !spanHasObservedPoint(observation, period, phaseStart, phaseEnd)) {
            return Validation.rejected("selection.phaseEnd", Reason.EMPTY_PHASE_SPAN);
        }
        // 6. epoch 산정
        double phaseCenter = mod1((phaseStart + phaseEnd) / 2);
        Double epoch = deriveEpoch(observation, period, phaseCenter);
        if (epoch == null) {
            return Validation.rejected("selection", Reason.EPOCH_OUT_OF_RANGE);
        }
        // 7. 0 < duration < 주기
        double durationDays = width * period;
        if (!(durationDays > 0 && durationDays < period)) {
            return Validation.rejected("selection", Reason.VALIDATION_FAILED);
        }
        // 8. 판단·근거 체크
        if (userJudgment == null || !USER_JUDGMENTS.contains(userJudgment)) {
            return Validation.rejected("userJudgment", Reason.VALIDATION_FAILED);
        }
        if (evidenceChecks != null && (evidenceChecks.size() > EVIDENCE_CHECKS.size()
                || !EVIDENCE_CHECKS.containsAll(evidenceChecks)
                || Set.copyOf(evidenceChecks).size() != evidenceChecks.size())) {
            return Validation.rejected("evidenceChecks", Reason.VALIDATION_FAILED);
        }
        // 9. 주기도 격자 범위(5.3절). 상위 N 봉우리에 속할 필요는 없다.
        if (period < observation.periodMinDays() || period > observation.periodMaxDays()) {
            return Validation.rejected("selection.periodDays", Reason.OUTSIDE_PERIOD_GRID);
        }
        return new Validation(new Derived(phaseCenter, epoch, durationDays, suggested, durationLimitHours), null);
    }

    /**
     * {@code epoch = T + (phaseCenter + k) × P}. k는 epoch가 관측 범위 안이면서 {@code |epoch − T|}가 최소인 정수이고,
     * 동률이면 더 이른 시각이다(2.5절). 그런 k가 없으면 null.
     */
    static Double deriveEpoch(Observation observation, double period, double phaseCenter) {
        double reference = observation.foldReferenceTimeBtjd();
        long kLo = (long) Math.ceil((observation.observationStartBtjd() - reference) / period - phaseCenter);
        long kHi = (long) Math.floor((observation.observationEndBtjd() - reference) / period - phaseCenter);
        Double best = null;
        double bestDistance = 0;
        for (long k = kLo; k <= kHi; k++) {
            double epoch = reference + (phaseCenter + k) * period;
            double distance = Math.abs(epoch - reference);
            if (best == null || distance < bestDistance - EPSILON
                    || (Math.abs(distance - bestDistance) <= EPSILON && epoch < best)) {
                best = epoch;
                bestDistance = distance;
            }
        }
        return best;
    }

    /** 접힌 위상 {@code [phaseStart, phaseEnd]}에 관측점이 하나라도 있는지. {@code phaseEnd}는 1을 넘을 수 있다. */
    private static boolean spanHasObservedPoint(Observation observation, double period, double phaseStart,
                                                double phaseEnd) {
        double reference = observation.foldReferenceTimeBtjd();
        for (ObservedWindow window : observation.windows()) {
            for (double t = window.startBtjd(); t <= window.endBtjd() + SAMPLE_TOLERANCE; t += window.cadenceDays()) {
                double phase = mod1((t - reference) / period);
                if ((phase >= phaseStart && phase <= phaseEnd) || (phase + 1 >= phaseStart && phase + 1 <= phaseEnd)) {
                    return true;
                }
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ 5.1·5.2 매칭

    /** 매칭 결과. DB {@code submissions.match_result} 값과 같다. */
    public enum MatchStatus {
        MATCHED("matched"), MATCHED_HARMONIC("matched_harmonic"), NOT_MATCHED("not_matched"),
        AMBIGUOUS_MATCH("ambiguous_match"), DUPLICATE("duplicate");

        private final String value;

        MatchStatus(String value) {
            this.value = value;
        }

        public String value() {
            return value;
        }
    }

    /**
     * 후보 하나·배율 하나의 평가(SRS 5.1). 오차는 허용치로 나눈 값이라 1 이하가 통과다.
     *
     * @param nTransits        주기 조건의 N. 관측된 통과 수에 운영 규칙의 상한({@code n_transits_cap})을 건 값이다
     * @param observedTransits 관측된 후보 통과 수. 상한을 걸지 않는다
     * @param overlapRatio     관측된 통과 중 사용자 창과 겹친 비율({@code overlapTransits / observedTransits}).
     *                         0~1이며 우세 판정의 중첩 비교에만 쓴다
     * @param score            {@code max(ePeriod, eEpoch, eDuration)}. 허용치 대비 가장 약한 조건이며 순위에만 쓴다
     */
    public record Evaluation(long candidateId, double multiplier, double correctedPeriodDays, int nTransits,
                             int observedTransits, double ePeriod, double eEpoch, double eDuration,
                             double durationRatio, boolean durationPass, int overlapTransits, double overlapRatio,
                             boolean pass, double score) {
    }

    /** 통과 후보가 둘 이상일 때 1·2위 비교. */
    public record Dominance(double s1, double s2, double r1, double r2, boolean gapOk, boolean ratioOk,
                           boolean overlapOk, boolean tie) {
    }

    /**
     * @param harmonicMultiplier  채택한 해석의 배율({@code P_corrected = P_user × m}). 없으면 null
     * @param rankedCandidateIds  비교 집합의 후보를 점수 순으로(동점이면 id 순)
     * @param decision            판정 이유. 진단용 문장이며 저장하지 않는다
     * @param evaluations         모든 후보·배율 평가(후보 id, 배율 순서)
     */
    public record Match(MatchStatus status, Long candidateId, Double harmonicMultiplier, Double correctedPeriodDays,
                        String decision, List<Long> rankedCandidateIds, Dominance dominance,
                        List<Evaluation> evaluations) {
    }

    /**
     * 5.2절 후보 선택: 제거 후보 제외 → 배율 1 통과가 하나라도 있으면 고조파 통과는 비교 집합에서 뺀다 → 통과
     * 후보가 0개면 not_matched, 1개면 matched·matched_harmonic, 여럿이면 v0 우세 규칙으로 고르고 우세가 없으면
     * ambiguous_match다. 같은 후보의 여러 해석은 점수가 가장 낮은 하나로 센다.
     *
     * <p>판단(userJudgment)과 무관하다. 판단 오답은 성과 판정(5.3절)이 따로 본다.
     */
    public static Match match(Observation observation, Rules rules, Selection selection, Derived derived,
                              List<Candidate> candidates, Collection<Long> removedCandidateIds) {
        List<Candidate> compared = candidates.stream()
                .filter(c -> !removedCandidateIds.contains(c.id()))
                .sorted(Comparator.comparingLong(Candidate::id))
                .toList();
        List<Evaluation> evaluations = new ArrayList<>();
        for (Candidate candidate : compared) {
            for (double multiplier : rules.harmonicMultipliers()) {
                evaluations.add(evaluate(observation, rules, selection.periodDays(), derived, candidate, multiplier));
            }
        }
        List<Evaluation> passers = evaluations.stream().filter(Evaluation::pass).toList();
        List<Evaluation> direct = passers.stream().filter(e -> e.multiplier() == 1).toList();
        List<Evaluation> pool = direct.isEmpty() ? passers : direct;

        Map<Long, Evaluation> perCandidate = new LinkedHashMap<>();
        for (Evaluation evaluation : pool) {
            Evaluation current = perCandidate.get(evaluation.candidateId());
            if (current == null || evaluation.score() < current.score() - EPSILON) {
                perCandidate.put(evaluation.candidateId(), evaluation);
            }
        }
        List<Evaluation> ranked = perCandidate.values().stream()
                .sorted(Comparator.comparingDouble(Evaluation::score).thenComparingLong(Evaluation::candidateId))
                .toList();
        List<Long> rankedIds = ranked.stream().map(Evaluation::candidateId).toList();

        if (ranked.isEmpty()) {
            return new Match(MatchStatus.NOT_MATCHED, null, null, null, "no candidate passed all four conditions",
                    rankedIds, null, evaluations);
        }
        if (ranked.size() == 1) {
            return adopted(ranked.get(0), "single passer", rankedIds, null, evaluations);
        }
        Evaluation first = ranked.get(0);
        Evaluation second = ranked.get(1);
        boolean gapOk = (second.score() - first.score()) >= rules.minScoreGap();
        boolean ratioOk = first.score() <= rules.dominanceRatio() * second.score();
        boolean overlapOk = first.overlapRatio() >= second.overlapRatio() - rules.overlapRatioTolerance();
        boolean tie = Math.abs(first.score() - second.score()) <= EPSILON;
        Dominance dominance = new Dominance(first.score(), second.score(), first.overlapRatio(),
                second.overlapRatio(), gapOk, ratioOk, overlapOk, tie);
        String decision = tie ? "tie (|s1−s2| ≤ epsilon)"
                : !gapOk ? "score gap below minScoreGap"
                : !ratioOk ? "ratio above dominanceRatio"
                : !overlapOk ? "leader clearly worse in overlap"
                : "dominant";
        if (tie || !gapOk || !ratioOk || !overlapOk) {
            return new Match(MatchStatus.AMBIGUOUS_MATCH, null, null, null, decision, rankedIds, dominance,
                    evaluations);
        }
        return adopted(first, decision, rankedIds, dominance, evaluations);
    }

    /** 일치 후보에 이 회원의 성과가 이미 있으면 duplicate다(6.3절 3단계). 후보·정정값은 그대로 남긴다. */
    public static Match markDuplicate(Match match, Set<Long> recognizedCandidateIds) {
        boolean matched = match.status() == MatchStatus.MATCHED || match.status() == MatchStatus.MATCHED_HARMONIC;
        if (!matched || !recognizedCandidateIds.contains(match.candidateId())) {
            return match;
        }
        return new Match(MatchStatus.DUPLICATE, match.candidateId(), match.harmonicMultiplier(),
                match.correctedPeriodDays(), match.decision(), match.rankedCandidateIds(), match.dominance(),
                match.evaluations());
    }

    /** 폭만 벗어난 불일치의 힌트. DB에 저장하지 않고 제출 응답 {@code match.missHint}로만 나간다. */
    public enum MissHint { WINDOW_TOO_WIDE, WINDOW_TOO_NARROW }

    /**
     * {@code not_matched}에서 주기·epoch·통과 겹침은 통과하고 지속시간 비율만 벗어난 해석이 있으면 폭 힌트를
     * 준다 [S15P21C206-282]. 그런 해석이 여럿이면 점수가 가장 낮은 것을 따른다. 그 밖의 불일치는 null이라
     * 주기·위치의 정오를 알리지 않는다. 판정(규칙 v0)에는 쓰지 않으므로 참조 구현과 대조하지 않는다.
     */
    public static MissHint missHint(Match match, Rules rules) {
        if (match.status() != MatchStatus.NOT_MATCHED) {
            return null;
        }
        return match.evaluations().stream()
                .filter(e -> e.ePeriod() <= 1 && e.eEpoch() <= 1 && e.overlapTransits() >= rules.minOverlapTransits()
                        && !e.durationPass())
                .min(Comparator.comparingDouble(Evaluation::score))
                .map(e -> e.durationRatio() > rules.durationRatioMax() ? MissHint.WINDOW_TOO_WIDE : MissHint.WINDOW_TOO_NARROW)
                .orElse(null);
    }

    private static Match adopted(Evaluation evaluation, String decision, List<Long> rankedIds, Dominance dominance,
                                 List<Evaluation> evaluations) {
        MatchStatus status = evaluation.multiplier() == 1 ? MatchStatus.MATCHED : MatchStatus.MATCHED_HARMONIC;
        return new Match(status, evaluation.candidateId(), evaluation.multiplier(),
                evaluation.correctedPeriodDays(), decision, rankedIds, dominance, evaluations);
    }

    /** SRS 5.1 네 조건: 주기 누적 오차, 순환 epoch, 지속시간 비율, 통과 창 중첩. 모두 만족해야 통과다. */
    private static Evaluation evaluate(Observation observation, Rules rules, double userPeriod, Derived derived,
                                       Candidate candidate, double multiplier) {
        double corrected = userPeriod * multiplier;
        double candidatePeriod = candidate.periodDays();
        double candidateDuration = candidate.durationHours() / HOURS_PER_DAY;
        double userDuration = derived.durationDays();
        // 허용 반폭은 후보 지속시간의 절반이되 최소 허용 창의 절반보다 좁히지 않는다.
        double halfWidth = Math.max(candidateDuration / 2, rules.minWindowDays() / 2);

        List<Double> transits = candidateTransits(observation, candidate, candidateDuration);
        int observed = transits.size();
        // 상한은 주기 누적 오차의 N에만 건다(SRS 5.1 주기 조건, DEC-03). 중첩은 관측된 통과 전체로 센다.
        int n = rules.nTransitsCap() == null ? observed : Math.min(observed, rules.nTransitsCap());
        double ePeriod = Math.abs(corrected - candidatePeriod) * n / halfWidth;

        // 절반 주기 alias에서는 사용자가 고른 통과가 후보의 홀수 번째일 수 있어 짧은 주기로 순환한다.
        double modulus = Math.min(userPeriod, candidatePeriod);
        double offset = derived.epochBtjd() - candidate.epochBtjd();
        long nearest = Math.round(offset / modulus);
        double epochDiff = Math.min(Math.abs(offset - (nearest - 1) * modulus),
                Math.min(Math.abs(offset - nearest * modulus), Math.abs(offset - (nearest + 1) * modulus)));
        double eEpoch = epochDiff / halfWidth;

        double ratio = userDuration / candidateDuration;
        boolean durationPass = ratio >= rules.durationRatioMin() && ratio <= rules.durationRatioMax();
        double eDuration = Math.abs(log2(ratio));

        // 후보 통과마다 사용자 창과 겹치는 관측 구간이 있는지. 사용자 창은 사용자가 고른 주기로 반복한다.
        int overlapTransits = 0;
        for (double center : transits) {
            long userTransit = Math.round((center - derived.epochBtjd()) / userPeriod);
            double userCenter = derived.epochBtjd() + userTransit * userPeriod;
            double lo = Math.max(center - candidateDuration / 2, userCenter - userDuration / 2);
            double hi = Math.min(center + candidateDuration / 2, userCenter + userDuration / 2);
            if (lo <= hi && hasData(observation, lo, hi)) {
                overlapTransits++;
            }
        }
        boolean overlapPass = overlapTransits >= rules.minOverlapTransits();
        boolean pass = ePeriod <= 1 && eEpoch <= 1 && durationPass && overlapPass;
        return new Evaluation(candidate.id(), multiplier, corrected, n, observed, ePeriod, eEpoch, eDuration, ratio,
                durationPass, overlapTransits, observed == 0 ? 0 : (double) overlapTransits / observed, pass,
                Math.max(ePeriod, Math.max(eEpoch, eDuration)));
    }

    /** 후보 통과 중 창 {@code [중심 ± D_c/2]}에 관측 데이터가 있는 것의 중심 시각. 공백에만 걸린 통과는 뺀다. */
    private static List<Double> candidateTransits(Observation observation, Candidate candidate,
                                                  double candidateDuration) {
        long nLo = (long) Math.floor((observation.observationStartBtjd() - candidate.epochBtjd())
                / candidate.periodDays()) - 1;
        long nHi = (long) Math.ceil((observation.observationEndBtjd() - candidate.epochBtjd())
                / candidate.periodDays()) + 1;
        List<Double> centers = new ArrayList<>();
        for (long n = nLo; n <= nHi; n++) {
            double center = candidate.epochBtjd() + n * candidate.periodDays();
            if (hasData(observation, center - candidateDuration / 2, center + candidateDuration / 2)) {
                centers.add(center);
            }
        }
        return centers;
    }

    private static boolean hasData(Observation observation, double from, double to) {
        for (ObservedWindow window : observation.windows()) {
            if (Math.max(from, window.startBtjd()) <= Math.min(to, window.endBtjd())) {
                return true;
            }
        }
        return false;
    }

    private static double mod1(double x) {
        return ((x % 1) + 1) % 1;
    }

    /** 2의 거듭제곱에서 정확한 log2. 지속시간 비율 경계(0.5·2)가 언어 사이에서 흔들리지 않게 한다. */
    static double log2(double x) {
        int exponent = Math.getExponent(x);
        return exponent + Math.log(x / Math.scalb(1.0, exponent)) / Math.log(2.0);
    }
}
