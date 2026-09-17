package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.exploration.service.QuestViews.Reopened;
import com.planetory.backend.domain.exploration.service.QuestViews.TutorialItem;

/** 퀘스트 패널 조회 (탐사 API 4.3) [S15P21C206-139]. */
@Repository
@RequiredArgsConstructor
public class QuestRepository {

    private final JdbcClient jdbc;

    /**
     * 사용 중인 튜토리얼 다섯 칸과 이 회원의 발견·진행 상태.
     *
     * <p>완료한 적이 있는 칸은 별이 재개돼도 {@code completed}로 둔다. 완료 수·{@code tutorialCompleted}와
     * 같은 기준이다({@link TutorialRepository#EVER_COMPLETED}). 재개된 별은 {@code reopened}에 따로 나온다.
     */
    public List<TutorialItem> findTutorialItems(long memberId) {
        return jdbc.sql("""
                        SELECT t.seq, t.intent, t.tic_id,
                               u.id IS NOT NULL AS unlocked,
                               COALESCE(%s, false) AS ever_completed,
                               COALESCE(p.progress_stage, 'unexplored') AS progress_stage,
                               p.completion_reason
                          FROM tutorial_stars t
                     LEFT JOIN star_unlocks u ON u.user_id = :memberId AND u.tic_id = t.tic_id
                     LEFT JOIN user_star_progress p ON p.user_id = :memberId AND p.tic_id = t.tic_id
                         WHERE t.active
                         ORDER BY t.seq
                        """.formatted(TutorialRepository.EVER_COMPLETED))
                .param("memberId", memberId)
                .query((rs, rowNum) -> {
                    String status = tutorialStatus(rs.getBoolean("unlocked"), rs.getBoolean("ever_completed"),
                            rs.getString("progress_stage"));
                    return new TutorialItem(rs.getInt("seq"), rs.getString("intent"), status,
                            "locked".equals(status) ? null : String.valueOf(rs.getLong("tic_id")),
                            "completed".equals(status) ? rs.getString("completion_reason") : null);
                })
                .list();
    }

    /**
     * 열린 별이면 진행 단계. 분석을 시작하지 않아 진행 행이 없으면 {@code unexplored}다.
     *
     * @return 열리지 않았으면 빈 값
     */
    public Optional<String> findUnlockedStage(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT COALESCE(p.progress_stage, 'unexplored')
                          FROM star_unlocks u
                     LEFT JOIN user_star_progress p ON p.user_id = u.user_id AND p.tic_id = u.tic_id
                         WHERE u.user_id = ? AND u.tic_id = ?
                        """)
                .params(memberId, ticId).query(String.class).optional();
    }

    /**
     * 대상 별의 모든 공식 신호 스레드에서 유효 공개 분석을 가진 회원 수(D-13, COM-14 (1)의 N).
     *
     * <p>유효 공개 분석은 본인이 취소하지 않았고, 개별 숨김이 아니며, 상위 스레드가 보이는 것이다
     * (서비스 F16). 여러 신호에 참여해도 한 명이다. 스레드가 없으면 0이다.
     */
    public int countChallengeParticipants(long ticId) {
        return jdbc.sql("""
                        SELECT count(DISTINCT pa.user_id)
                          FROM published_analyses pa
                          JOIN posts thread ON thread.id = pa.post_id
                         WHERE thread.tic_id = ? AND thread.kind = 'system_thread' AND thread.status = 'visible'
                           AND pa.unpublished_at IS NULL AND pa.hidden_at IS NULL
                        """)
                .param(ticId).query(Integer.class).single();
    }

    /**
     * 다시 열린 별. 재개 뒤 새 제출이 없는 별만이다. 내 별 목록(4.4절)의 {@code reopened}와 같은 조건이다.
     *
     * <p>최근에 다시 열린 순서다.
     */
    public List<Reopened> findReopened(long memberId) {
        return jdbc.sql("""
                        SELECT p.tic_id, p.reopened_at
                          FROM user_star_progress p
                          JOIN star_unlocks u ON u.user_id = p.user_id AND u.tic_id = p.tic_id
                         WHERE p.user_id = ? AND p.reopened_at IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM submissions s
                                            WHERE s.user_id = p.user_id AND s.tic_id = p.tic_id
                                              AND s.created_at > p.reopened_at)
                         ORDER BY p.reopened_at DESC, p.tic_id
                        """)
                .param(memberId)
                .query((rs, rowNum) -> new Reopened(String.valueOf(rs.getLong("tic_id")),
                        rs.getObject("reopened_at", OffsetDateTime.class), null))
                .list();
    }

    static String tutorialStatus(boolean unlocked, boolean everCompleted, String progressStage) {
        if (!unlocked) {
            return "locked";
        }
        if (everCompleted) {
            return "completed";
        }
        return "in_progress".equals(progressStage) ? "in_progress" : "unlocked";
    }
}
