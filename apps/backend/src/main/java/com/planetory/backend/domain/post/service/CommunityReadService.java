package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.StarBoardVisibility;
import com.planetory.backend.domain.PublicAnalysisVisibility;
import com.planetory.backend.domain.comment.service.CommentService;
import com.planetory.backend.domain.exploration.service.HistoryService;
import com.planetory.backend.domain.exploration.service.HistoryViews;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.SubmissionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.member.service.FollowTokens;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** 커뮤니티 조회 조립. 그래프·개인 History·판단 통계의 소유권은 기존 탐사 서비스에 둔다. */
@Service
@RequiredArgsConstructor
public class CommunityReadService {
    private final JdbcClient jdbc;
    private final MemberService members;
    private final StarService stars;
    private final SubmissionService submissions;
    private final CommentService comments;
    private final HistoryService histories;
    private final PublicAnalysisAccess publicAccess;
    private final FollowTokens followTokens;

    private static final Map<String, String> SYSTEM = Map.of("type", "SYSTEM", "displayName", "SYSTEM");
    private static final String OPEN_BOARD = "(p.tic_id IS NULL OR " + StarBoardVisibility.OPEN.formatted("p.tic_id") + ")";

    public record FeedItem(String type, String id, String ticId, String title, Object author,
                           long commentCount, Map<String, Object> judgmentSummary, OffsetDateTime createdAt) {}
    public record Feed(List<FeedItem> items, String nextCursor, boolean hasNext) {}
    public record FollowingItem(String type, String id, String ticId, String title, Object author,
                                long commentCount, Map<String, Object> judgmentSummary, OffsetDateTime createdAt,
                                List<String> matchedBy) {}
    public record FollowingFeed(List<FollowingItem> items, String nextCursor, boolean hasNext) {}
    private record FollowingRow(FeedRow post, int order, boolean member, boolean star) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public FollowingFeed following(long member, FollowTokens.Page q) {
        members.requireActive(member);
        var rows = jdbc.sql("""
                WITH matching AS (
                    SELECT p.id,p.kind,p.tic_id,p.candidate_id,p.title,p.user_id,u.nickname,p.created_at,
                        CASE WHEN p.kind='user' THEN 0 ELSE 1 END AS kind_order,
                        (p.kind='user' AND u.status='active' AND EXISTS (SELECT 1 FROM follows f
                            WHERE f.user_id=:member AND f.target_type='user' AND f.target_id=p.user_id
                            AND f.target_id<>:member)) AS by_member,
                        EXISTS (SELECT 1 FROM follows f WHERE f.user_id=:member
                            AND f.target_type='star' AND f.target_id=p.tic_id) AS by_star
                    FROM posts p LEFT JOIN users u ON u.id=p.user_id
                    WHERE p.status='visible' AND %s AND (p.kind='system_thread' OR u.status='active')
                )
                SELECT m.*,(SELECT count(*) FROM comments c WHERE c.post_id=m.id AND c.status='visible') AS comments
                FROM matching m WHERE (by_member OR by_star)
                    AND (CAST(:at AS TIMESTAMPTZ) IS NULL OR created_at<:at
                        OR (created_at=:at AND (kind_order>:kind OR (kind_order=:kind AND id<:id))))
                ORDER BY created_at DESC,kind_order ASC,id DESC LIMIT :limit
                """.formatted(OPEN_BOARD))
                .param("member", member).param("at", q.at()).param("kind", q.kind()).param("id", q.id()).param("limit", q.size()+1)
                .query((r, n) -> new FollowingRow(new FeedRow(r.getLong("id"), r.getString("kind"), r.getString("tic_id"),
                        r.getObject("candidate_id", Long.class), r.getString("title"),
                        "system_thread".equals(r.getString("kind")) ? SYSTEM : new PostService.Author("u-" + r.getLong("user_id"), r.getString("nickname")),
                        r.getLong("comments"), r.getObject("created_at", OffsetDateTime.class)),
                        r.getInt("kind_order"), r.getBoolean("by_member"), r.getBoolean("by_star"))).list();
        boolean more = rows.size()>q.size();
        var page = rows.subList(0, Math.min(rows.size(),q.size()));
        // ponytail: 최대 100개 단건 판단 요약. 후보별 일괄 계약이 제공되면 기존 피드와 함께 교체한다.
        var items = page.stream().map(r -> {
            var p = r.post();
            return new FollowingItem(r.order()==0 ? "POST" : "SIGNAL_THREAD", (r.order()==0 ? "p-" : "st-")+p.id(),
                    p.tic(),p.title(),p.author(),p.comments(),p.candidate()==null ? null : submissions.publicJudgmentSummary(p.candidate()),
                    p.at(),r.member() ? (r.star() ? List.of("MEMBER","STAR") : List.of("MEMBER")) : List.of("STAR"));
        }).toList();
        var last = page.isEmpty() ? null : page.getLast();
        return new FollowingFeed(items,more ? followTokens.next(q,last.post().at(),last.order(),last.post().id()) : null,more);
    }
    public record Signal(BigDecimal periodDays, BigDecimal epochBtjd, BigDecimal durationHours, BigDecimal depthPpm) {}
    public record Thread(String threadId, String ticId, String candidateId, String title, Object author,
                         Signal signal, int commentCount, Map<String, Object> judgmentSummary, OffsetDateTime createdAt) {}
    public record AnalysisItem(String analysisId, PostService.Author author, OffsetDateTime submittedAt,
                               String judgment, boolean contributesToSummary) {}
    public record Analyses(List<AnalysisItem> items, String nextCursor, boolean hasNext, Map<String, Object> judgmentSummary) {}
    public record PublicAnalysis(String analysisId, String threadId, String ticId, String candidateId,
                                 PostService.Author author, OffsetDateTime submittedAt, OffsetDateTime firstPublishedAt,
                                 String judgment, List<String> evidenceChecks, String memo,
                                 HistoryViews.PublicOriginal original, HistoryViews.PublicDerived serverDerived,
                                 HistoryViews.PublicMatch match,
                                 com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext curveContext,
                                 HistoryViews.Versions versions, HistoryViews.Graph graph,
                                 com.planetory.backend.domain.exploration.service.AchievementViews.Relabel relabel) {}
    private record FeedRow(long id, String kind, String tic, Long candidate, String title, Object author,
                           long comments, OffsetDateTime at) {}
    private record ThreadRow(long id, long tic, long candidate, String title, Signal signal, OffsetDateTime at) {}
    private record AnalysisRow(AnalysisItem item, long submission) {}
    private record PublicRow(long history, long thread, PostService.Author author, OffsetDateTime publishedAt) {}
    private record HotRow(long id, String tic, long candidate, String title, long participants, long comments, OffsetDateTime at) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Feed hotTopics(long member, HotTopicsQuery q) {
        members.requireActive(member);
        var rows = jdbc.sql("""
                WITH ranked AS (
                    SELECT p.id,p.tic_id,p.candidate_id,p.title,p.created_at,count(DISTINCT s.user_id) AS participants,
                        (SELECT count(*) FROM comments c WHERE c.post_id=p.id AND c.status='visible') AS comments
                    FROM posts p JOIN published_analyses pa ON pa.post_id=p.id AND pa.candidate_id=p.candidate_id
                    JOIN analysis_histories h ON h.id=pa.history_id JOIN submissions s ON s.id=h.submission_id
                    WHERE %s AND %s
                    GROUP BY p.id HAVING count(DISTINCT s.user_id)>=%d
                )
                SELECT * FROM ranked
                WHERE (CAST(:count AS BIGINT) IS NULL OR (participants,created_at,id)<(:count,:at,:id))
                ORDER BY participants DESC,created_at DESC,id DESC LIMIT :limit
                """.formatted(PublicAnalysisVisibility.VISIBLE, OPEN_BOARD, HotTopicsQuery.HOT_TOPIC_MIN_PARTICIPANTS))
                .param("count", q.afterCount()).param("at", q.afterAt()).param("id", q.afterId()).param("limit", q.size() + 1)
                .query((r, n) -> new HotRow(r.getLong("id"), r.getString("tic_id"), r.getLong("candidate_id"),
                        r.getString("title"), r.getLong("participants"), r.getLong("comments"), r.getObject("created_at", OffsetDateTime.class))).list();
        boolean more = rows.size() > q.size();
        var page = rows.subList(0, Math.min(rows.size(), q.size()));
        // ponytail: 최대 100개 단건 요약. 후보별 일괄 계약이 제공되면 이 조립부만 교체한다.
        var items = page.stream().map(r -> new FeedItem("SIGNAL_THREAD", "st-" + r.id(), r.tic(), r.title(), SYSTEM,
                r.comments(), submissions.publicJudgmentSummary(r.candidate()), r.at())).toList();
        return new Feed(items, more ? q.next(page.getLast().participants(), page.getLast().at(), page.getLast().id()) : null, more);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Feed feed(long member, CommunityQuery q) {
        members.requireActive(member);
        if (q.target() != null) stars.requireOpenStarBoard(q.target());
        var search = q.search();
        String filters = "";
        if (search != null) {
            if (!search.q().isEmpty()) filters += switch (search.searchIn()) {
                case "TITLE" -> " AND p.title ILIKE :pattern ESCAPE E'\\\\'";
                case "BODY" -> " AND p.body ILIKE :pattern ESCAPE E'\\\\'";
                default -> " AND (p.title ILIKE :pattern ESCAPE E'\\\\' OR p.body ILIKE :pattern ESCAPE E'\\\\')";
            };
            if (!search.author().isEmpty()) filters += " AND p.kind='user' AND lower(u.nickname)=lower(:author)";
            if (!search.board().isEmpty()) filters += " AND p.board=:board";
            if (!search.tag().isEmpty()) filters += " AND p.kind='user' AND p.tag=:tag";
        }
        var statement = jdbc.sql("""
                SELECT p.id,p.kind,p.tic_id,p.candidate_id,p.title,p.user_id,u.nickname,p.created_at,
                    (SELECT count(*) FROM comments c WHERE c.post_id=p.id AND c.status='visible') AS comments
                FROM posts p LEFT JOIN users u ON u.id=p.user_id
                WHERE p.status='visible' AND %s %s
                    AND (CAST(:tic AS BIGINT) IS NULL OR p.tic_id=:tic)
                    AND (CAST(:at AS TIMESTAMPTZ) IS NULL OR (p.created_at,p.id)<(:at,:id))
                ORDER BY p.created_at DESC,p.id DESC LIMIT :limit
                """.formatted(OPEN_BOARD, filters))
                .param("tic", q.target()).param("at", q.afterAt()).param("id", q.afterId()).param("limit", q.size() + 1);
        if (search != null) {
            if (!search.q().isEmpty()) statement.param("pattern", search.pattern());
            if (!search.author().isEmpty()) statement.param("author", search.author());
            if (!search.board().isEmpty()) statement.param("board", search.board().toLowerCase(java.util.Locale.ROOT));
            if (!search.tag().isEmpty()) statement.param("tag", search.tag());
        }
        var rows = statement.query((r, n) -> new FeedRow(r.getLong("id"), r.getString("kind"), r.getString("tic_id"),
                        r.getObject("candidate_id", Long.class), r.getString("title"),
                        "system_thread".equals(r.getString("kind")) ? SYSTEM : new PostService.Author("u-" + r.getLong("user_id"), r.getString("nickname")),
                        r.getLong("comments"), r.getObject("created_at", OffsetDateTime.class))).list();
        boolean more = rows.size() > q.size();
        var page = rows.subList(0, Math.min(rows.size(), q.size()));
        // ponytail: 최대 100개 단건 집계. 후보별 일괄 계약이 제공되면 이 조립부만 교체한다.
        var items = page.stream().map(r -> new FeedItem(r.candidate() == null ? "POST" : "SIGNAL_THREAD",
                (r.candidate() == null ? "p-" : "st-") + r.id(), r.tic(), r.title(), r.author(), r.comments(),
                r.candidate() == null ? null : submissions.publicJudgmentSummary(r.candidate()), r.at())).toList();
        return new Feed(items, more ? q.next(page.getLast().at(), page.getLast().id()) : null, more);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Thread thread(long member, long id) {
        members.requireActive(member);
        var row = openThread(id);
        return new Thread("st-" + id, Long.toString(row.tic()), "c-" + row.candidate(), row.title(), SYSTEM,
                row.signal(), comments.countVisible(id), submissions.publicJudgmentSummary(row.candidate()), row.at());
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Analyses analyses(long member, CommunityQuery q) {
        members.requireActive(member);
        var thread = openThread(q.target());
        var rows = jdbc.sql("""
                WITH visible AS (
                    SELECT pa.id,pa.user_id,u.nickname,s.created_at,s.id AS submission_id,s.user_judgment,
                        row_number() OVER (PARTITION BY s.user_id ORDER BY s.created_at DESC,s.id DESC) AS representative
                    FROM published_analyses pa JOIN posts p ON p.id=pa.post_id
                    JOIN analysis_histories h ON h.id=pa.history_id JOIN submissions s ON s.id=h.submission_id
                    JOIN users u ON u.id=pa.user_id
                    WHERE pa.candidate_id=:candidate AND %s
                )
                SELECT * FROM visible WHERE (:judgment='' OR user_judgment=:judgment)
                    AND (CAST(:at AS TIMESTAMPTZ) IS NULL OR (created_at,submission_id)<(:at,:id))
                ORDER BY created_at DESC,submission_id DESC LIMIT :limit
                """.formatted(PublicAnalysisVisibility.VISIBLE))
                .param("candidate", thread.candidate()).param("judgment", q.judgment())
                .param("at", q.afterAt()).param("id", q.afterId()).param("limit", q.size() + 1)
                .query((r, n) -> new AnalysisRow(new AnalysisItem("pa-" + r.getLong("id"),
                        new PostService.Author("u-" + r.getLong("user_id"), r.getString("nickname")),
                        r.getObject("created_at", OffsetDateTime.class), r.getString("user_judgment"),
                        r.getLong("representative") == 1), r.getLong("submission_id"))).list();
        boolean more = rows.size() > q.size();
        var page = rows.subList(0, Math.min(rows.size(), q.size()));
        return new Analyses(page.stream().map(AnalysisRow::item).toList(),
                more ? q.next(page.getLast().item().submittedAt(), page.getLast().submission()) : null, more,
                submissions.publicJudgmentSummary(thread.candidate()));
    }

    /** HistoryService가 각 읽기·그래프·반환 직전 검사에 새 트랜잭션을 열도록 바깥 트랜잭션을 두지 않는다. */
    public PublicAnalysis analysis(long member, long id, String mode, boolean includeGraph) {
        if (!Set.of("CURRENT", "SUBMITTED").contains(mode)) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        members.requireActive(member);
        var row = jdbc.sql("""
                SELECT pa.history_id,pa.post_id,pa.user_id,u.nickname,pa.published_at
                FROM published_analyses pa JOIN posts p ON p.id=pa.post_id JOIN users u ON u.id=pa.user_id
                WHERE pa.id=? AND %s AND %s
                """.formatted(PublicAnalysisVisibility.VISIBLE, OPEN_BOARD)).param(id)
                .query((r, n) -> new PublicRow(r.getLong(1), r.getLong(2),
                        new PostService.Author("u-" + r.getLong(3), r.getString(4)), r.getObject(5, OffsetDateTime.class)))
                .optional().orElseThrow(CommunityReadService::notFound);
        Runnable access = () -> publicAccess.check(member, id, row.history());
        String history = "h-" + row.history();
        var content = histories.publicContent(history, access);
        var graph = includeGraph ? histories.publicGraph(history, mode, access) : null;
        access.run();
        return new PublicAnalysis("pa-" + id, "st-" + row.thread(), content.ticId(), content.candidateId(), row.author(),
                content.submittedAt(), row.publishedAt(), content.userJudgment(), content.evidenceChecks(), content.memo(),
                content.original(), content.serverDerived(), content.match(), content.curveContext(), content.versions(), graph, content.relabel());
    }

    private ThreadRow openThread(long id) {
        var row = jdbc.sql("""
                SELECT p.id,p.tic_id,p.candidate_id,p.title,p.created_at,c.period_days,c.epoch_btjd,c.duration_hours,c.depth_ppm
                FROM posts p JOIN candidates c ON c.id=p.candidate_id AND c.tic_id=p.tic_id
                WHERE p.id=? AND p.kind='system_thread' AND p.status='visible'
                """).param(id).query((r, n) -> new ThreadRow(r.getLong(1), r.getLong(2), r.getLong(3), r.getString(4),
                        new Signal(r.getBigDecimal(6), r.getBigDecimal(7), r.getBigDecimal(8), r.getBigDecimal(9)),
                        r.getObject(5, OffsetDateTime.class))).optional().orElseThrow(CommunityReadService::notFound);
        stars.requireOpenStarBoard(row.tic());
        return row;
    }
    private static BusinessException notFound() { return new BusinessException(ErrorCode.RESOURCE_NOT_FOUND); }
}
