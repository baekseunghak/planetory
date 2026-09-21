package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.ResidualJobService;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobAccepted;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobRequest;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobStatus;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 온라인 잔차 작업 (탐사 API 7.1·7.2) [S15P21C206-147].
 *
 * <p>경로 값을 문자열로 받아 여기서 판별한다(S15P21C206-246).
 */
@RestController
@RequiredArgsConstructor
public class ResidualJobController {

    private final ResidualJobService jobs;

    @Operation(summary = "잔차 계산 요청",
            description = "캐시가 있으면 200 cacheHit, 새 작업이나 진행 중 작업은 202다."
                    + " 대기열이 차면 429 RESIDUAL_QUEUE_FULL, 판이 바뀌었으면 409 BUNDLE_CHANGED."
                    + " 요청 ID가 없으므로 응답을 잃으면 같은 target으로 다시 부른다.")
    @PostMapping("/api/v1/stars/{ticId}/residual-jobs")
    public ResponseEntity<JobAccepted> request(@AuthenticationPrincipal MemberPrincipal principal,
                                               @PathVariable String ticId,
                                               @RequestBody(required = false) JobRequest body) {
        // 캐시는 곧바로 쓸 수 있으니 200, 계산이 필요하면 202다(7.1절).
        return respond(jobs.request(principal.memberId(), tic(ticId), body));
    }

    @Operation(summary = "잔차 작업 상태",
            description = "v1은 폴링이며 pollAfterSeconds를 따른다. 없거나 내 작업이 아니면 404."
                    + " COMPLETED면 resultCurveContext로 곡선·주기도를 조회한다.")
    @GetMapping("/api/v1/residual-jobs/{jobId}")
    public ResponseEntity<JobStatus> status(@AuthenticationPrincipal MemberPrincipal principal,
                                            @PathVariable String jobId) {
        return respond(jobs.status(principal.memberId(), jobId));
    }

    /**
     * 형식이 다른 TIC은 없는 별과 같은 응답으로 덮는다. 2.3절이 {@code abc}·{@code 01}·{@code -1}도
     * {@code STAR_NOT_PUBLISHED}로 정했고 5.2·6장 컨트롤러도 같다. 형식만 403으로 갈라지면 그 응답
     * 차이로 별의 존재를 알 수 있다.
     */
    private static long tic(String ticId) {
        return ExplorationIds.parseTic(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.STAR_NOT_PUBLISHED));
    }

    /**
     * 지금 판을 {@code X-Current-Bundle}로 함께 준다(D-5). 5.1·5.2·6장·8.3절과 같은 헤더이며, 화면은
     * 폴링 중에 이 값이 진입 때 받은 판과 다르면 추가 요청 없이 5.1절을 다시 조회한다.
     *
     * <p>판을 읽지 못하면 붙이지 않는다. 「모른다」를 빈 문자열로 적으면 화면이 판이 바뀐 것으로 읽는다.
     */
    private static <T> ResponseEntity<T> respond(Answer<T> answer) {
        ResponseEntity.BodyBuilder response =
                ResponseEntity.status(answer.ready() ? HttpStatus.OK : HttpStatus.ACCEPTED);
        if (answer.currentBundleId() != null) {
            response.header(AnalysisController.CURRENT_BUNDLE_HEADER, answer.currentBundleId());
        }
        return response.body(answer.body());
    }

}
