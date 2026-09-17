package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 분석 데이터 조회의 요청·응답 (탐사 API 2.1·5.2·5.3) [S15P21C206-140].
 */
public final class AnalysisViews {

    private AnalysisViews() {
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
