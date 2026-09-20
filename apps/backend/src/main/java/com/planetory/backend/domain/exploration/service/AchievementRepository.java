package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementItem;
import com.planetory.backend.domain.exploration.service.AchievementViews.Relabel;
import com.planetory.backend.domain.exploration.service.AchievementViews.UnlockedStar;

/** 성과 인정·별 열림·성과 조회 (탐사 API 9.1·9.2절) [S15P21C206-144]. */
@Repository
@RequiredArgsConstructor
public class AchievementRepository {

    private final JdbcClient jdbc;

    /** 인정 근거 제출. 매칭하지 못한 제출이면 {@code matchedCandidateId}가 null이다. */
    record SubmissionBasis(long memberId, Long matchedCandidateId) {
    }

    /** 인정 근거 공개 분석. */
    record AnalysisBasis(long memberId, long candidateId) {
    }

    /** 회원 행을 잠근다. 같은 회원의 발견·제출·공개가 이 잠금으로 줄을 선다(9.2절 1단계). */
    void lockMember(long memberId) {
        jdbc.sql("SELECT id FROM users WHERE id = ? FOR UPDATE").param(memberId).query(Long.class).single();
    }

    OptionalLong findCandidateTic(long candidateId) {
        return jdbc.sql("SELECT tic_id FROM candidates WHERE id = ?").param(candidateId)
                .query(Long.class).optional()
                .map(OptionalLong::of).orElseGet(OptionalLong::empty);
    }

    Optional<SubmissionBasis> findSubmissionBasis(long submissionId) {
        return jdbc.sql("SELECT user_id, matched_candidate_id FROM submissions WHERE id = ?")
                .param(submissionId)
                .query((rs, rowNum) -> new SubmissionBasis(rs.getLong("user_id"),
                        rs.getObject("matched_candidate_id", Long.class)))
                .optional();
    }

    Optional<AnalysisBasis> findAnalysisBasis(long analysisId) {
        return jdbc.sql("SELECT user_id, candidate_id FROM published_analyses WHERE id = ?")
                .param(analysisId)
                .query((rs, rowNum) -> new AnalysisBasis(rs.getLong("user_id"), rs.getLong("candidate_id")))
                .optional();
    }

    /**
     * 이 별의 진행 행을 잠근다. 잠금 순서 {@code users → user_star_progress → user_candidate_achievements
     * → star_unlocks}의 두 번째다.
     *
     * @return 진행 행이 없으면(발견하지 않은 별) false
     */
    boolean lockProgress(long memberId, long ticId) {
        return jdbc.sql("SELECT 1 FROM user_star_progress WHERE user_id = ? AND tic_id = ? FOR UPDATE")
                .params(memberId, ticId).query(Integer.class).optional().isPresent();
    }

    /**
     * 성과 행을 넣는다(9.2절 2단계).
     *
     * @return 새 성과 id. 이미 인정된 신호면 빈 값
     */
    OptionalLong insertAchievement(long memberId, long candidateId, String type, long submissionId,
                                   Long analysisId) {
        return jdbc.sql("""
                        INSERT INTO user_candidate_achievements(user_id, candidate_id, achievement_type,
                            recognized_submission_id, recognized_analysis_id, recognized_at)
                        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT (user_id, candidate_id) DO NOTHING
                        RETURNING id
                        """)
                .params(memberId, candidateId, type, submissionId, analysisId)
                .query(Long.class).optional()
                .map(OptionalLong::of).orElseGet(OptionalLong::empty);
    }

    long findAchievementId(long memberId, long candidateId) {
        return jdbc.sql("SELECT id FROM user_candidate_achievements WHERE user_id = ? AND candidate_id = ?")
                .params(memberId, candidateId).query(Long.class).single();
    }

    /** 이 공개가 실제 성과 인정 근거인 경우에만 저장된 별을 복구한다. */
    List<SubmissionViews.UnlockedStar> findPublicationStars(long memberId, long analysisId) {
        return jdbc.sql("""
                SELECT u.tic_id, u.world_x, u.world_y, u.depth_z, u.layout_version
                FROM user_candidate_achievements a
                JOIN star_unlocks u ON u.trigger_achievement_id = a.id AND u.user_id = a.user_id
                WHERE a.user_id = ? AND a.recognized_analysis_id = ?
                ORDER BY u.seq
                """).params(memberId, analysisId).query((r, n) -> new SubmissionViews.UnlockedStar(
                        Long.toString(r.getLong("tic_id")), new GalaxyLayout.StarPosition(
                        r.getDouble("world_x"), r.getDouble("world_y"), r.getDouble("depth_z"),
                        r.getString("layout_version")))).list();
    }

    /** 성과 수를 올리고 FP 성과면 이력 값을 켠다(9.2절 3단계). 한 번 켠 {@code fp_success}는 끄지 않는다. */
    void countAchievement(long memberId, long ticId, boolean fp) {
        int updated = jdbc.sql("""
                        UPDATE user_star_progress
                           SET achievement_count = achievement_count + 1, fp_success = fp_success OR ?
                         WHERE user_id = ? AND tic_id = ?
                        """)
                .params(fp, memberId, ticId).update();
        if (updated != 1) {
            throw new IllegalStateException("진행 행을 잠근 뒤 사라졌습니다: user " + memberId + ", tic " + ticId);
        }
    }

