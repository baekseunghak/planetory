package com.planetory.backend.domain.exploration.service;

import java.util.HashSet;
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
}
