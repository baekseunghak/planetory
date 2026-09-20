package com.planetory.backend.domain.exploration.service;

import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;

/**
 * 잔차 결과·작업 상태 읽기 (탐사 API 5.1·5.2·5.3절) [S15P21C206-147].
 *
 * <p>저장소에 결과가 있으면 그 결과를, 계산 중이면 그 작업 상태를 준다. 둘 다 없으면 "결과도 작업도
 * 없음"이며 {@code status}·{@code jobId}가 모두 null이다(D-14). <b>조회는 작업을 만들지 않는다.</b>
 * 가짜 {@code QUEUED}를 만들면 화면이 오지 않을 결과를 기다린다.
 */
@Component
@RequiredArgsConstructor
class StoredResidualResultReader implements ResidualResultReader {

    private final ResidualJobStore store;

    @Override
    public Lookup lookup(long ticId, CurveContext context) {
        String cacheKey = ResidualJobStore.cacheKey(ticId, context);
        Optional<ResidualJobStore.Result> result = store.result(cacheKey);
        if (result.isPresent()) {
            ResidualJobStore.Result value = result.get();
            // 결과가 있으면 작업 상태를 보지 않는다. 뒤에 실패한 재시도가 있어도 이미 쓸 수 있는
            // 결과가 있고, 곡선 조회는 그 결과를 그려야 한다.
            return new Lookup(Lookup.COMPLETED, null, value.computedAt(), value.segmentFlux(), value.power());
        }
        return store.active(cacheKey)
                .map(job -> new Lookup(job.status(), job.jobId(), null, java.util.Map.of(), null))
                .orElseGet(Lookup::none);
    }
}
