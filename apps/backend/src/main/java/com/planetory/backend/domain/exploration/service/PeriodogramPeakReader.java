package com.planetory.backend.domain.exploration.service;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 제출 검증이 쓰는 봉우리 제공자 (탐사 API 5.4·6.2절) [S15P21C206-141].
 *
 * <p>화면이 5.4절에서 본 목록과 <b>같은 규칙·같은 주기도</b>에서 다시 뽑는다. 두 경로가 갈라지면
 * 화면에 보인 봉우리를 골랐는데 서버가 모르는 봉우리라고 거절한다.
 *
 * <p>이 빈이 없던 동안 {@code sourcePeakGridIndex}가 있는 제출은 503이었다
 * ({@link SubmissionPeakReader}). 등록되었으므로 그 경로가 열린다.
 */
@Component
@RequiredArgsConstructor
public class PeriodogramPeakReader implements SubmissionPeakReader {

    private final AnalysisService analysis;

    @Override
    public Map<Integer, SubmissionMatching.Peak> read(AnalysisViews.CurveContext context, String ruleVersion) {
        return analysis.peaksFor(context, ruleVersion);
    }
}
