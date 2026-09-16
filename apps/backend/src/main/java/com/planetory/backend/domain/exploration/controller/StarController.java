package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.StarViews.StarDetail;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** 선택한 별·내 행성 상세 (탐사 API 4.2) [S15P21C206-138]. */
@RestController
@RequiredArgsConstructor
public class StarController {

    private final StarService stars;

    @Operation(summary = "내 별 상세",
            description = "발견한 별의 근접 뷰·도킹 패널·행성 목록이 공유한다. 미발견 별은 403 STAR_LOCKED.")
    @GetMapping("/api/v1/me/stars/{ticId}")
    public StarDetail detail(@AuthenticationPrincipal MemberPrincipal principal,
                             @PathVariable long ticId) {
        return stars.detail(principal.memberId(), ticId);
    }
}
