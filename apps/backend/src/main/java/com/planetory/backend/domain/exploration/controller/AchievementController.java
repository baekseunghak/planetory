package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.AchievementService;
import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementList;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 내 성과 조회 (탐사 API 9.1) [S15P21C206-144]. */
@RestController
@RequiredArgsConstructor
public class AchievementController {

    private final AchievementService achievements;

    @Operation(summary = "내 성과",
            description = "summary는 회원 전체 요약이고 ticId 필터는 items에만 적용한다."
                    + " items는 인정 시각 내림차순이며 size는 기본 50, 상한 100이다.")
    @GetMapping("/api/v1/me/achievements")
    public AchievementList myAchievements(@AuthenticationPrincipal MemberPrincipal principal,
                                          @RequestParam(required = false) String ticId,
                                          @RequestParam(required = false) String size,
                                          @RequestParam(required = false) String cursor) {
        return achievements.list(principal.memberId(), ticId, size, cursor);
    }
}
