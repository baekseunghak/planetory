package com.planetory.backend.domain.exploration.service;

import java.util.List;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;

/** 온라인 잔차 작업 요청·조회 (탐사 API 7.1·7.2절) [S15P21C206-147]. */
public final class ResidualJobViews {

    private ResidualJobViews() {
    }

    /** 7.1 요청 본문. 요청 ID는 없다. 같은 목표를 다시 보내는 것이 곧 복구다. */
    public record JobRequest(TargetRequest target) {
    }

    /** 계산할 곡선 문맥. 곡선 조회(5.2절) 쿼리와 같은 값이며 같은 검증을 받는다. */
    public record TargetRequest(String bundleId, List<String> removedCandidateIds,
                                String residualModelVersion, String periodogramConfigVersion) {
    }

    /**
     * 7.1 응답. 캐시면 200, 작업이면 202다.
     *
     * @param jobId             캐시 히트에는 없다
     * @param resultCurveContext 캐시 히트에만 있다. 이 문맥으로 5.2·5.3절을 조회한다
     * @param queuePosition     0이면 계산 중이고 N이면 앞에 N개가 기다린다
     * @param estimatedSeconds  예상 시간. 실측 전에는 null이며 0으로 채우지 않는다
     */
    public record JobAccepted(String jobId, String status, boolean cacheHit, CurveContext resultCurveContext,
                              Integer queuePosition, Integer estimatedSeconds, Integer pollAfterSeconds) {
    }

    /**
     * 7.2 응답. 필드 이름은 저장소 기록과 같다. 둘 다 명세 2.4·7.2절을 따르기 때문이다.
     *
     * @param resultCurveContext {@code COMPLETED}에만 있다
     */
    public record JobStatus(String jobId, String ticId, CurveContext target, String status, int attempt,
                            ResidualJobStore.Timeline timeline, ResidualJobStore.Failure failure,
                            CurveContext resultCurveContext, int pollAfterSeconds) {
    }
}
