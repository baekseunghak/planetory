package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;

/** 267 후보별 설명 내용과 내부 조회 결과. */
public final class NasaPlanetExplanation {

    private NasaPlanetExplanation() {
    }

    public record Content(String name, String orbitalPeriod, String radius,
                          String mass, String discovery) {
    }

    public record Lookup(String status, NasaPlanetInfo.Lookup source, Content content,
                         OffsetDateTime generatedAt, String model, String promptVersion,
                         OffsetDateTime retryAt, String failure) {
    }
}
