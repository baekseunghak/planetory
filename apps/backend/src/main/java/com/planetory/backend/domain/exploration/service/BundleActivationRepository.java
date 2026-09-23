package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * 판 전환 후처리가 읽고 쓰는 진행 행과 재개 사건 [S15P21C206-150].
 *
 * <p>후보·완료 판정은 {@link ExplorationCompletionRepository}가 이미 하고 있으므로 여기서
 * 다시 세지 않는다. 두 벌이면 같은 별을 두고 완료 판정과 재개 판정이 다른 답을 낸다.
 */
@Repository
@RequiredArgsConstructor
public class BundleActivationRepository {

    private final JdbcClient jdbc;
    private final com.planetory.backend.domain.member.service.NotificationService notifications;

    /** 후처리 대상 회원 한 명. 진행 단계로 할 일이 갈린다. */
    public record ProgressRow(long memberId, String stage) {
    }

    /**
     * 전환된 판의 별. <b>현재 판일 때만</b> 답한다.
     *
     * <p>알림은 늦게 오거나 다시 올 수 있다(10장). 그 사이 또 다른 판이 current가 됐다면 이
     * 알림은 지나간 판의 것이므로 후처리하지 않는다. 지난 판 기준으로 재개를 판정하면 이미
     * 매칭한 후보를 다시 미매칭으로 보게 된다.
     */
    public Optional<Long> findCurrentBundleTic(long bundleId) {
        return jdbc.sql("SELECT tic_id FROM publication_bundles WHERE id = ? AND status = 'current'")
                .param(bundleId).query(Long.class).optional();
    }

    /**
     * 이 별에서 <b>현재 판이 아닌</b> 판. 잔차 캐시 정리 대상이다(10장 4단계 (1)).
     *
     * <p>「현재 판 말고 전부」로 지우지 않고 이 목록으로 지운다. 조회 시점 이후에 current가 된 판은
     * 여기에 없으므로 그 판의 계산이 살아남는다(MR !177 리뷰 P2). 이 조회와 삭제 사이에 새로
     * archived가 된 판은 이번에 못 지우지만, 정리는 다음 전환이 이어서 한다.
     */
    public List<Long> findSupersededBundleIds(long ticId) {
        return jdbc.sql("SELECT id FROM publication_bundles WHERE tic_id = ? AND status <> 'current'")
                .param(ticId).query(Long.class).list();
    }

    /**
     * 이 별에 진행 행이 있는 회원. 미탐사는 후처리할 것이 없어 제외한다.
     *
     * <p>회원 ID 오름차순이라 중간에 멈춰도 다음 실행이 같은 순서로 이어간다.
     */
    public List<ProgressRow> findProgressRows(long ticId) {
        return jdbc.sql("""
                        SELECT p.user_id, p.progress_stage
                          FROM user_star_progress p
                          JOIN users u ON u.id = p.user_id AND u.status = 'active'
                         WHERE p.tic_id = ? AND p.progress_stage IN ('in_progress', 'completed')
                         ORDER BY p.user_id
                        """)
                .param(ticId)
                .query((rs, rowNum) -> new ProgressRow(rs.getLong("user_id"), rs.getString("progress_stage")))
                .list();
    }

    /**
     * 완료한 별을 다시 연다(9.3절).
     *
     * <p>{@code completed}인 행만 바꾼다. 같은 판의 후처리를 두 번 실행하면 두 번째에는 이미
     * {@code in_progress}라 0행이 되고 재개 사건도 생기지 않는다.
     *
     * <p>{@code completed_at}은 그대로 둔다. 튜토리얼 완료와 챌린지 자격이 그 값으로 유지되므로
     * (4.3절) 재개가 자격을 거둬들이면 안 된다.
     *
     * <p>반면 {@code completion_reason}은 비운다. 다시 연 별에 「탐색 불가만 남음」이 붙어 있으면
     * 진행 단계와 사유가 서로 어긋난 행이 된다. 다시 완료하면 그때의 사유가 새로 들어간다
     * (MR !177 리뷰 참고 의견, 김동혁).
     *
     * @return 바꾼 행 수. 0이면 이미 열려 있었다는 뜻이다
     */
    public int reopen(long memberId, long ticId) {
        return jdbc.sql("""
                        UPDATE user_star_progress
                           SET progress_stage = 'in_progress',
                               completion_reason = NULL,
                               reopen_pending = false,
                               reopened_at = clock_timestamp()
                         WHERE user_id = ? AND tic_id = ? AND progress_stage = 'completed'
                        """)
                .params(memberId, ticId).update();
    }

