package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.PublicAnalysisVisibility;

/**
 * 별 결과 페이지 조회 (탐사 API 8.4) [S15P21C206-146].
 *
 * <p>모든 질의가 {@code user_id}로 회원을 가른다. 이 페이지는 <b>회원이 매칭한 신호</b>에서만
 * 출발하므로, 매칭하지 못한 후보는 어떤 질의에서도 결과 집합에 들어오지 않는다(DEC-28).
 */
@Repository
@RequiredArgsConstructor
public class StarResultRepository {

    private final JdbcClient jdbc;

    /** 현재 판. 판이 없으면 빈 값이며 호출자가 null로 내보낸다. */
    public Optional<StarResultViews.Bundle> findCurrentBundle(long ticId) {
        return jdbc.sql("SELECT id, published_at FROM publication_bundles"
                        + " WHERE tic_id = ? AND status = 'current'")
                .param(ticId)
                .query((rs, rowNum) -> new StarResultViews.Bundle(
                        ExplorationIds.bundle(rs.getLong("id")),
                        rs.getObject("published_at", OffsetDateTime.class)))
                .optional();
    }

    /**
     * 매칭한 신호 하나에 필요한 값 전부.
     *
     * @param submittedAnswerClass 제출 당시 저장된 {@code signal.answerClass}. 공개 자격은 지금 라벨이
     *                             아니라 이 값으로 가른다(8.2절 {@code publication.state}와 같은 기준)
     * @param evaluation           제출 당시 저장된 {@code judgment.evaluation}. 옛 기록은 null
     */
    public record SignalRow(
            long candidateId,
            String candidateStatus,
            String disposition,
            String answerClass,
            String planetTruth,
            long latestSubmissionId,
            Long latestHistoryId,
            String matchResult,
            String userJudgment,
            String evaluation,
            String achievementResult,
            String submittedAnswerClass,
            String submittedMatchStatus,
            Integer curveStepAtMatch,
            Long[] submissionIds,
            OffsetDateTime recognizedAt,
            OffsetDateTime relabeledAt,
            String relabelDisposition,
            Long publicAnalysisId,
            boolean isPublic,
            boolean isModerationHidden,
            Long threadId) {
    }

