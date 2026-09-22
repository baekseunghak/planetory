package com.planetory.backend.domain.statistics.dto;

import java.math.BigDecimal;
import java.math.MathContext;
import java.time.ZoneId;

/** 개인 조회와 전체 집계가 공유하는 통계 값 계약. */
public final class StatisticsDtos {
    private StatisticsDtos() {}
    public static final String POLICY_VERSION = "2026-09-22";
    public static final ZoneId ZONE = ZoneId.of("Asia/Seoul");
    public enum BlockStatus { READY, STALE, UNAVAILABLE }
    public enum MetricStatus { AVAILABLE, NO_SAMPLE, UNAVAILABLE, NOT_APPLICABLE }
    public record Metric(String unit, BigDecimal value, Long numerator, Long denominator,
                         MetricStatus status, String reason) {
        public static Metric count(String unit, long value) {
            return new Metric(unit, BigDecimal.valueOf(value), value, null, MetricStatus.AVAILABLE, null);
        }
        public static Metric ratio(String unit, long numerator, long denominator) {
            return new Metric(unit, denominator == 0 ? null : BigDecimal.valueOf(numerator)
                    .multiply(BigDecimal.valueOf("PERCENT".equals(unit) ? 100 : 1))
                    .divide(BigDecimal.valueOf(denominator), MathContext.DECIMAL128), numerator, denominator,
                    denominator == 0 ? MetricStatus.NO_SAMPLE : MetricStatus.AVAILABLE,
                    denominator == 0 ? "ZERO_DENOMINATOR" : null);
        }
        public static Metric unavailable(String unit, String reason) {
            return new Metric(unit, null, null, null, MetricStatus.UNAVAILABLE, reason);
        }
    }
}
