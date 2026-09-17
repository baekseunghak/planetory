package com.planetory.backend.domain.member.dto;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService.Summary;

public record MeResponse(String memberId, String nickname, String role, String starListVisibility,
                         boolean tutorialCompleted, boolean onboardingDone, Summary achievementSummary) {}