    /**
     * 재개 사건을 남긴다. 같은 판의 같은 별은 한 번만 들어간다(V22 부분 유일 인덱스).
     *
     * <p>{@code reason}은 근거가 있을 때만 싣는다. 어느 후보가 새로 생겼고 어느 후보가
     * 탐색 가능으로 바뀌었는지는 {@code candidate_status_history}가 알려 주는데, 그 이력을
     * 남기는 Publisher(S15P21C206-87)가 아직 없다. 없는 사유를 지어내 담지 않는다.
     *
     * @return 새로 남겼으면 1, 이미 있었으면 0
     */
    public int recordReopenEvent(long memberId, long ticId, long bundleId, int newDiscoverableCount,
                                 String reason) {
        var inserted = jdbc.sql("""
                        INSERT INTO notifications (user_id, type, payload)
                        VALUES (?, 'reopen', jsonb_strip_nulls(jsonb_build_object(
                                   'ticId', ?::text,
                                   'bundleId', ?::text,
                                   'newDiscoverableCount', ?::int,
                                   'reason', ?::text)))
                        ON CONFLICT DO NOTHING
                        RETURNING id
                        """)
                .params(memberId, String.valueOf(ticId), String.valueOf(bundleId), newDiscoverableCount, reason)
                .query(Long.class).optional();
        if (inserted.isEmpty()) return 0;
        var payload = new java.util.LinkedHashMap<String, Object>();
        payload.put("ticId", String.valueOf(ticId));
        payload.put("bundleId", String.valueOf(bundleId));
        payload.put("newDiscoverableCount", newDiscoverableCount);
        if (reason != null) payload.put("reason", reason);
        notifications.record(memberId, "reopen", "reopen:" + ticId + ":" + bundleId, payload, inserted.get());
        return 1;
    }

    /**
     * 외부 라벨 갱신 표식 (9.5절, GRD-06).
     *
     * <p>바뀐 것을 {@code candidate_status_history}가 아니라 <b>현재 라벨과 성과 유형의 차이</b>로
     * 찾는다. 이력의 {@code field} 값은 아직 정해지지 않았고(후보 정정 계약 5.3은 초안, C19에서 확정)
     * 판정 변경을 어떤 이름으로 남길지 약속한 곳이 없다. 반면 {@code candidate_dispositions.disposition}과
     * {@code achievement_type}은 둘 다 CHECK로 고정된 값이라 지어낼 것이 없다. 성과 유형은 인정 시점의
     * 라벨에서 정해지므로(9.2절) 지금 값과 다르다는 것은 그 뒤에 라벨이 바뀌었다는 뜻이다.
     *
     * <p>{@code pc ↔ none}은 표식을 만들지 않는다. 둘 다 미확정으로 보이므로(6.4절
     * {@code signal.disposition}) 회원에게 달라진 것이 없다.
     *
     * <p><b>라벨이 원래 값으로 돌아오면 표식을 지운다.</b> {@code confirmed → fp → confirmed}처럼
     * 되돌아왔는데 이전 표식이 남으면 화면이 「기록이 갱신됨」을 계속 보여 주고 조회의
     * {@code newDisposition}으로 옛 판정이 나간다(MR !177 리뷰 P2, 백승학). 그래서 이 문장은
     * 표식을 남기기만 하는 것이 아니라 <b>현재 판정에 맞는 값으로 맞춘다</b> — 다르면 채우고
     * 같아지면 비운다.
     *
     * <p>성과 유형·등급·발견 별·통계는 건드리지 않는다. 이 UPDATE가 바꾸는 열은
     * {@code relabeled_at}·{@code relabel_disposition} 둘뿐이다(9.5절, 후보 정정 계약).
     *
     * <p>같은 이력을 다시 받아도 두 번째에는 이미 같은 값이라 0행이다.
     *
     * @return 표식을 새로 남기거나 바꾸거나 지운 성과 수
     */
    public int markRelabeledAchievements(long ticId) {
        return jdbc.sql("""
                        UPDATE user_candidate_achievements a
                           SET relabeled_at = t.marked_at,
                               relabel_disposition = t.marked_disposition
                          FROM (
                              SELECT m.id,
                                     CASE WHEN m.relabeled THEN m.applied_at END AS marked_at,
                                     CASE WHEN m.relabeled THEN m.disposition END AS marked_disposition
                                FROM (
                                    SELECT a2.id, d.applied_at, d.disposition,
                                           a2.achievement_type <> CASE d.disposition
                                                                      WHEN 'confirmed' THEN 'confirmed'
                                                                      WHEN 'fp' THEN 'fp'
                                                                      ELSE 'unconfirmed'
                                                                  END AS relabeled
                                      FROM user_candidate_achievements a2
                                      JOIN candidates c ON c.id = a2.candidate_id
                                      JOIN candidate_dispositions d ON d.candidate_id = a2.candidate_id
                                     WHERE c.tic_id = ? AND d.applied_at > a2.recognized_at
                                ) m
                          ) t
                         WHERE a.id = t.id
                           AND (a.relabeled_at IS DISTINCT FROM t.marked_at
                                OR a.relabel_disposition IS DISTINCT FROM t.marked_disposition)
                        """)
                .param(ticId).update();
    }
}
