package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

/** 개인 조회와 공개 투영(탐사 API 8장). 공개 DTO에는 개인 상태를 넣지 않는다. */
public final class HistoryViews {
    private HistoryViews() {}
    public record Query(String ticId, String candidateId, String result, String from, String to,
                        String cursor, String size) {}
    public record Page(List<Item> items, String nextCursor, boolean hasNext) {}
    public record Publication(String publicAnalysisId, boolean isPublic, boolean isModerationHidden) {}
    public record Item(String historyId, String submissionId, String ticId, String candidateId,
                       String submissionKind, String matchResult, String userJudgment, String achievementResult,
                       OffsetDateTime submittedAt, String bundleId, boolean isPreviousBundle, int curveStep,
                       Publication publication, boolean achievementGranted, boolean snapshotAvailable, boolean detailAvailable,
                       boolean answerViewed, AchievementViews.Relabel relabel, String retryOfSubmissionId) {}
    public record Versions(String data, String preprocess, String pipeline, String rule, String residualModel,
                           String periodogramConfig, String snapshotVersion) {}
    public record FoldSettings(double referenceTimeBtjd) {}
    public record SnapshotParams(SubmissionRequest.Viewport periodogramViewport, Double foldedXZoomRatio,
                                 FoldSettings foldSettings, String centroidDataStatus) {}
    public record Detail(String historyId, SubmissionViews.Result submission, Versions versions, SnapshotParams snapshotParams,
                         boolean isPreviousBundle, AchievementViews.Relabel relabel, OffsetDateTime createdAt) {}
    public record Reproduction(String submittedBundleId, String currentBundleId, boolean isPreviousSubmission,
                               boolean residualReproducible, String fallbackReason, Double currentFoldReferenceTimeBtjd) {}
    public record Selection(Double userPeriodDays, Double correctedPeriodDays, Double harmonicMultiplier,
                            Double epochBtjd, Double durationHours, Double currentPhaseStart, Double currentPhaseEnd) {}
    public record Snapshot(int bins, Float[] foldedFlux, Float[] foldedError) {}
    public record Graph(String historyId, Reproduction reproduction, Selection selection, AnalysisViews.Curve curve,
                        Snapshot snapshot, String snapshotVersion) {}
    public record PublicOriginal(Double periodDays, Integer sourcePeakGridIndex, Double phaseStart, Double phaseEnd) {}
    public record PublicDerived(Double epochBtjd, Double durationHours) {}
    public record PublicMatch(String status, Double correctedPeriodDays, Double harmonicMultiplier) {}
    public record PublicHistory(String historyId, String ticId, String candidateId, OffsetDateTime submittedAt,
                                String userJudgment, List<String> evidenceChecks, String memo, PublicOriginal original,
                                PublicDerived serverDerived, PublicMatch match, AnalysisViews.CurveContext curveContext,
                                Versions versions, Graph graph, AchievementViews.Relabel relabel) {
        /** S07는 권한을 검사한 같은 History의 그래프만 합친다. 실패 시 원래 내용은 유지한다. */
        public PublicHistory withGraph(Graph value) {
            if (value!=null && !historyId.equals(value.historyId())) throw new IllegalArgumentException("History 그래프가 다릅니다.");
            return new PublicHistory(historyId,ticId,candidateId,submittedAt,userJudgment,evidenceChecks,memo,
                    original,serverDerived,match,curveContext,versions,value,relabel);
        }
    }
}
