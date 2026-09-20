package com.planetory.backend.domain.exploration.controller;

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

    @PostMapping("/api/v1/stars/{ticId}/submissions")
    public ResponseEntity<JsonNode> submit(@AuthenticationPrincipal MemberPrincipal principal,
                                           @PathVariable String ticId, @RequestBody SubmissionRequest request) {
        long tic = ExplorationIds.parseTic(ticId).orElseThrow(() -> new BusinessException(ErrorCode.STAR_NOT_PUBLISHED));
        var answer = submissions.submit(principal.memberId(), tic, request);
        return ResponseEntity.status(answer.replay() ? 200 : 201)
                .header(AnalysisController.CURRENT_BUNDLE_HEADER, answer.currentBundleId()).body(answer.body());
    }
}
