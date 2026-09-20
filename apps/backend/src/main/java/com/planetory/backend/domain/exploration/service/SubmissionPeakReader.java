package com.planetory.backend.domain.exploration.service;

import java.util.Map;

/** 141의 실제 봉우리 제공 연결점. 미등록은 503이며 빈 목록(봉우리 없음)과 구분한다. */
@FunctionalInterface
public interface SubmissionPeakReader {
    Map<Integer, SubmissionMatching.Peak> read(AnalysisViews.CurveContext context, String ruleVersion);
}
