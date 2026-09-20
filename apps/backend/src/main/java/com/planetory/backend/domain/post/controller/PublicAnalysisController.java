package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.post.service.PublicAnalysisService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
@RequiredArgsConstructor
public class PublicAnalysisController {
    private final PublicAnalysisService publications;

    @Operation(summary = "본인 History 공개 분석 등록 및 최초 성과 인정")
    @PostMapping("/api/v1/public-analyses")
    public ResponseEntity<PublicAnalysisService.Published> publish(
            @AuthenticationPrincipal MemberPrincipal principal, @RequestBody JsonNode request) {
        if (request == null || !request.isObject() || request.size() != 1
                || !request.path("historyId").isString()) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        var result = publications.publish(principal.memberId(), request.path("historyId").stringValue());
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result);
    }
}
