package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.time.OffsetDateTime;

/** NASA PS의 단일 기본 해. 모든 수치는 원 단위와 부호 있는 오차를 유지한다. */
public final class NasaPlanetInfo {

    private NasaPlanetInfo() {
    }

    /** limit: 0=측정값, -1=상한, 1=하한. null은 원천 미제공이다. */
    public record Measurement(BigDecimal value, BigDecimal errorPlus, BigDecimal errorMinus,
                              Integer limit, String unit, String reference) {
    }

    /** massEarth는 실제 질량 pl_masse이며 최소질량 pl_msinie와 혼합하지 않는다. */
    public record Planet(String sourceTable, String planetName, String hostName, String ticId,
                         String solutionType, Boolean controversial,
                         Measurement periodDays, Measurement radiusEarth, Measurement massEarth,
                         String discoveryMethod, Integer discoveryYear, String discoveryReference) {
    }

    /** status는 자료 상태, refreshStatus는 마지막 재확인 결과다. */
    public record Lookup(String status, Planet planet, OffsetDateTime fetchedAt,
                         OffsetDateTime changedAt, String sourceHash, String refreshStatus,
                         Short sourceVersion) {
    }
}
