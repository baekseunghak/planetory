package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 분석 데이터 조회의 요청·응답 (탐사 API 2.1·5.1·5.2·5.3) [S15P21C206-140].
 */
public final class AnalysisViews {

    private AnalysisViews() {
    }

    /** 분석 진입 (5.1절). 화면이 판·단계·규칙을 한 번에 맞추는 기준이다. */
    public record AnalysisContext(String ticId, StarSummary star, boolean hasConfirmedCandidate,
                                  BundleSummary bundle, SelectionRules selectionRules, ProgressSummary progress,
                                  CurrentCurveContext currentCurveContext, Residual residualForCurrentStep,
                                  CurveContext nextCurveContext, Residual residualForNextStep,
                                  TutorialState tutorial, String ruleVersion) {
    }

    /** 별 상세(4.2절)와 같은 값이다. */
    public record StarSummary(int sectorCount, List<Integer> sectors, Double tmag) {
    }

    /**
     * 현재 판.
     *
     * @param observationBounds {@code [세그먼트 시작의 최솟값, 세그먼트 마지막 bin 끝의 최댓값]}
     * @param curveStepRule     곡선 단계 규칙. 한 단계가 매칭한 후보 하나를 더 제거한다
     */
    public record BundleSummary(String bundleId, String bundleVersion, OffsetDateTime publishedAt,
                                double foldReferenceTimeBtjd, BigDecimal baseDays, double[] observationBounds,
                                String residualModelVersion, String periodogramConfigVersion,
                                String binningRevision, String curveStepRule) {
    }

    /**
     * 위상 선택 규칙. {@code version}은 운영 규칙 버전이고, {@code minWindowDays}는 판 세그먼트의
     * bin 크기, {@code fineTune}은 판 manifest에서 온다.
     */
    public record SelectionRules(String version, double minWindowDays, double phaseWidthMax,
                                 double maxDurationMultipleOfSuggested, boolean allowEmptyPhaseSpan,
                                 FineTune fineTune) {
    }

    public record FineTune(int halfWidthCells) {
    }

    /** 회원의 이 별 진행. 분석을 시작하지 않았으면 {@code unexplored}·0단계다. */
    public record ProgressSummary(String stage, int currentCurveStep, List<String> matchedCandidateIds,
                                  String completionReason, boolean reopenPending, int achievementCount,
                                  String grade) {
    }

    /**
     * 분석 복귀 문맥. 곡선 문맥과 같은 모양에 안내를 더한다.
     *
     * <p>마지막 제출의 제거 조합에 은퇴 후보가 있으면 현재 진행 문맥으로 바꾸고
     * {@code notice}를 {@code STEP_NOT_RESTORABLE}로 둔다(C02-R1). 바꾸지 않았으면 필드를 뺀다.
     */
    public record CurrentCurveContext(String bundleId, int curveStep, List<String> removedCandidateIds,
                                      String residualModelVersion, String periodogramConfigVersion,
                                      @JsonInclude(JsonInclude.Include.NON_NULL) String notice) {

        public static final String STEP_NOT_RESTORABLE = "STEP_NOT_RESTORABLE";

        static CurrentCurveContext of(CurveContext context, String notice) {
            return new CurrentCurveContext(context.bundleId(), context.curveStep(), context.removedCandidateIds(),
                    context.residualModelVersion(), context.periodogramConfigVersion(), notice);
        }
    }

    /** 튜토리얼 별이면 순번, 아니면 null. */
    public record TutorialState(Integer seq, boolean skipAvailable) {
    }

    /**
     * 요청 쿼리 원문. 형식은 서비스가 검사한다. 숫자·ID를 바로 타입으로 받으면 변환 실패가
     * 400이 아니라 500으로 나간다.
     */
    public record CurveQuery(String bundleId, String curveStep, List<String> removed,
                             String residualModelVersion, String periodogramConfigVersion) {
    }

    /**
     * 곡선 문맥 (2.1절). 요청과 응답이 같은 모양이다.
     *
     * <p>{@code removedCandidateIds}는 id 숫자 오름차순이다. 문자열로 정렬하면 {@code c-10}이
     * {@code c-9}보다 앞에 와 같은 조합이 다른 캐시 키가 된다(S15P21C206-70).
     */
    public record CurveContext(String bundleId, int curveStep, List<String> removedCandidateIds,
                               String residualModelVersion, String periodogramConfigVersion) {
    }

    /**
     * 잔차 상태 (2.4절). 결과도 작업도 없으면 {@code status}·{@code jobId}가 모두 null이다(D-14).
     * 두 필드는 null이어도 빼지 않는다. 빠지면 "미계산"과 "필드 누락"을 구분할 수 없다.
     */
    public record Residual(String status, String jobId,
                           @JsonInclude(JsonInclude.Include.NON_NULL) OffsetDateTime computedAt) {

        /** 원본 단계는 계산할 것이 없으므로 항상 완료다. */
        static final Residual ORIGINAL =
                new Residual(ResidualResultReader.Lookup.COMPLETED, null, null);
    }

    /** 곡선 (5.2절). 잔차가 준비되지 않았으면 {@code segments}가 null이고 202로 나간다. */
    public record Curve(String ticId, String bundleId, double foldReferenceTimeBtjd,
                        CurveContext curveContext, Residual residual, String fluxUnit,
                        List<Segment> segments) {
    }

    /**
     * 세그먼트. i번째 점의 시각은 {@code startBtjd + binMinutes / 1440 × i}이며 시각 배열은
     * 보내지 않는다. {@code gaps}는 빈 bin의 {@code [시작, 끝]} 폐구간이다.
     */
    public record Segment(String segmentId, int sector, String binningRevision, double startBtjd,
                          BigDecimal binMinutes, int nPoints, Float[] flux, BigDecimal fluxScatter,
                          List<int[]> gaps) {
    }

    /**
     * 주기도 (5.3절). 격자 배열은 보내지 않는다. i번째 주기 =
     * {@code periodMinDays × (periodMaxDays / periodMinDays)^(i / (nPeriods − 1))}.
     * 잔차가 준비되지 않았으면 {@code power}가 null이고 202로 나간다.
     */
    public record Periodogram(String bundleId, CurveContext curveContext, Residual residual,
                              BigDecimal periodMinDays, BigDecimal periodMaxDays, int nPeriods,
                              String gridRule, BigDecimal baselineHalfDays, Float[] power) {
    }

    /** 서비스 결과. 컨트롤러가 준비 여부로 200·202를, 현재 판으로 {@code X-Current-Bundle}을 정한다. */
    public record Answer<T>(T body, boolean ready, String currentBundleId) {
    }
}
