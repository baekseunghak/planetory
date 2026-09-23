package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.Map;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;

/**
 * 잔차 단계 곡선·주기도의 계산 결과와 작업 상태를 읽는다 (탐사 API 5.2·5.3·7장) [S15P21C206-140].
 *
 * <p>조회는 작업을 만들지 않는다(D-14). 실제 구현은 온라인 잔차 작업(S15P21C206-147)이 캐시와
 * 작업 상태로 제공한다. 그전까지는 {@link NoResidualResultReader}가 "결과도 작업도 없음"을 돌려준다.
 *
 * <p>원본(step 0)에는 부르지 않는다. 원본은 DB 행이 곧 결과다.
 */
public interface ResidualResultReader {

    Lookup lookup(long ticId, CurveContext context);

    /**
     * 한 곡선 문맥의 잔차 상태.
     *
     * @param status 2.4절 상태. 결과도 작업도 없으면 null이다(D-14)
     * @param jobId 실제 작업이 있을 때만 값이 있다
     * @param computedAt 결과가 만들어진 시각. 결과가 없으면 null
     * @param segmentFlux {@code COMPLETED}일 때 세그먼트 id별 잔차 flux. 원본과 점 수·인덱스가 같다
     * @param power {@code COMPLETED}일 때 잔차 주기도. 원본 주기도와 같은 격자다
     */
    record Lookup(String status, String jobId, OffsetDateTime computedAt,
                  Map<Long, Float[]> segmentFlux, Float[] power) {

        public static final String COMPLETED = "COMPLETED";

        public static Lookup none() {
            return new Lookup(null, null, null, Map.of(), null);
        }

        public boolean completed() {
            return COMPLETED.equals(status);
        }
    }
}
