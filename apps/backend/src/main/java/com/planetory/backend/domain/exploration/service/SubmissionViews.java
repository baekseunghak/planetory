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

    /**
     * 6.7절 상세 보기. 본문이 없고 반복 호출이 같은 대상을 준다.
     *
     * @param userJudgmentAgrees {@code CURRENT_MATCH}에서 당시 판단이 신호 판정과 맞았는지.
     *                           미확정·모르겠음·힌트 대상에는 없다
     */
    public record DetailView(String submissionId, boolean answerViewed, String targetKind,
                             Map<String, Object> signal, Boolean userJudgmentAgrees,
                             AnalysisViews.TutorialState tutorial) {}
    public record UnlockedStar(String ticId, GalaxyLayout.StarPosition position) {}
    public record Achievement(String result, boolean newlyRecognized, List<UnlockedStar> unlockedStars,
                              StarViews.Achievement star) {}
    public record Progress(String stage, String completionReason, boolean reopenPending, int currentCurveStep,
                           List<String> matchedCandidateIds, long remainingDiscoverableCount) {}
    public record Publication(String state, String publicAnalysisId) {}
    public record Detail(boolean available, String targetKind, boolean answerViewed) {}
}
