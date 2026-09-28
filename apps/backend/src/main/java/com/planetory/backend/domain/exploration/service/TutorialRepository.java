package com.planetory.backend.domain.exploration.service;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * 튜토리얼 순번·챌린지 회차·튜토리얼 완료 판정 [S15P21C206-139].
 *
 * <p>{@code tutorial_stars}와 {@code challenge_rounds}는 운영자가 DB에서 설정한다(OPS-07).
 * 앱은 읽기만 한다.
 */
@Repository
@RequiredArgsConstructor
public class TutorialRepository {

    /** 튜토리얼 별 수. 다섯 개를 모두 끝내야 챌린지 별을 받는다(HOME-06, POL-24). */
    public static final int TUTORIAL_STAR_COUNT = 5;

    /**
     * 튜토리얼 별을 완료한 적이 있는지 가리는 조건. 진행 행의 별칭은 {@code p}여야 한다.
     *
     * <p>한 번 완료하면 유지한다. 새 판에 후보가 생겨 별이 재개되면 진행 단계는 in_progress로
     * 돌아가지만 {@code completed_at}은 남는다(탐사 API 9.3절). 진행 단계만 보면 튜토리얼 완료와
     * 챌린지 자격이 풀리는데, 이미 받은 챌린지 별은 닫히지 않아 둘이 어긋난다.
     */
    static final String EVER_COMPLETED = "(p.progress_stage = 'completed' OR p.completed_at IS NOT NULL)";

    private final JdbcClient jdbc;

    /**
     * 진행 중인 회차. 부분 유일 인덱스로 하나만 있다(V5).
     *
     * @param targetTicIds 대상 별 전부(V30 {@code challenge_round_targets}). 대표 대상이 맨 앞이고 나머지는 TIC 오름차순이다
     */
    public record ChallengeRound(long id, int roundNo, LocalDate startsOn, LocalDate endsOn,
                                 List<Long> targetTicIds, String description) {

        /** 대표 대상({@code challenge_rounds.target_tic_id}). */
        public long primaryTicId() {
            return targetTicIds.getFirst();
        }
    }

    /** 사용 중인 튜토리얼 n번 별. */
    public Optional<Long> findActiveTicId(int seq) {
        return jdbc.sql("SELECT tic_id FROM tutorial_stars WHERE seq = ? AND active")
                .param(seq).query(Long.class).optional();
    }

    /** 이 별이 사용 중인 튜토리얼이면 순번. */
    public Optional<Integer> findActiveSeq(long ticId) {
        return jdbc.sql("SELECT seq FROM tutorial_stars WHERE tic_id = ? AND active")
                .param(ticId).query(Integer.class).optional();
    }

    /**
     * 이 별을 완료한 적이 있는지({@link #EVER_COMPLETED}). 완료 사유(all_found·undiscoverable_only·skipped)는
     * 가리지 않는다.
     */
    public boolean isCompleted(long memberId, long ticId) {
        return jdbc.sql("""
                        SELECT EXISTS(SELECT 1 FROM user_star_progress p
                                       WHERE p.user_id = ? AND p.tic_id = ? AND %s)
                        """.formatted(EVER_COMPLETED))
                .params(memberId, ticId).query(Boolean.class).single();
    }

    /**
     * 완료한 적이 있는 튜토리얼 수({@link #EVER_COMPLETED}). 퀘스트 패널의 {@code completedCount}다.
     *
     * <p>사용 중인 튜토리얼 별만 센다. 운영 중에 튜토리얼 별을 바꾸지 않는다는 전제다
     * (S15P21C206-139). 바꾸면 이미 끝낸 회원이 미완료로 돌아간다.
     */
    public int countCompleted(long memberId) {
        return jdbc.sql("""
                        SELECT count(*) FROM tutorial_stars t
                          JOIN user_star_progress p ON p.tic_id = t.tic_id
                         WHERE t.active AND p.user_id = ? AND %s
                        """.formatted(EVER_COMPLETED))
                .param(memberId).query(Integer.class).single();
    }

    /**
     * 튜토리얼을 모두 끝냈는지. {@code GET /me}의 {@code tutorialCompleted}, 챌린지 자격,
     * 서비스 {@code GET /challenges/current}의 {@code eligible}이 모두 이 판정을 쓴다(11.1절).
     */
    public boolean isTutorialCompleted(long memberId) {
        return countCompleted(memberId) == TUTORIAL_STAR_COUNT;
    }

    public Optional<ChallengeRound> findActiveRound() {
        return jdbc.sql("""
                        SELECT r.id, r.round_no, r.starts_on, r.ends_on, r.description,
                               ARRAY(SELECT t.tic_id FROM challenge_round_targets t WHERE t.round_id = r.id
                                      ORDER BY t.is_primary DESC, t.tic_id) AS target_tic_ids
                          FROM challenge_rounds r WHERE r.status = 'active'
                        """)
                .query((rs, rowNum) -> new ChallengeRound(rs.getLong("id"), rs.getInt("round_no"),
                        rs.getObject("starts_on", LocalDate.class), rs.getObject("ends_on", LocalDate.class),
                        List.of((Long[]) rs.getArray("target_tic_ids").getArray()), rs.getString("description")))
                .optional();
    }

    public boolean isActiveRound(long roundId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM challenge_rounds WHERE id = ? AND status = 'active')")
                .param(roundId).query(Boolean.class).single();
    }

    /**
     * 회원 행을 잠그고 활동 중인지 본다. 챌린지 일괄 발견이 회원마다 처음 잡는 잠금이다.
     *
     * @return 탈퇴했거나 없는 회원이면 false
     */
    public boolean lockActiveMember(long memberId) {
        return jdbc.sql("SELECT status = 'active' FROM users WHERE id = ? FOR UPDATE")
                .param(memberId).query(Boolean.class).optional().orElse(false);
    }

    /**
     * 회차 대상 별 가운데 하나라도 아직 받지 않은, 튜토리얼을 끝낸 활동 회원. 회원 ID 오름차순 한 묶음이다.
     *
     * <p>완료 조건은 {@link #countCompleted}와 같은 식이다. 판정 시점의 목록일 뿐이라 호출자가
     * 회원을 잠근 뒤 다시 확인한다.
     */
    public List<Long> findMembersToUnlock(long roundId, long afterMemberId, int limit) {
        return jdbc.sql("""
                        SELECT u.id FROM users u
                         WHERE u.status = 'active' AND u.id > :after
                           AND EXISTS (SELECT 1 FROM challenge_round_targets t
                                        WHERE t.round_id = :round
                                          AND NOT EXISTS (SELECT 1 FROM star_unlocks s
                                                           WHERE s.user_id = u.id AND s.tic_id = t.tic_id))
                           AND (SELECT count(*) FROM tutorial_stars t
                                  JOIN user_star_progress p ON p.tic_id = t.tic_id
                                 WHERE t.active AND p.user_id = u.id AND %s) = :tutorialCount
                         ORDER BY u.id
                         LIMIT :limit
                        """.formatted(EVER_COMPLETED))
                .param("after", afterMemberId)
                .param("round", roundId)
                .param("tutorialCount", TUTORIAL_STAR_COUNT)
                .param("limit", limit)
                .query(Long.class).list();
    }
}
