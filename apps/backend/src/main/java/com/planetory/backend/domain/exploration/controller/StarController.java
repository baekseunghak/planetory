package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.StarViews.PublicStarSummary;
import com.planetory.backend.domain.exploration.service.StarViews.StarList;
import com.planetory.backend.domain.exploration.service.StarViews.StarDetail;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
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

    @Operation(summary = "공개 별 요약",
            description = "게시판 헤더·출처 카드가 쓴다. 발견하지 않은 회원도 호출할 수 있다."
                    + " 미공개이거나 아무도 발견하지 않은 별은 404 STAR_NOT_PUBLISHED.")
    @GetMapping("/api/v1/stars/{ticId}")
    public PublicStarSummary publicSummary(@AuthenticationPrincipal MemberPrincipal principal,
                                           @PathVariable long ticId) {
        return stars.publicSummary(principal.memberId(), ticId);
    }

    @Operation(summary = "내 별 목록",
            description = "scope=submitted(기본)는 제출 이력이 있는 별, discovered는 발견한 별 전부."
                    + " 필터 stage·grade·ticId는 P1이라 아직 받지 않는다.")
    @GetMapping("/api/v1/me/stars")
    public StarList myStars(@AuthenticationPrincipal MemberPrincipal principal,
                            @RequestParam(required = false) String scope,
                            @RequestParam(required = false) String sort,
                            @RequestParam(required = false) Integer size,
                            @RequestParam(required = false) String cursor) {
        long memberId = principal.memberId();
        return stars.list(memberId, memberId, scope, sort, size, cursor);
    }

    @Operation(summary = "타인 별 목록",
            description = "별 목록을 공개한 회원만 볼 수 있다. 비공개면 403 STAR_LIST_PRIVATE."
                    + " scope=discovered는 본인 조회 전용이라 거절한다.")
    @GetMapping("/api/v1/members/{memberId}/stars")
    public StarList memberStars(@AuthenticationPrincipal MemberPrincipal principal,
                                @PathVariable long memberId,
                                @RequestParam(required = false) String scope,
                                @RequestParam(required = false) String sort,
                                @RequestParam(required = false) Integer size,
                                @RequestParam(required = false) String cursor) {
        return stars.list(principal.memberId(), memberId, scope, sort, size, cursor);
    }
}
