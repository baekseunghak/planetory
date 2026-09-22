package com.planetory.backend.domain.gold;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Gold 카탈로그(B 묶음) 읽기 전용 조회 결과.
 *
 * <p>배치가 적재한 데이터를 서비스가 읽기만 하는 모델이므로 수정자를 두지 않는다. 쓰기는
 * 배치 역할({@code planetory_gold_writer})이 담당하고 앱 역할은 DB 권한 자체가 없다(V2).
 */
public final class GoldCatalogViews {

    private GoldCatalogViews() {
    }

    /** 한 별의 공개 데이터 판. 같은 별에 {@code current}는 하나뿐이다. */
    public record Bundle(
            long id,
            long ticId,
            String bundleVersion,
            Status status,
            GoldManifest manifest,
            /** 위상 접기 기준 시각. 판 공통값이며 세그먼트별로 다시 산정하지 않는다(C02-R2). */
            double foldReferenceTimeBtjd,
            BigDecimal baseDays,
            OffsetDateTime publishedAt) {

        public enum Status {
            /** 전송·검증 중. 공개하지 않는다. */
            STAGING,
            /** 현재 공개 중인 판. */
            CURRENT,
            /** 교체된 판. */
            ARCHIVED
        }
    }

    /**
     * 별·섹터 단위 곡선. revision이 같으면 판 사이에 공유하므로 판마다 복제하지 않는다.
     *
     * <p>시각 배열은 저장하지 않는다. i번째 점의 시각은
     * {@code startBtjd + (binMinutes / 1440.0) * (i + 0.5)}인 bin 중심에서 계산한다(BTJD는 일 단위).
     */
    public record LightCurveSegment(
            long id,
            long ticId,
            short sector,
            String binningRevision,
            double startBtjd,
            BigDecimal binMinutes,
            int nPoints,
            /** 정규화 밝기. 결측은 null이며 길이는 {@code nPoints}와 같다. */
            Float[] flux,
            /** 유한 비닝 flux 전체의 1.4826 × MAD. 통과·별 변동을 포함하며 점별 측정 오차나 가중치가 아니다. */
            BigDecimal fluxScatter,
            /** 빈 구간 인덱스. */
            JsonNode gaps) {
    }

    /**
     * 판별 주기도. current 판 것만 유지하므로 별당 한 행이다.
     *
     * <p>주기 격자 배열은 저장하지 않는다. {@code periodMinDays}·{@code periodMaxDays}·
     * {@code nPeriods}와 manifest의 간격 규칙으로 i번째 주기를 계산한다.
     */
    public record Periodogram(
            long bundleId,
            BigDecimal periodMinDays,
            BigDecimal periodMaxDays,
            int nPeriods,
            Float[] power) {
    }

    /**
     * 후보 신호. id는 별에 고정된 식별자이며 판이 바뀌어도 유지된다.
     * 판이 바뀌면 값을 갱신하거나 {@code retired}로 바꾸고 옛 값은 변경 이력에 남긴다.
     */
    public record Candidate(
            long id,
            long ticId,
            Status status,
            long updatedBundleId,
            short removalStep,
            BigDecimal periodDays,
            BigDecimal epochBtjd,
            BigDecimal durationHours,
            BigDecimal depthPpm,
            BigDecimal blsPower,
            /** 고정 통과 모델 파라미터. 값 규약은 D06이 확정한다. */
            JsonNode transitModel,
            /** 제공 해상도에서 찾을 수 있는 신호인지. 판정 기준은 D07-2가 확정한다. */
            boolean discoverable,
            boolean confirmed) {

        public enum Status {
            ACTIVE,
            RETIRED
        }
    }
}
