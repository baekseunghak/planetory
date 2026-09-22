package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews.Locate;
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

    @Operation(summary = "별 위치 찾기",
            description = "검색·필터로 고른 별로 카메라를 옮길 때 쓴다. 발견한 별만 허용하며"
                    + " 미발견 별과 형식이 다른 TIC은 같은 403 STAR_LOCKED로 덮는다."
                    + " bounds는 그 별이 든 타일 한 칸이라 그대로 타일 조회에 넣을 수 있다.")
    @GetMapping("/api/v1/me/sky/locate")
    public Locate locate(@AuthenticationPrincipal MemberPrincipal principal,
                         @RequestParam String ticId) {
        return sky.locate(principal.memberId(), ExplorationIds.parseTic(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.STAR_LOCKED)));
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