    /**
     * 회원이 아직 못 찾은 별 하나를 시드로 고른다(9.2절 4단계, 시드 정책 {@code hash-user-achievement-seq-v1}).
     *
     * <p>후보를 TIC 오름차순으로 세우고 {@code seed mod 후보 수}번째(0부터)를 고른다. 후보 수와 고르기를
     * 한 문장에서 한다. 문장 단위 스냅샷이라 둘 사이에 후보가 바뀌어도 어긋나지 않는다.
     *
     * <p>제외 규칙은 OPS-08이다. 공개되지 않은 별, 이미 발견한 별, 운영 중인 튜토리얼 별, 진행 중인
     * 챌린지 회차의 대상 별을 뺀다. 예정·종료 회차의 대상은 뺄 이유가 없어 후보에 남는다.
     *
     * @param seed 부호 없는 64비트 값
     * @return 후보가 없으면 빈 값
     */
    OptionalLong pickUndiscoveredStar(long memberId, BigInteger seed) {
        return jdbc.sql("""
                        WITH pool AS (
                            SELECT s.tic_id
                              FROM stars s
                             WHERE s.service_status = 'published'
                               AND NOT EXISTS (SELECT 1 FROM star_unlocks u
                                                WHERE u.user_id = :memberId AND u.tic_id = s.tic_id)
                               AND NOT EXISTS (SELECT 1 FROM tutorial_stars t
                                                WHERE t.active AND t.tic_id = s.tic_id)
                               AND NOT EXISTS (SELECT 1 FROM challenge_rounds r
                                                WHERE r.status = 'active' AND r.target_tic_id = s.tic_id)
                        )
                        SELECT tic_id
                          FROM pool
                         ORDER BY tic_id
                        OFFSET (SELECT CAST(CAST(:seed AS NUMERIC) % NULLIF(count(*), 0) AS BIGINT) FROM pool)
                         LIMIT 1
                        """)
                .param("memberId", memberId)
                .param("seed", new BigDecimal(seed))
                .query(Long.class).optional()
                .map(OptionalLong::of).orElseGet(OptionalLong::empty);
    }

    /**
     * 성과 목록 한 페이지(9.1절). {@code recognizedAt} 내림차순이고 동률은 성과 id 내림차순이다.
     *
     * @param ticId         필터 TIC. null이면 전체
     * @param afterAt       이어읽기 기준 시각. 첫 페이지는 null
     * @param limit         한 건 더 요청해 다음 페이지 유무를 판단한다
     */
    List<AchievementItem> findPage(long memberId, Long ticId, OffsetDateTime afterAt, Long afterId, int limit) {
        return jdbc.sql("""
                        SELECT a.id, c.tic_id, a.candidate_id, a.achievement_type, a.recognized_submission_id,
                               a.recognized_analysis_id, a.recognized_at, a.relabeled_at, a.relabel_disposition,
                               ARRAY(SELECT u.tic_id FROM star_unlocks u
                                      WHERE u.trigger_achievement_id = a.id ORDER BY u.seq) AS unlocked_tic_ids
                          FROM user_candidate_achievements a
                          JOIN candidates c ON c.id = a.candidate_id
                         WHERE a.user_id = :memberId
                           AND (CAST(:ticId AS BIGINT) IS NULL OR c.tic_id = :ticId)
                           AND (CAST(:afterAt AS TIMESTAMPTZ) IS NULL
                                OR (a.recognized_at, a.id) < (CAST(:afterAt AS TIMESTAMPTZ), CAST(:afterId AS BIGINT)))
                         ORDER BY a.recognized_at DESC, a.id DESC
                         LIMIT :limit
                        """)
                .param("memberId", memberId)
                .param("ticId", ticId)
                .param("afterAt", afterAt)
                .param("afterId", afterId)
                .param("limit", limit)
                .query(AchievementRepository::toItem)
                .list();
    }

    private static AchievementItem toItem(ResultSet rs, int rowNum) throws SQLException {
        Long analysisId = rs.getObject("recognized_analysis_id", Long.class);
        OffsetDateTime relabeledAt = rs.getObject("relabeled_at", OffsetDateTime.class);
        Long[] unlocked = (Long[]) rs.getArray("unlocked_tic_ids").getArray();
        return new AchievementItem(
                ExplorationIds.achievement(rs.getLong("id")),
                String.valueOf(rs.getLong("tic_id")),
                ExplorationIds.candidate(rs.getLong("candidate_id")),
                rs.getString("achievement_type"),
                ExplorationIds.submission(rs.getLong("recognized_submission_id")),
                analysisId == null ? null : ExplorationIds.publicAnalysis(analysisId),
                rs.getObject("recognized_at", OffsetDateTime.class),
                relabeledAt == null ? null
                        : new Relabel(relabeledAt, apiDisposition(rs.getString("relabel_disposition"))),
                Arrays.stream(unlocked).map(tic -> new UnlockedStar(String.valueOf(tic))).toList());
    }

    /**
     * DB 판정 분류({@code candidate_dispositions.disposition})를 API 값으로 바꾼다. 6.4절
     * {@code signal.disposition}과 같은 값이다. PC와 판정 없음은 분석형이라 미확정으로 보인다.
     */
    static String apiDisposition(String disposition) {
        return switch (disposition) {
            case "confirmed" -> "CONFIRMED";
            case "fp" -> "FP";
            case "pc", "none" -> "UNCONFIRMED";
            case null, default -> throw new IllegalStateException("알 수 없는 판정 분류: " + disposition);
        };
    }
}
