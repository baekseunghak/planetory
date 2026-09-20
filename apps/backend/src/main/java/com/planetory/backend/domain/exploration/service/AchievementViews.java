package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService.AchievementSummary;

/** 성과 조회 응답 (탐사 API 9.1절) [S15P21C206-144]. */
public final class AchievementViews {

    private AchievementViews() {
    }

    /** {@code summary}는 회원 전체 값이다. {@code ticId} 필터는 {@code items}에만 적용한다. */
    public record AchievementList(AchievementSummary summary, List<AchievementItem> items, String nextCursor,
                                  boolean hasNext) {
    }

    /**
     * 인정된 성과 한 건.
     *
     * @param recognizedAnalysisId 미확정 성과의 인정 근거 공개 분석. 확정·FP는 null
     * @param relabel              외부 라벨 갱신 표식(9.5절). 갱신되지 않았으면 null
     * @param unlockedStars        이 성과로 열린 별. 성과 순번({@code seq}) 순서다
     */
    public record AchievementItem(String achievementId, String ticId, String candidateId, String type,
                                  String recognizedSubmissionId, String recognizedAnalysisId,
                                  OffsetDateTime recognizedAt, Relabel relabel, List<UnlockedStar> unlockedStars) {
    }

    /** 8.2절과 같은 모양이다. {@code newDisposition}은 6.4절 {@code signal.disposition} 값을 쓴다. */
    public record Relabel(OffsetDateTime relabeledAt, String newDisposition) {
    }

    public record UnlockedStar(String ticId) {
    }
}
