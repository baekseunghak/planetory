package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.post.service.PublicAnalysisService;
import com.planetory.backend.domain.post.service.PublicAnalysisBatchService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
@RequiredArgsConstructor
public class PublicAnalysisController {
    private final PublicAnalysisService publications;
    private final PublicAnalysisBatchService batches;

    @Operation(summary = "본인 History 신호별 일괄 공개")
    @PostMapping("/api/v1/public-analyses/batch")
    public PublicAnalysisBatchService.Batch batch(@AuthenticationPrincipal MemberPrincipal principal,
            @RequestBody JsonNode request) {
        return batches.publish(principal.memberId(), request);
    }

    @Operation(summary = "별의 신호별 대표 공개 검토 후보")
    @GetMapping("/api/v1/public-analyses/batch-candidates")
    public PublicAnalysisBatchService.Page candidates(@AuthenticationPrincipal MemberPrincipal principal,
            @RequestParam MultiValueMap<String, String> params) {
        return batches.candidates(principal.memberId(), params);
    }

    @Operation(summary = "본인 공개 분석 취소·재공개")
    @PutMapping("/api/v1/public-analyses/{analysisId}/visibility")
    public PublicAnalysisService.Visibility visibility(@AuthenticationPrincipal MemberPrincipal principal,
            @PathVariable String analysisId, @RequestBody JsonNode request) {
        if (request == null || !request.isObject() || request.size() != 1
                || !request.path("isPublic").isBoolean()) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return publications.visibility(principal.memberId(), analysisId, request.path("isPublic").booleanValue());
    }

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
