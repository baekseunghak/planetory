package com.planetory.backend.domain.exploration.command;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.command.CorrectionViews.CandidateImpact;
import com.planetory.backend.domain.exploration.command.CorrectionViews.Kind;
import com.planetory.backend.domain.exploration.command.CorrectionViews.Precheck;

/**
 * 후보 정정 영향 사전검사 [S15P21C206-154].
 *
 * <p>계약(docs/architecture/candidate-correction-contract.md) 5.2절의 dry-run이다. <b>아무것도
 * 바꾸지 않는다.</b> 계약 4장의 미확정 항목이 승인되기 전까지 회원 데이터를 고치는 경로는 만들지
 * 않으므로(티켓 차단 조건), 이 클래스가 C19에서 먼저 쓸 수 있는 전부다.
 *
 * <p>모든 질의를 <b>한 스냅샷에서</b> 읽는다. 기본 격리 수준(READ COMMITTED)은 문장마다 새 스냅샷을
 * 잡으므로, 후보별 건수와 충돌 회원 수를 따로 읽는 사이에 성과가 등록되면 "성과 0건인데 별은 1개"
 * 같은 앞뒤가 안 맞는 보고가 나온다. 그래서 {@code REPEATABLE_READ}를 건다 [S15P21C206-154 리뷰].
 */
@Service
@RequiredArgsConstructor
public class CandidateCorrectionPrecheck {

    private final JdbcClient jdbc;

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Precheck check(Kind kind, List<Long> candidateIds, Long keepId) {
        List<CandidateImpact> impacts = impacts(candidateIds);
        List<String> rejections = new ArrayList<>();
        List<String> approvals = new ArrayList<>();

        // 없는 후보를 세서 나온 0건과 진짜 0건은 다르다. 앞의 것은 대상을 잘못 준 것이라 거절한다.
        Set<Long> found = impacts.stream().map(CandidateImpact::candidateId).collect(Collectors.toSet());
        List<Long> missing = candidateIds.stream().filter(id -> !found.contains(id)).toList();
        if (!missing.isEmpty()) {
            rejections.add("없는 후보입니다: " + missing);
        }

        // 같은 별의 신호끼리만 합치고 가른다. 별이 다르면 정정이 아니라 잘못 고른 대상이다.
        if (impacts.stream().map(CandidateImpact::ticId).distinct().count() > 1) {
            rejections.add("대상 후보가 서로 다른 별에 있습니다: "
                    + impacts.stream().map(i -> i.candidateId() + "(TIC " + i.ticId() + ")").toList());
        }

        int conflicting = kind == Kind.MERGE ? conflictingMembers(candidateIds) : 0;
        if (kind == Kind.MERGE) {
            checkMerge(candidateIds, keepId, impacts, conflicting, rejections, approvals);
        } else {
            checkSplit(candidateIds, impacts, rejections);
        }
        return new Precheck(kind, candidateIds, keepId, impacts, conflicting,
                List.copyOf(rejections), List.copyOf(approvals));
    }

    /**
     * 병합은 대표 한쪽의 id를 재사용한다(계약 3.3). 회원 데이터가 걸려 있어도 거절하지 않는다.
     * 계약 3.2의 기본값이 보존이라 Gold 쪽만 바꾸면 되기 때문이다. 다만 승인 없이 회원 쪽을
     * 건드리지 못하도록 걸린 것을 모두 적어 둔다.
     */
    private void checkMerge(List<Long> candidateIds, Long keepId, List<CandidateImpact> impacts,
                            int conflicting, List<String> rejections, List<String> approvals) {
        if (candidateIds.size() < 2) {
            rejections.add("병합 대상은 둘 이상이어야 합니다: " + candidateIds);
        }
        if (keepId == null) {
            rejections.add("대표로 남길 후보를 지정해야 합니다(계약 3.3, C18-Q1).");
        } else if (!candidateIds.contains(keepId)) {
            rejections.add("대표 후보 " + keepId + "가 병합 대상에 없습니다: " + candidateIds);
        } else {
            // 이미 은퇴한 후보를 대표로 삼으면 병합 결과가 처음부터 은퇴 상태가 된다. 조회는 허용하되
            // 적용 대상으로는 받지 않는다 [S15P21C206-154 리뷰].
            impacts.stream()
                    .filter(impact -> impact.candidateId() == keepId && !"active".equals(impact.status()))
                    .forEach(impact -> rejections.add("대표 후보 " + keepId + "는 이미 '" + impact.status()
                            + "' 상태라 새 병합의 대표로 쓸 수 없습니다."));
        }

        impacts.stream().filter(CandidateImpact::touchesMembers).forEach(impact ->
                approvals.add("후보 " + impact.candidateId() + "에 성과 " + impact.achievements()
                        + "건, 공개 분석 " + impact.publishedAnalyses() + "건(유효 "
                        + impact.activePublishedAnalyses() + "), 공식 스레드 " + impact.officialThreads()
                        + "개가 걸려 있습니다. 계약 3.2의 기본값은 보존입니다."));

        if (conflicting > 0) {
            approvals.add("병합 대상 둘 이상에 성과를 가진 회원이 " + conflicting + "명입니다. "
                    + "계약 S3 때문에 이 회원들의 성과는 C18-Q2를 어떻게 정하더라도 한 후보로 모을 수 없습니다.");
        }
        long threads = impacts.stream().filter(i -> i.officialThreads() > 0).count();
        if (threads > 1) {
            approvals.add("대상 중 " + threads + "개가 공식 스레드를 갖고 있습니다. "
                    + "계약 S2 때문에 둘을 한 후보로 모을 수 없습니다(C18-Q4).");
        }
    }

