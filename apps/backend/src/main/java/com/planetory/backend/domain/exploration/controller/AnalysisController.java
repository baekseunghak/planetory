package com.planetory.backend.domain.exploration.controller;

import java.util.List;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.planetory.backend.domain.exploration.service.AnalysisService;
import com.planetory.backend.domain.exploration.service.AnalysisViews.AnalysisContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Curve;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveQuery;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Periodogram;
import com.planetory.backend.global.security.MemberPrincipal;

/** 분석 화면의 진입·곡선·주기도 (탐사 API 5.1·5.2·5.3) [S15P21C206-140]. */
@RestController
@RequiredArgsConstructor
public class AnalysisController {

    /** 현재 판 헤더(D-5). 프론트는 분석 진입 때 받은 bundleId와 다르면 5.1절을 다시 부른다. */
    public static final String CURRENT_BUNDLE_HEADER = "X-Current-Bundle";

    private final AnalysisService analysis;

    @Operation(summary = "분석 진입",
            description = "현재 판·선택 규칙·진행과 복귀·다음 곡선 문맥을 준다. 조회는 잔차 작업을 만들지 않는다."
                    + " 마지막 제출의 제거 조합에 은퇴 후보가 있으면 현재 진행 문맥으로 바꾸고"
                    + " currentCurveContext.notice=STEP_NOT_RESTORABLE.")
    @GetMapping("/api/v1/stars/{ticId}/analysis-context")
    public ResponseEntity<AnalysisContext> context(@AuthenticationPrincipal MemberPrincipal principal,
                                                   @PathVariable long ticId) {
        return respond(analysis.context(principal.memberId(), ticId));
    }

    @Operation(summary = "곡선",
            description = "원본(curveStep=0)과 잔차 단계가 같은 세그먼트 형식이다. removed는 c-<id>를 쉼표로"
                    + " 잇거나 반복한다. 잔차가 준비되지 않았으면 202와 segments=null."
                    + " 판·계산 버전이 현재 판과 다르면 409 BUNDLE_CHANGED(currentBundleId).")
    @GetMapping("/api/v1/stars/{ticId}/curves")
    public ResponseEntity<Curve> curves(@AuthenticationPrincipal MemberPrincipal principal,
                                        @PathVariable long ticId,
                                        @RequestParam(required = false) String bundleId,
                                        @RequestParam(required = false) String curveStep,
                                        @RequestParam(required = false) List<String> removed,
                                        @RequestParam(required = false) String residualModelVersion,
                                        @RequestParam(required = false) String periodogramConfigVersion) {
        return respond(analysis.curve(principal.memberId(), ticId,
                new CurveQuery(bundleId, curveStep, removed, residualModelVersion, periodogramConfigVersion)));
    }

    @Operation(summary = "주기도",
            description = "격자 배열 없이 범위·점 수·간격 규칙과 power만 준다. 요청 규칙과 202·409는 곡선과 같다.")
    @GetMapping("/api/v1/stars/{ticId}/periodogram")
    public ResponseEntity<Periodogram> periodogram(@AuthenticationPrincipal MemberPrincipal principal,
                                                   @PathVariable long ticId,
                                                   @RequestParam(required = false) String bundleId,
                                                   @RequestParam(required = false) String curveStep,
                                                   @RequestParam(required = false) List<String> removed,
                                                   @RequestParam(required = false) String residualModelVersion,
                                                   @RequestParam(required = false) String periodogramConfigVersion) {
        return respond(analysis.periodogram(principal.memberId(), ticId,
                new CurveQuery(bundleId, curveStep, removed, residualModelVersion, periodogramConfigVersion)));
    }

    private static <T> ResponseEntity<T> respond(Answer<T> answer) {
        return ResponseEntity.status(answer.ready() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .header(CURRENT_BUNDLE_HEADER, answer.currentBundleId())
                .body(answer.body());
    }
}
