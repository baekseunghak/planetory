package com.planetory.backend.domain.exploration.controller;

import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;
import com.planetory.backend.domain.exploration.service.*;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;

@RestController
@RequiredArgsConstructor
public class SubmissionController {
    private final SubmissionService submissions;
    private final SubmissionLookupService lookup;

    @PostMapping("/api/v1/stars/{ticId}/submissions")
    public ResponseEntity<JsonNode> submit(@AuthenticationPrincipal MemberPrincipal principal,
                                           @PathVariable String ticId, @RequestBody SubmissionRequest request) {
        long tic = ExplorationIds.parseTic(ticId).orElseThrow(() -> new BusinessException(ErrorCode.STAR_NOT_PUBLISHED));
        var answer = submissions.submit(principal.memberId(), tic, request);
        return ResponseEntity.status(answer.replay() ? 200 : 201)
                .header(AnalysisController.CURRENT_BUNDLE_HEADER, answer.currentBundleId()).body(answer.body());
    }

    @Operation(summary = "제출 조회",
            description = "6.4절 본문과 같다. 당시 값은 저장된 최초 응답이고 진행·공개·통계는 조회 시점 값이다."
                    + " 본인 제출만 볼 수 있다.")
    @GetMapping("/api/v1/submissions/{submissionId}")
    public ResponseEntity<SubmissionViews.Result> submission(@AuthenticationPrincipal MemberPrincipal principal,
                                                             @PathVariable String submissionId) {
        return respond(lookup.byId(principal.memberId(), submissionId));
    }

    @Operation(summary = "요청 ID로 제출 찾기",
            description = "응답을 잃은 뒤의 복구다. 접수됐으면 200, 아직 안 왔으면 404로 같은 ID 재전송,"
                    + " 처리 중이면 409 REQUEST_IN_PROGRESS로 기다린다.")
    @GetMapping("/api/v1/submissions/by-request/{requestId}")
    public ResponseEntity<SubmissionViews.Result> byRequest(@AuthenticationPrincipal MemberPrincipal principal,
                                                            @PathVariable String requestId) {
        return respond(lookup.byRequest(principal.memberId(), requestId));
    }

    /** 조회는 언제나 200이며 지금 판을 헤더로 함께 준다(D-5). 판을 읽지 못하면 붙이지 않는다. */
    private static <T> ResponseEntity<T> respond(AnalysisViews.Answer<T> answer) {
        ResponseEntity.BodyBuilder response = ResponseEntity.ok();
        if (answer.currentBundleId() != null) {
            response.header(AnalysisController.CURRENT_BUNDLE_HEADER, answer.currentBundleId());
        }
        return response.body(answer.body());
    }
}