    /**
     * 분리는 계약 3.4를 따른다. A의 성과가 B 것인지 C 것인지는 DB만으로 답할 수 없으므로,
     * 회원 데이터가 하나라도 걸려 있으면 여기서 막는다. 걸린 것이 없으면 새 판 적재의 일반
     * 경로라 별도 정정 작업이 아니다.
     */
    private void checkSplit(List<Long> candidateIds, List<CandidateImpact> impacts, List<String> rejections) {
        if (candidateIds.size() != 1) {
            rejections.add("분리 대상은 하나여야 합니다: " + candidateIds);
        }
        impacts.stream().filter(CandidateImpact::touchesMembers).forEach(impact ->
                rejections.add("후보 " + impact.candidateId() + "에 성과 " + impact.achievements()
                        + "건, 공개 분석 " + impact.publishedAnalyses() + "건, 공식 스레드 "
                        + impact.officialThreads() + "개가 있어 분리할 수 없습니다(계약 3.4). "
                        + "어느 산물로 옮겨도 성과를 줄이거나 복제하거나 임의 결정이 됩니다."));
    }

    /**
     * 사전검사에 필요한 테이블 중 없는 것. 읽기 전용 명령은 Flyway를 끄고 뜨므로(기동 코드) 스키마가
     * 최신이 아니면 조용히 SQL 오류로 끝난다. 그 전에 무엇이 없는지 이름으로 알려 준다.
     */
    @Transactional(readOnly = true)
    public List<String> missingTables() {
        List<String> required = List.of("candidates", "user_candidate_achievements", "star_unlocks",
                "published_analyses", "posts", "submissions");
        List<String> present = jdbc.sql("""
                        SELECT table_name FROM information_schema.tables
                         WHERE table_schema = current_schema() AND table_name IN (:names)
                        """)
                .param("names", required)
                .query(String.class)
                .list();
        return required.stream().filter(name -> !present.contains(name)).toList();
    }

    /** 계약 5.2절의 건수. 후보마다 한 행이며 없는 후보는 행이 없다. */
    private List<CandidateImpact> impacts(List<Long> candidateIds) {
        if (candidateIds.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("""
                        SELECT c.id, c.tic_id, c.status,
                               (SELECT count(*) FROM user_candidate_achievements a
                                 WHERE a.candidate_id = c.id) AS achievements,
                               (SELECT count(*) FROM star_unlocks u
                                  JOIN user_candidate_achievements a ON a.id = u.trigger_achievement_id
                                 WHERE a.candidate_id = c.id) AS unlocked_stars,
                               -- 회원별 별 열림 기록 건수다. 여러 회원이 같은 별을 열 수 있으므로
                               -- 고유 TIC 수와 다르다 [S15P21C206-154 리뷰].
                               (SELECT count(*) FROM published_analyses p
                                 WHERE p.candidate_id = c.id) AS published_analyses,
                               (SELECT count(*) FROM published_analyses p
                                  JOIN posts t ON t.id = p.post_id
                                 WHERE p.candidate_id = c.id AND p.unpublished_at IS NULL
                                       AND p.hidden_at IS NULL AND t.status = 'visible')
                                 AS active_published_analyses,
                               (SELECT count(*) FROM posts t
                                 WHERE t.candidate_id = c.id AND t.kind = 'system_thread')
                                 AS official_threads,
                               (SELECT count(*) FROM submissions s
                                 WHERE s.matched_candidate_id = c.id) AS submissions
                          FROM candidates c
                         WHERE c.id IN (:ids)
                         ORDER BY c.id
                        """)
                .param("ids", candidateIds)
                .query((rs, rowNum) -> new CandidateImpact(rs.getLong("id"), rs.getLong("tic_id"),
                        rs.getString("status"), rs.getInt("achievements"), rs.getInt("unlocked_stars"),
                        rs.getInt("published_analyses"), rs.getInt("active_published_analyses"),
                        rs.getInt("official_threads"), rs.getInt("submissions")))
                .list();
    }

    /**
     * 병합 대상 둘 이상에 성과를 가진 회원 수. {@code UNIQUE(user_id, candidate_id)} 때문에 이
     * 회원들의 성과를 한 후보로 모으면 행이 줄고 등급이 내려간다(계약 S3).
     */
    private int conflictingMembers(List<Long> candidateIds) {
        if (candidateIds.size() < 2) {
            return 0;
        }
        return jdbc.sql("""
                        SELECT count(*) FROM (
                            SELECT user_id FROM user_candidate_achievements
                             WHERE candidate_id IN (:ids)
                             GROUP BY user_id HAVING count(*) > 1) AS conflicting
                        """)
                .param("ids", candidateIds)
                .query(Integer.class)
                .single();
    }
}
