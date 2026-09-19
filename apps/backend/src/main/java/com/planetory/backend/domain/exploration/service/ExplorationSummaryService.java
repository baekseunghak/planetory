package com.planetory.backend.domain.exploration.service;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 회원 탐사 요약의 원천 (탐사 API 9.1절 {@code summary}).
 *
 * <p>{@code GET /me/achievements}와 서비스 API {@code GET /me}·{@code GET /members/{id}}가 이 집계 하나를
 * 쓴다. 서비스는 이름만 바꿔 투영하고 산식을 따로 두지 않는다(서비스 API 3.2절 성과 요약 매핑).
 */
@Service
@RequiredArgsConstructor
public class ExplorationSummaryService {
    private final JdbcClient jdbc;
    private final TutorialRepository tutorials;

    /** /me 표현. 9.1절 요약에서 {@code startedStarCount}를 빼고 두 이름을 바꾼 투영이다. */
    public record Summary(long discoveredStarCount, long completedStarCount, long signalCount,
                          Map<String, Long> byType, Map<String, Long> starCountByGrade) {}
    public record Overview(boolean tutorialCompleted, Summary achievementSummary) {}

    /**
     * 탐사 API 9.1절 {@code summary}. 저장 열이 아니라 호출 시 집계한다.
     *
     * @param startedStarCount 제출 이력이 있는 발견 별 수. 4.4절 {@code scope=submitted} 목록의 길이와 같다
     */
    public record AchievementSummary(long discoveredStarCount, long startedStarCount, long completedStarCount,
                                     long recognizedTotal, Map<String, Long> byType,
                                     Map<String, Long> gradeDistribution) {}

    @Transactional(readOnly = true)
    public Overview overview(long memberId) {
        AchievementSummary summary = achievementSummary(memberId);
        // 퀘스트 패널 완료 수·챌린지 자격과 같은 판정을 쓴다(탐사 API 11.1절).
        boolean tutorialCompleted = tutorials.isTutorialCompleted(memberId);
        return new Overview(tutorialCompleted, new Summary(summary.discoveredStarCount(),
                summary.completedStarCount(), summary.recognizedTotal(), summary.byType(),
                summary.gradeDistribution()));
    }

    @Transactional(readOnly = true)
    public AchievementSummary achievementSummary(long memberId) {
        long[] stars = jdbc.sql("""
                SELECT count(*) AS discovered, count(*) FILTER (WHERE started) AS started
                  FROM (SELECT EXISTS (SELECT 1 FROM submissions s
                                        WHERE s.user_id = u.user_id AND s.tic_id = u.tic_id) AS started
                          FROM star_unlocks u WHERE u.user_id = ?) d
                """).param(memberId).query((rs, row) -> new long[] {rs.getLong("discovered"), rs.getLong("started")})
                .single();
        var progress = jdbc.sql("""
                SELECT count(*) FILTER (WHERE progress_stage = 'completed') AS completed,
                    count(*) FILTER (WHERE achievement_count = 1) AS a,
                    count(*) FILTER (WHERE achievement_count = 2) AS s,
                    count(*) FILTER (WHERE achievement_count = 3) AS ss,
                    count(*) FILTER (WHERE achievement_count >= 4) AS sss
                FROM user_star_progress WHERE user_id = ?
                """).param(memberId).query((rs, row) -> ordered("completed", rs.getLong("completed"),
                        "A", rs.getLong("a"), "S", rs.getLong("s"), "SS", rs.getLong("ss"), "SSS", rs.getLong("sss")))
                .single();
        var byType = jdbc.sql("""
                SELECT count(*) FILTER (WHERE achievement_type = 'confirmed') AS confirmed,
                    count(*) FILTER (WHERE achievement_type = 'unconfirmed') AS unconfirmed,
                    count(*) FILTER (WHERE achievement_type = 'fp') AS fp
                FROM user_candidate_achievements WHERE user_id = ?
                """).param(memberId).query((rs, row) -> ordered("confirmed", rs.getLong("confirmed"),
                        "unconfirmed", rs.getLong("unconfirmed"), "fp", rs.getLong("fp"))).single();
        return new AchievementSummary(stars[0], stars[1], progress.get("completed"),
                byType.values().stream().mapToLong(Long::longValue).sum(), byType,
                ordered("A", progress.get("A"), "S", progress.get("S"), "SS", progress.get("SS"),
                        "SSS", progress.get("SSS")));
    }

    /** 응답 JSON의 키 순서를 명세 예시와 같게 고정한다. */
    private static Map<String, Long> ordered(Object... keyValues) {
        Map<String, Long> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            map.put((String) keyValues[i], (Long) keyValues[i + 1]);
        }
        return Collections.unmodifiableMap(map);
    }
}