    /**
     * 회원이 이 별에서 매칭한 고유 신호를 <b>처음 맞힌 곡선 단계 순서</b>로 준다.
     *
     * <p>{@code matched_candidate_id}는 매칭 성공(matched·matched_harmonic·duplicate)에만 채워지므로
     * 이 질의만으로 DEC-28이 지켜진다. 같은 신호를 여러 번 제출했으면 <b>한 행</b>으로 모으고
     * 제출 ID를 배열로 싣는다 — 신호 수와 제출 수는 다르다.
     */
    public List<SignalRow> findSignals(long memberId, long ticId) {
        return jdbc.sql("""
                        WITH mine AS (
                            SELECT s.id, s.matched_candidate_id AS candidate_id, s.created_at,
                                   s.match_result, s.user_judgment, s.curve_step, s.achievement_result,
                                   s.response_snapshot #>> '{judgment,evaluation}' AS evaluation,
                                   s.response_snapshot #>> '{signal,answerClass}' AS submitted_answer_class,
                                   s.response_snapshot #>> '{match,status}' AS submitted_match_status
                              FROM submissions s
                             WHERE s.user_id = :memberId AND s.tic_id = :ticId
                               AND s.matched_candidate_id IS NOT NULL
                        ), rolled AS (
                            SELECT candidate_id,
                                   array_agg(id ORDER BY created_at, id) AS submission_ids,
                                   (array_agg(curve_step ORDER BY created_at, id))[1] AS curve_step_at_match
                              FROM mine
                             GROUP BY candidate_id
                        ), latest AS (
                            SELECT DISTINCT ON (candidate_id) *
                              FROM mine
                             ORDER BY candidate_id, created_at DESC, id DESC
                        )
                        SELECT l.candidate_id, c.status AS candidate_status,
                               d.disposition, d.answer_class, d.planet_truth,
                               l.id AS latest_submission_id, l.match_result, l.user_judgment,
                               l.evaluation, l.achievement_result,
                               l.submitted_answer_class, l.submitted_match_status,
                               h.id AS latest_history_id,
                               r.submission_ids, r.curve_step_at_match,
                               a.recognized_at, a.relabeled_at, a.relabel_disposition,
                               pa.id AS public_analysis_id,
                               COALESCE(%s, false) AS is_public,
                               COALESCE(pa.hidden_at IS NOT NULL OR p.status = 'hidden', false) AS is_hidden,
                               t.id AS thread_id
                          FROM latest l
                          JOIN rolled r ON r.candidate_id = l.candidate_id
                          JOIN candidates c ON c.id = l.candidate_id
                     LEFT JOIN candidate_dispositions d ON d.candidate_id = c.id
                     LEFT JOIN analysis_histories h ON h.submission_id = l.id
                     LEFT JOIN user_candidate_achievements a
                            ON a.user_id = :memberId AND a.candidate_id = c.id
                     LEFT JOIN published_analyses pa ON pa.history_id = h.id
                     LEFT JOIN posts p ON p.id = pa.post_id
                     LEFT JOIN posts t ON t.candidate_id = c.id AND t.kind = 'system_thread'
                         ORDER BY r.curve_step_at_match, l.candidate_id
                        """.formatted(PublicAnalysisVisibility.VISIBLE))
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> new SignalRow(
                        rs.getLong("candidate_id"),
                        rs.getString("candidate_status"),
                        rs.getString("disposition"),
                        rs.getString("answer_class"),
                        rs.getString("planet_truth"),
                        rs.getLong("latest_submission_id"),
                        (Long) rs.getObject("latest_history_id"),
                        rs.getString("match_result"),
                        rs.getString("user_judgment"),
                        rs.getString("evaluation"),
                        rs.getString("achievement_result"),
                        rs.getString("submitted_answer_class"),
                        rs.getString("submitted_match_status"),
                        (Integer) rs.getObject("curve_step_at_match"),
                        (Long[]) rs.getArray("submission_ids").getArray(),
                        rs.getObject("recognized_at", OffsetDateTime.class),
                        rs.getObject("relabeled_at", OffsetDateTime.class),
                        rs.getString("relabel_disposition"),
                        (Long) rs.getObject("public_analysis_id"),
                        rs.getBoolean("is_public"),
                        rs.getBoolean("is_hidden"),
                        (Long) rs.getObject("thread_id")))
                .list();
    }

    /**
     * 신호를 맞히지 못한 제출. 무엇을 놓쳤는지는 담지 않는다.
     *
     * <p>{@code skipped}(튜토리얼 건너뛰기)도 매칭하지 못한 제출이므로 여기에 온다. 제출 기록을
     * 빠뜨리면 "신호 수와 제출 수가 다르다"가 화면에서 성립하지 않는다.
     */
    public List<StarResultViews.UnmatchedSubmission> findUnmatchedSubmissions(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT s.id, s.match_result, s.created_at, h.id AS history_id
                          FROM submissions s
                     LEFT JOIN analysis_histories h ON h.submission_id = s.id
                         WHERE s.user_id = :memberId AND s.tic_id = :ticId
                           AND s.matched_candidate_id IS NULL
                         ORDER BY s.created_at DESC, s.id DESC
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> {
                    Long historyId = (Long) rs.getObject("history_id");
                    return new StarResultViews.UnmatchedSubmission(
                            ExplorationIds.submission(rs.getLong("id")),
                            historyId == null ? null : "h-" + historyId,
                            rs.getString("match_result"),
                            rs.getObject("created_at", OffsetDateTime.class));
                })
                .list();
    }

    /** 한 곡선 단계와 그 단계의 잔차 상태를 찾는 데 필요한 문맥. */
    public record StepRow(int curveStep, Long[] removedCandidateIds, long bundleId,
                          String residualModelVersion, String periodogramConfigVersion) {
    }

    /**
     * 회원이 이 별에서 <b>실제로 제출한</b> 곡선 단계.
     *
     * <p>단계마다 마지막 제출의 판·계산 버전을 쓴다. 잔차 캐시 키가 그 셋에 묶여 있어, 옛 제출의
     * 버전으로 찾으면 지금 남아 있는 결과를 놓친다.
     */
    public List<StepRow> findCurveSteps(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT DISTINCT ON (s.curve_step)
                               s.curve_step, s.removed_candidate_ids, s.bundle_id,
                               s.residual_model_version, s.periodogram_config_version
                          FROM submissions s
                         WHERE s.user_id = :memberId AND s.tic_id = :ticId
                         ORDER BY s.curve_step, s.created_at DESC, s.id DESC
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> new StepRow(
                        rs.getInt("curve_step"),
                        (Long[]) rs.getArray("removed_candidate_ids").getArray(),
                        rs.getLong("bundle_id"),
                        rs.getString("residual_model_version"),
                        rs.getString("periodogram_config_version")))
                .list();
    }

    /**
     * 이 별의 성과가 연 주변 별.
     *
     * <p>성과 행을 거쳐야 이 별이 연 것인지 알 수 있다. {@code star_unlocks.trigger_tic_id}만 보면
     * 다른 경로로 열린 별이 섞인다.
     */
    public List<StarResultViews.DiscoveredStar> findDiscoveredStars(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT u.tic_id, u.unlocked_at, u.trigger_achievement_id
                          FROM star_unlocks u
                          JOIN user_candidate_achievements a ON a.id = u.trigger_achievement_id
                          JOIN candidates c ON c.id = a.candidate_id
                         WHERE u.user_id = :memberId AND a.user_id = :memberId
                           AND c.tic_id = :ticId
                         ORDER BY u.unlocked_at, u.tic_id
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query((rs, rowNum) -> new StarResultViews.DiscoveredStar(
                        String.valueOf(rs.getLong("tic_id")),
                        rs.getObject("unlocked_at", OffsetDateTime.class),
                        ExplorationIds.achievement(rs.getLong("trigger_achievement_id"))))
                .list();
    }

    /**
     * 매칭했지만 <b>지금 유효하게 공개되어 있지 않은</b> 신호 수.
     *
     * <p>유효 공개 조건은 {@link PublicAnalysisVisibility#VISIBLE} 하나를 쓴다. 공개 기록의 취소·숨김만
     * 보고 <b>부모 스레드 상태를 빼면</b> 스레드가 숨겨진 뒤 신호 카드는 {@code HIDDEN}인데 이 수는
     * 0이 된다 — 한 응답이 서로 다른 말을 한다(!157 리뷰).
     *
     * <p>{@code progress.stage=completed}와 동시에 0보다 클 수 있다. 그것이 "탐색 완료 / 미게시
     * 분석 있음"이다(RES-10).
     */
    public int countUnpublishedSignals(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT count(DISTINCT s.matched_candidate_id)
                          FROM submissions s
                         WHERE s.user_id = :memberId AND s.tic_id = :ticId
                           AND s.matched_candidate_id IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1 FROM published_analyses pa
                                 JOIN posts p ON p.id = pa.post_id
                                WHERE pa.user_id = s.user_id
                                  AND pa.candidate_id = s.matched_candidate_id
                                  AND %s)
                        """.formatted(PublicAnalysisVisibility.VISIBLE))
                .param("memberId", memberId).param("ticId", ticId)
                .query(Integer.class).single();
    }

    /**
     * 지금 일괄 공개할 수 있는 기록이 있는가(166).
     *
     * <p>미게시 <b>신호</b> 수와 다른 값이다. 같은 신호의 첫 기록을 공개한 뒤 새 적격 기록을 제출하면
     * 신호 수로는 0이지만 일괄 공개 후보는 1건이다. 신호 수로 [모두 게시]를 가르면 그 기록이 화면에서
     * 사라진다(!157 리뷰).
     *
     * <p>조건은 {@code PublicAnalysisBatchService.candidates}의 것을 그대로 옮겼다. 두 곳이 갈리면
     * 버튼과 목록이 다른 말을 하므로 검사로 함께 묶는다.
     */
    public boolean hasBatchPublishCandidate(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT EXISTS(
                            SELECT 1
                              FROM analysis_histories h
                              JOIN submissions s ON s.id = h.submission_id
                              JOIN candidates c ON ('c-' || c.id) = s.response_snapshot #>> '{match,candidateId}'
                                               AND c.tic_id = h.tic_id
                             WHERE h.user_id = :memberId AND s.user_id = :memberId
                               AND h.tic_id = :ticId AND s.tic_id = :ticId
                               AND s.response_snapshot #>> '{signal,answerClass}' = 'analysis'
                               AND s.response_snapshot #>> '{match,status}'
                                   IN ('matched', 'matched_harmonic', 'duplicate')
                               AND NOT EXISTS (SELECT 1 FROM published_analyses pa WHERE pa.history_id = h.id)
                               AND NOT EXISTS (SELECT 1 FROM posts p
                                                WHERE p.kind = 'system_thread' AND p.candidate_id = c.id
                                                  AND p.status <> 'visible'))
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query(Boolean.class).single();
    }

    /**
     * 다시 풀 수 있는 제출이 하나라도 있는가.
     *
     * <p>6.8절 초안은 저장된 당시 응답에서 만들고, 그 제출이 매칭한 후보가 <b>은퇴했으면 409</b>다.
     * 저장 응답만 보고 권하면 눌렀을 때 {@code CANDIDATE_RETIRED}가 되는 행동을 힌트로 주게 된다
     * (!157 리뷰). 조건은 {@code SubmissionLookupService.requireLivingTarget}과 같다.
     */
    public boolean hasRestorableSubmission(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT EXISTS(
                            SELECT 1 FROM submissions s
                             WHERE s.user_id = :memberId AND s.tic_id = :ticId
                               AND s.response_snapshot IS NOT NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM candidates c
                                    WHERE ('c-' || c.id) = s.response_snapshot #>> '{match,candidateId}'
                                      AND c.tic_id = s.tic_id
                                      AND c.status = 'retired'))
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .query(Boolean.class).single();
    }
}
