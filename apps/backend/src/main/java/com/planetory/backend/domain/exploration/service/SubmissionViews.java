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
    /** @param missHint {@code not_matched}의 폭 힌트({@link SubmissionMatching#missHint}). 그 밖에는 null이다 */
    public record Match(String status, String candidateId, Double harmonicMultiplier, Double correctedPeriodDays, String correctionReason,
                        String missHint) {}
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

    /**
     * 6.8절 다시 풀기 초안. <b>조회만이며 아무것도 저장하지 않는다.</b>
     *
     * @param residualForStep 이 단계의 잔차 상태. 결과도 작업도 없으면 둘 다 null이며 조회가 작업을
     *                        만들지 않는다. 계산이 필요하면 화면이 7.1절로 요청한다
     */
    public record RetryDraft(String sourceSubmissionId, String bundleId, boolean isPreviousBundle,
                             AnalysisViews.CurveContext curveContext, Restored restored, Draft draft,
                             AnalysisViews.Residual residualForStep, String retryOfSubmissionId) {}

    /** @param notice 되살리지 못한 이유. 지금은 {@code STEP_NOT_RESTORABLE} 하나다 */
    public record Restored(boolean step, String notice) {}

    /**
     * 화면이 그대로 열어 이어 풀 값.
     *
     * <p>위상은 저장값을 복사하지 않고 현재 판 기준 시각으로 다시 만든다(HIS-02). 판단·근거·메모는
     * 비운다 — 다시 푸는 것이지 옛 답을 다시 내는 것이 아니다. 봉우리 식별값도 복원하지 않는다.
     */
    public record Draft(Double periodDays, Double phaseStart, Double phaseEnd,
                        SubmissionRequest.ViewState viewState, String userJudgment,
                        List<String> evidenceChecks, String memo) {}
    public record UnlockedStar(String ticId, GalaxyLayout.StarPosition position) {}
    public record Achievement(String result, boolean newlyRecognized, List<UnlockedStar> unlockedStars,
                              StarViews.Achievement star) {}
    public record Progress(String stage, String completionReason, boolean reopenPending, int currentCurveStep,
                           List<String> matchedCandidateIds, long remainingDiscoverableCount) {}
    public record Publication(String state, String publicAnalysisId) {}
    public record Detail(boolean available, String targetKind, boolean answerViewed) {}
}
