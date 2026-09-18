package com.planetory.backend.domain.exploration.service;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * 분석 데이터 조회의 탐사 도메인 쪽 판정 [S15P21C206-140]. Gold 배열은 {@code GoldCatalogRepository}가 읽는다.
 */
@Repository
@RequiredArgsConstructor
public class AnalysisRepository {

    private final JdbcClient jdbc;

    /**
     * 서비스에 공개된 별인지. 없는 TIC과 미공개 별을 구분하지 않는다(2.3절 {@code STAR_NOT_PUBLISHED}).
     */
    public boolean isPublished(long ticId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM stars WHERE tic_id = ? AND service_status = 'published')")
                .param(ticId)
                .query(Boolean.class).single();
    }

    /**
     * 회원이 매칭한 이 별의 활성 후보. 잔차 곡선에서 제거할 수 있는 후보의 전체 집합이다(2.1절).
     *
     * <p>완료 판정(9.3절, {@code ExplorationCompletionRepository})과 같은 기준이다. 매칭은 판과
     * 무관하게 누적되고 은퇴한 후보는 활성이 아니므로 빠진다.
     */
    public Set<Long> findMatchedActiveCandidateIds(long memberId, long ticId) {
        return new HashSet<>(jdbc.sql("""
                        SELECT c.id
                          FROM candidates c
                         WHERE c.tic_id = :ticId
                           AND c.status = 'active'
                           AND EXISTS (
                               SELECT 1 FROM submissions s
                                WHERE s.user_id = :memberId
                                  AND s.tic_id = :ticId
                                  AND s.matched_candidate_id = c.id)
                        """)
                .param("memberId", memberId)
                .param("ticId", ticId)
                .query(Long.class)
                .list());
    }

    /**
     * 마지막 제출이 쓴 제거 조합. 분석 복귀는 이 조합으로 돌아간다(5.1절). 제출이 없으면 비어 있다.
     *
     * <p>같은 시각이면 id가 큰 쪽이 최신이다.
     */
    public Optional<List<Long>> findLastSubmittedRemoval(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT removed_candidate_ids
                          FROM submissions
                         WHERE user_id = :memberId AND tic_id = :ticId
                         ORDER BY created_at DESC, id DESC
                         LIMIT 1
                        """)
                .param("memberId", memberId)
                .param("ticId", ticId)
                .query((rs, rowNum) -> List.of((Long[]) rs.getArray("removed_candidate_ids").getArray()))
                .optional();
    }

    /**
     * 튜토리얼 건너뛰기 판정 재료(SUB-12). 오답은 수치 불일치와 판단 불일치를 합해 센다(ERD 튜토리얼
     * 건너뛰기 카운트).
     */
    public Mismatches countMismatches(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT count(*) AS total,
                               COALESCE((array_agg(answer_viewed ORDER BY created_at DESC, id DESC))[1], false)
                                   AS latest_answer_viewed
                          FROM submissions
                         WHERE user_id = :memberId AND tic_id = :ticId
                           AND (match_result IN ('not_matched', 'none_wrong')
                                OR (match_result IN ('matched', 'matched_harmonic')
                                    AND achievement_result = 'judgment_mismatch'))
                        """)
                .param("memberId", memberId)
                .param("ticId", ticId)
                .query((rs, rowNum) -> new Mismatches(rs.getInt("total"), rs.getBoolean("latest_answer_viewed")))
                .single();
    }

    /**
     * @param total              오답 제출 수
     * @param latestAnswerViewed 가장 최근 오답 제출에서 상세 보기를 거쳤는지. 건너뛰기는 해설을 본 뒤에만 연다
     */
    public record Mismatches(int total, boolean latestAnswerViewed) {
    }
}
