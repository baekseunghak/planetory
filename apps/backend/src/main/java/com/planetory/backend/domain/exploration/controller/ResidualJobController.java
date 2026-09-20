package com.planetory.backend.domain.exploration.controller;

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
        JobAccepted accepted = jobs.request(principal.memberId(), tic(ticId), body);
        // 캐시는 곧바로 쓸 수 있으니 200, 계산이 필요하면 202다(7.1절).
        return ResponseEntity.status(accepted.cacheHit() ? HttpStatus.OK : HttpStatus.ACCEPTED).body(accepted);
    }

    @Operation(summary = "잔차 작업 상태",
            description = "v1은 폴링이며 pollAfterSeconds를 따른다. 없거나 내 작업이 아니면 404."
                    + " COMPLETED면 resultCurveContext로 곡선·주기도를 조회한다.")
    @GetMapping("/api/v1/residual-jobs/{jobId}")
    public JobStatus status(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String jobId) {
        return jobs.status(principal.memberId(), jobId);
    }

    /** 형식이 다른 TIC은 발견하지 않은 별과 같은 응답으로 덮는다(4.2절과 같은 방침). */
    private static long tic(String ticId) {
        return ExplorationIds.parseTic(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.STAR_LOCKED));
    }

}
