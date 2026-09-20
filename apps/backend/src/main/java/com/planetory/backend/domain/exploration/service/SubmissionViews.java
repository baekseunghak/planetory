package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/** 탐사 API 6.4. 최초 응답과 재전송의 본문은 같고 HTTP 상태만 다르다. */
public final class SubmissionViews {
    private SubmissionViews() {}
    public record Result(String submissionId, String historyId, String requestId, String ticId, String bundleId,
                         String ruleVersion, OffsetDateTime submittedAt, String submissionKind,
                         SubmissionRequest.Context curveContext, Original original, Derived serverDerived,
                         Match match, Map<String, Object> signal, Judgment judgment, String skyVersion,
                         Achievement achievement, Progress progress, Publication publication,
                         Object judgmentStatistics, Detail detail, AnalysisViews.TutorialState tutorial,
                         List<String> nextActions) {}
    public record Original(Double periodDays, Integer sourcePeakGridIndex, Double phaseStart, Double phaseEnd,
                           String userJudgment, List<String> evidenceChecks, String memo, SubmissionRequest.ViewState viewState) {}
    public record Derived(double foldReferenceTimeBtjd, Double phaseCenter, Double epochBtjd, Double durationHours,
                          Double sourcePeakSuggestedDurationHours, Double durationLimitHours, String centroidDataStatus) {}
    public record Match(String status, String candidateId, Double harmonicMultiplier, Double correctedPeriodDays, String correctionReason) {}
    public record Judgment(String value, String evaluation) {}
    public record UnlockedStar(String ticId, GalaxyLayout.StarPosition position) {}
    public record Achievement(String result, boolean newlyRecognized, List<UnlockedStar> unlockedStars,
                              StarViews.Achievement star) {}
    public record Progress(String stage, String completionReason, boolean reopenPending, int currentCurveStep,
                           List<String> matchedCandidateIds, long remainingDiscoverableCount) {}
    public record Publication(String state, String publicAnalysisId) {}
    public record Detail(boolean available, String targetKind, boolean answerViewed) {}
}
