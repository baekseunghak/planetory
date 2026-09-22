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
     * @return 바꾼 행 수. 0이면 이미 열려 있었다는 뜻이다
     */
    public int reopen(long memberId, long ticId) {
        return jdbc.sql("""
                        UPDATE user_star_progress
                           SET progress_stage = 'in_progress',
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
        return jdbc.sql("""
                        INSERT INTO notifications (user_id, type, payload)
                        VALUES (?, 'reopen', jsonb_strip_nulls(jsonb_build_object(
                                   'ticId', ?::text,
                                   'bundleId', ?::text,
                                   'newDiscoverableCount', ?::int,
                                   'reason', ?::text)))
                        ON CONFLICT DO NOTHING
                        """)
                .params(memberId, String.valueOf(ticId), String.valueOf(bundleId), newDiscoverableCount, reason)
                .update();
    }
}
