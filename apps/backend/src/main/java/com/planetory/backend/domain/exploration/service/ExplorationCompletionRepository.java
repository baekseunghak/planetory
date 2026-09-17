package com.planetory.backend.domain.exploration.service;

import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** 완료 판정에 필요한 진행 행 잠금과 후보 집계 [S15P21C206-149]. */
@Repository
@RequiredArgsConstructor
public class ExplorationCompletionRepository {

    private final JdbcClient jdbc;

    /** 같은 회원·별의 제출이나 판 전환 후처리와 완료 전환을 직렬화한다. */
    public Optional<String> lockProgressStage(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT progress_stage
                          FROM user_star_progress
                         WHERE user_id = :memberId AND tic_id = :ticId
                           FOR UPDATE
                        """)
                .param("memberId", memberId)
                .param("ticId", ticId)
                .query(String.class)
                .optional();
    }

    /**
     * 현재 별의 활성 후보와 회원의 누적 매칭을 센다.
     *
     * <p>후보 ID는 판이 바뀌어도 유지되므로 모든 판의 제출에서 매칭 여부를 찾는다. 판단·성과·공개는
     * 완료 조건이 아니다. current 판이 없으면 판정할 공개 데이터가 없는 것으로 보고 0건을 반환한다.
     */
    public CandidateCounts countCandidates(long memberId, long ticId) {
        return jdbc.sql("""
                        WITH matched AS (
                            SELECT DISTINCT matched_candidate_id AS candidate_id
                              FROM submissions
                             WHERE user_id = :memberId
                               AND tic_id = :ticId
                               AND matched_candidate_id IS NOT NULL
                        ), current_candidates AS (
                            SELECT c.id, c.discoverable
                              FROM candidates c
                             WHERE c.tic_id = :ticId
                               AND c.status = 'active'
                               AND EXISTS (
                                   SELECT 1 FROM publication_bundles b
                                    WHERE b.tic_id = c.tic_id AND b.status = 'current'
                               )
                        )
                        SELECT count(*) AS active_count,
                               count(*) FILTER (
                                   WHERE c.discoverable AND m.candidate_id IS NULL
                               ) AS discoverable_unmatched_count,
                               count(*) FILTER (
                                   WHERE NOT c.discoverable AND m.candidate_id IS NULL
                               ) AS undiscoverable_unmatched_count
                          FROM current_candidates c
                     LEFT JOIN matched m ON m.candidate_id = c.id
                        """)
                .param("memberId", memberId)
                .param("ticId", ticId)
                .query((rs, rowNum) -> new CandidateCounts(
                        rs.getInt("active_count"),
                        rs.getInt("discoverable_unmatched_count"),
                        rs.getInt("undiscoverable_unmatched_count")))
                .single();
    }

    /**
     * 진행 중인 행만 완료로 바꾼다. 재개 뒤 다시 완료해도 최초 완료 시각은 보존한다.
     */
    public int complete(long memberId, long ticId, ExplorationCompletionPolicy.Decision decision) {
        return jdbc.sql("""
                        UPDATE user_star_progress
                           SET progress_stage = 'completed',
                               completion_reason = :reason,
                               reopen_pending = :reopenPending,
                               completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
                         WHERE user_id = :memberId AND tic_id = :ticId
                           AND progress_stage = 'in_progress'
                        """)
                .param("reason", decision.completionReason())
                .param("reopenPending", decision.reopenPending())
                .param("memberId", memberId)
                .param("ticId", ticId)
                .update();
    }

    public record CandidateCounts(int active, int discoverableUnmatched, int undiscoverableUnmatched) {
    }
}
