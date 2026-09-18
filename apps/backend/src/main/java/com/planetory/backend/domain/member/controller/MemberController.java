package com.planetory.backend.domain.member.controller;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService;
import com.planetory.backend.domain.member.dto.MeResponse;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import java.util.Locale;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
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
        return new MeResponse("u-" + member.getId(), member.getNickname(), member.getCreatedAt(),
                member.getRole().toUpperCase(Locale.ROOT), settings.isStarListPublic() ? "PUBLIC" : "PRIVATE", overview.tutorialCompleted(),
                settings.isOnboardingDone(), overview.achievementSummary());
    }

    public record NicknameRequest(String nickname) {}
    public record ProfileResponse(String memberId, String nickname) {}
    public record OnboardingRequest(Boolean onboardingDone) {}
    public record OnboardingResponse(boolean onboardingDone) {}
    public record PublicAchievementSummary(long signalCount, Map<String, Long> starCountByGrade) {}
    public record PublicProfileResponse(String memberId, String nickname, String starListVisibility,
                                        PublicAchievementSummary achievementSummary) {}

    @PatchMapping("/api/v1/me/profile")
    public ProfileResponse changeNickname(@AuthenticationPrincipal MemberPrincipal principal,
                                          @RequestBody NicknameRequest request) {
        var member = members.changeNickname(principal.memberId(), request == null ? null : request.nickname());
        return new ProfileResponse("u-" + member.getId(), member.getNickname());
    }

    // 단방향 완료 기록이라 양방향 설정인 /me/settings와 경로를 분리한다. P1 공개 설정이 /me/settings를 쓴다.
    @PatchMapping("/api/v1/me/onboarding")
    public OnboardingResponse completeOnboarding(@AuthenticationPrincipal MemberPrincipal principal,
                                                 @RequestBody OnboardingRequest request) {
        if (request == null || !Boolean.TRUE.equals(request.onboardingDone())) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        members.completeOnboarding(principal.memberId());
        return new OnboardingResponse(true);
    }

    @GetMapping("/api/v1/members/{memberId}")
    public PublicProfileResponse publicProfile(@PathVariable String memberId) {
        if (!memberId.matches("u-[1-9][0-9]*")) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        long id;
        try { id = Long.parseLong(memberId.substring(2)); }
        catch (NumberFormatException e) { throw new BusinessException(ErrorCode.VALIDATION_FAILED); }
        var member = members.publicProfile(id);
        var settings = members.settings(id);
        var summary = exploration.overview(id).achievementSummary();
        return new PublicProfileResponse(memberId, member.getNickname(),
                settings.isStarListPublic() ? "PUBLIC" : "PRIVATE",
                new PublicAchievementSummary(summary.signalCount(), summary.starCountByGrade()));
    }
}
