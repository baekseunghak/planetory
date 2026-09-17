package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyMeta;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyTile;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 별 지도 메타·타일 (탐사 API 4.1) [S15P21C206-136]. */
@RestController
@RequiredArgsConstructor
public class SkyController {

    private final SkyService sky;
    private final MemberService members;

    @Operation(summary = "지도 메타", description = "홈 진입과 지도 버전 무효화 시 조회한다.")
    @GetMapping("/api/v1/me/sky")
    public SkyMeta meta(@AuthenticationPrincipal MemberPrincipal principal) {
        long memberId = principal.memberId();
        // firstVisit은 안내 완료의 반대값이다(HOME-09).
        boolean firstVisit = !members.settings(memberId).isOnboardingDone();
        return sky.meta(memberId, firstVisit);
    }

    @Operation(summary = "지도 타일",
            description = "요청 범위의 개별 별을 페이지로 준다. 모든 배율에서 군집으로 바꾸지 않는다.")
    @GetMapping("/api/v1/me/sky/tiles")
    public SkyTile tiles(@AuthenticationPrincipal MemberPrincipal principal,
                         @RequestParam int level,
                         @RequestParam double x,
                         @RequestParam double y,
                         @RequestParam double w,
                         @RequestParam double h,
                         @RequestParam String version,
                         @RequestParam(required = false) Integer limit,
                         @RequestParam(required = false) String cursor) {
        return sky.tiles(principal.memberId(), level, x, y, w, h, version, limit, cursor);
    }
}
