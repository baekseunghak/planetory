package com.planetory.backend.domain.exploration.service;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** /me의 탐사 요약 원천. 향후 성과 API도 이 조회를 사용한다. */
@Service
@RequiredArgsConstructor
public class ExplorationSummaryService {
    private final JdbcClient jdbc;
    private final TutorialRepository tutorials;

    public record Summary(long discoveredStarCount, long completedStarCount, long signalCount,
                          Map<String, Long> byType, Map<String, Long> starCountByGrade) {}
    public record Overview(boolean tutorialCompleted, Summary achievementSummary) {}

    @Transactional(readOnly = true)
    public Overview overview(long memberId) {
        long discovered = jdbc.sql("SELECT count(*) FROM star_unlocks WHERE user_id = ?")
                .param(memberId).query(Long.class).single();
        var progress = jdbc.sql("""
                SELECT count(*) FILTER (WHERE progress_stage = 'completed') AS completed,
                    count(*) FILTER (WHERE achievement_count = 1) AS a,
                    count(*) FILTER (WHERE achievement_count = 2) AS s,
                    count(*) FILTER (WHERE achievement_count = 3) AS ss,
                    count(*) FILTER (WHERE achievement_count >= 4) AS sss
                FROM user_star_progress WHERE user_id = ?
                """).param(memberId).query((rs, row) -> Map.of("completed", rs.getLong("completed"),
                        "A", rs.getLong("a"), "S", rs.getLong("s"), "SS", rs.getLong("ss"), "SSS", rs.getLong("sss"))).single();
        var byType = jdbc.sql("""
                SELECT count(*) FILTER (WHERE achievement_type = 'confirmed') AS confirmed,
                    count(*) FILTER (WHERE achievement_type = 'unconfirmed') AS unconfirmed,
                    count(*) FILTER (WHERE achievement_type = 'fp') AS fp
                FROM user_candidate_achievements WHERE user_id = ?
                """).param(memberId).query((rs, row) -> Map.of("confirmed", rs.getLong("confirmed"),
                        "unconfirmed", rs.getLong("unconfirmed"), "fp", rs.getLong("fp"))).single();
        // 퀘스트 패널 완료 수·챌린지 자격과 같은 판정을 쓴다(탐사 API 11.1절).
        boolean tutorialCompleted = tutorials.isTutorialCompleted(memberId);
        return new Overview(tutorialCompleted, new Summary(discovered, progress.get("completed"),
                byType.values().stream().mapToLong(Long::longValue).sum(), byType,
                Map.of("A", progress.get("A"), "S", progress.get("S"), "SS", progress.get("SS"), "SSS", progress.get("SSS"))));
    }
}
