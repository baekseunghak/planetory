package com.planetory.backend.domain.member.dto;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService.Summary;
import java.time.Instant;

public record MeResponse(String memberId, String nickname, Instant joinedAt, String role, String starListVisibility,
                         boolean tutorialCompleted, boolean onboardingDone, Summary achievementSummary) {}
