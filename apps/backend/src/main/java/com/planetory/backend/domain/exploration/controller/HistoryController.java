package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.HistoryService;
import com.planetory.backend.domain.exploration.service.HistoryViews.*;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequiredArgsConstructor
public class HistoryController {
    private final HistoryService histories;

    @Operation(summary="내 히스토리 목록")
    @GetMapping("/api/v1/me/histories")
    public Page list(@AuthenticationPrincipal MemberPrincipal principal,
                     @RequestParam(required=false) String ticId, @RequestParam(required=false) String candidateId,
                     @RequestParam(required=false) String result, @RequestParam(required=false) String from,
                     @RequestParam(required=false) String to, @RequestParam(required=false) String cursor,
                     @RequestParam(required=false) String size) {
        return histories.list(principal.memberId(),new Query(ticId,candidateId,result,from,to,cursor,size));
    }
    @Operation(summary="내 히스토리 상세")
    @GetMapping("/api/v1/histories/{historyId}")
    public Detail detail(@AuthenticationPrincipal MemberPrincipal principal,@PathVariable String historyId) {
        return histories.detail(principal.memberId(),historyId);
    }
    @Operation(summary="내 히스토리 당시·현재 그래프")
    @GetMapping("/api/v1/histories/{historyId}/graph")
    public ResponseEntity<Graph> graph(@AuthenticationPrincipal MemberPrincipal principal,@PathVariable String historyId,
                                       @RequestParam(required=false) String mode) {
        var graph=histories.graph(principal.memberId(),historyId,mode);
        return ResponseEntity.ok().header(AnalysisController.CURRENT_BUNDLE_HEADER,graph.reproduction().currentBundleId()).body(graph);
    }
}
