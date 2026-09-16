package com.planetory.backend.domain.gold;

import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * {@code publication_bundles.manifest}의 최소 스키마.
 *
 * <p>여덟 항목의 존재와 자료형은 마이그레이션 V3의 CHECK가 보장한다. 값의 범위와 단위는
 * 과학 계약(D06·D20)이 확정한 뒤 {@code operation_settings}의 rule_version이 관리하므로
 * 여기서는 규칙을 해석하지 않고 그대로 전달한다.
 *
 * <p>키는 snake_case다. manifest는 배치가 쓰고 백엔드가 읽는 DB 내부 데이터이며 API로 그대로
 * 나가지 않는다.
 */
public record GoldManifest(
        /** 이 판이 참조하는 light_curve_segments id 집합. 섹터가 아니라 revision까지 특정한다. */
        @JsonProperty("segment_ids") List<Long> segmentIds,
        /** flux·power 배열 checksum. */
        @JsonProperty("array_checksums") Map<String, String> arrayChecksums,
        @JsonProperty("residual_model_version") String residualModelVersion,
        @JsonProperty("periodogram_config_version") String periodogramConfigVersion,
        /** 곡선 비닝 규칙(기본 10분). */
        @JsonProperty("binning") JsonNode binning,
        /** 주기 격자 범위·간격 규칙. 주기 배열을 저장하지 않고 이 규칙으로 계산한다. */
        @JsonProperty("period_grid") JsonNode periodGrid,
        /** 미세 조정 허용 폭(ERD 결정 9). 봉우리별 fineTune 범위를 이 규칙으로 계산한다. */
        @JsonProperty("fine_tune") JsonNode fineTune,
        /** 곡선 단계 규칙. */
        @JsonProperty("curve_steps") JsonNode curveSteps) {
}
