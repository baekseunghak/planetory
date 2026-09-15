package com.planetory.backend.domain.member.controller;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService;
import com.planetory.backend.domain.member.dto.MeResponse;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import java.util.Locale;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class MemberController {
    private final MemberService members;
    private final ExplorationSummaryService exploration;

    @Operation(summary = "로그인 상태 및 내 정보 조회")
    @GetMapping("/api/v1/me")
    public MeResponse me(@AuthenticationPrincipal MemberPrincipal principal) {
        var member = members.requireActive(principal.memberId());
        var settings = members.settings(member.getId());
        var overview = exploration.overview(member.getId());
        return new MeResponse("u-" + member.getId(), member.getNickname(), member.getRole().toUpperCase(Locale.ROOT),
                settings.isStarListPublic() ? "PUBLIC" : "PRIVATE", overview.tutorialCompleted(),
                settings.isOnboardingDone(), overview.achievementSummary());
    }
}
