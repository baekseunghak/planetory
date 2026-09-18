package com.planetory.backend.domain.exploration.service;

import org.springframework.stereotype.Component;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;

/**
 * 온라인 잔차 작업이 아직 없을 때의 읽기. 모든 잔차 단계를 "결과도 작업도 없음"으로 본다(D-14).
 *
 * <p>가짜 {@code QUEUED}·{@code jobId}를 만들지 않아 프론트가 폴링하지 않는다. 캐시·작업 상태를
 * 읽는 실제 구현은 S15P21C206-147이 이 클래스를 대신한다 [S15P21C206-140].
 */
@Component
class NoResidualResultReader implements ResidualResultReader {

    @Override
    public Lookup lookup(CurveContext context) {
        return Lookup.none();
    }
}
