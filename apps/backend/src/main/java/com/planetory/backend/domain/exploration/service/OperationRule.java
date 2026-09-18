package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 운영 규칙 한 버전 (OPS-04·08, {@code operation_settings}) [S15P21C206-151].
 *
 * <p>값이 형식 1에 맞는지는 DB가 저장할 때 검사한다(V9 {@code operation_rules_valid}). 여기서는 타입으로
 * 읽기만 한다. 각 값의 뜻과 적용 절차는 {@code docs/operations/operation-rule-runbook.md}가 정본이다.
 *
 * <p>제출은 판정에 쓴 {@code ruleVersion}을 저장한다. 과거 제출을 되살릴 때는 현재 규칙이 아니라 그 버전을 읽는다.
 */
public record OperationRule(String ruleVersion, OffsetDateTime appliedAt, Selection selection,
                            Matching matching, Peaks peaks, Discovery discovery, Tutorial tutorial, Ai ai) {

    /**
     * 위상 선택 (탐사 API 5.1 {@code selectionRules}, 6.2). 최소 창은 요구사항이 케이던스의 2배로
     * 정해 별마다 계산하므로 여기 없다. 미세 조정 폭은 판 manifest에 있다(OPS-04).
     */
    public record Selection(double phaseWidthMax, double maxDurationMultipleOfSuggested,
                            boolean allowEmptyPhaseSpan) {
    }

    /** 제출 매칭 (SRS 5.1·5.2). {@code nTransitsCap}이 null이면 관측 통과 수에 상한이 없다. */
    public record Matching(List<Double> harmonicMultipliers, Integer nTransitsCap, double durationRatioMin,
                           double durationRatioMax, int minOverlapTransits, double dominanceRatio,
                           double minScoreGap, double overlapRatioTolerance) {
    }

    /** 봉우리 (탐사 API 5.4). */
    public record Peaks(int topN) {
    }

    /** 성과 한 건당 발견 (OPS-08, 탐사 API 9.2). */
    public record Discovery(int starsPerAchievement, String seedPolicy) {
    }

    /** 튜토리얼 건너뛰기 (SUB-12). 0이면 끈다. */
    public record Tutorial(int skipAfter) {

        public boolean skipEnabled() {
            return skipAfter > 0;
        }
    }

    /** AI 판정 하한·상한 (AI-04). 실측으로 정하기 전에는 둘 다 null이다. */
    public record Ai(Double lowerThreshold, Double upperThreshold) {
    }
}
