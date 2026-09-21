package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.PublicAnalysisVisibility;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.SubmissionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent;
import com.planetory.backend.domain.post.service.PostService.SourceLink;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** 공개 출처 관계만 저장한다. 개인 History 접근·공개 등록·성과는 변경하지 않는다. */
@Service
@RequiredArgsConstructor
public class SourceLinkService {
    private final JdbcClient jdbc;
    private final StarService stars;
    private final MemberService members;
    private final PublicAnalysisAccess access;
    private final SubmissionService submissions;

    public static List<SourceLink> input(JsonNode request) {
        if (!request.has("sourceLinks")) return null;
        JsonNode values = request.get("sourceLinks");
        if (!values.isArray()) throw error(ErrorCode.VALIDATION_FAILED);
        List<SourceLink> result = new ArrayList<>();
        for (JsonNode value : values) {
            if (!value.isObject() || !value.path("type").isString() || !value.path("id").isString())
                throw error(ErrorCode.VALIDATION_FAILED);
            result.add(new SourceLink(value.path("type").asText(), value.path("id").asText()));
        }
        validate(result);
        return result;
    }

    private static void validate(List<SourceLink> links) {
        if (links.size() > 3 || new HashSet<>(links).size() != links.size()) throw error(ErrorCode.VALIDATION_FAILED);
        links.forEach(SourceLinkService::id);
    }

    private static long id(SourceLink link) {
        if (link == null) throw error(ErrorCode.VALIDATION_FAILED);
        String prefix = switch (link.type() == null ? "" : link.type()) {
            case "PUBLIC_ANALYSIS" -> ExplorationIds.PUBLIC_ANALYSIS;
            case "SIGNAL_THREAD" -> "st-";
            default -> throw error(ErrorCode.VALIDATION_FAILED);
        };
        return ExplorationIds.parse(link.id(), prefix).orElseThrow(() -> error(ErrorCode.VALIDATION_FAILED));
    }

    /** 부모 잠금 안에서 호출한다. 생략은 기존 무효 출처도 보존하며 별 변경만 전체를 재검증한다. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void replace(Parent parent, long parentId, Long tic, List<SourceLink> input, boolean changedTic) {
        if (input == null && !changedTic) return;
        List<SourceLink> links = input == null ? stored(parent, parentId) : input;
        validate(links);
        for (SourceLink link : links) requireTarget(link, tic);
        if (input == null) return;
        jdbc.sql("DELETE FROM post_source_links WHERE " + parent.column + "=?").param(parentId).update();
        for (SourceLink link : links) jdbc.sql("INSERT INTO post_source_links(" + parent.column + ",target_type,target_id) VALUES (?,?,?)")
                .params(parentId, dbType(link), id(link)).update();
        // 대상 posts는 잠그지 않는다. 서로를 참조하는 두 댓글의 부모 잠금과 순환하지 않게 한다.
        // 저장 후 새 읽기로 다시 검사하며, 이후 취소·숨김은 조회에서 무효 출처로 표시한다.
        for (SourceLink link : links) requireTarget(link, tic);
    }

    public void requireCommentTic(long post, Long tic) {
        var ids = jdbc.sql("SELECT id FROM comments WHERE post_id=? AND status<>'deleted'").param(post).query(Long.class).list();
        for (long comment : ids) for (SourceLink link : stored(Parent.COMMENT, comment)) requireTarget(link, tic);
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Reference(String type, String id, boolean available) {}

    public List<Reference> references(Parent parent, long parentId, Long tic) {
        return references(parent, List.of(parentId), tic).getOrDefault(parentId, List.of());
    }

    /** 페이지 전체 관계·가용성을 한 쿼리로 읽고 같은 별의 열림은 한 번만 검사한다. */
    public Map<Long, List<Reference>> references(Parent parent, List<Long> parentIds, Long tic) {
        Map<Long, List<Reference>> result = new HashMap<>();
        if (parentIds.isEmpty()) return result;
        boolean open = false;
        if (tic != null) {
            try { stars.requireOpenStarBoard(tic); open = true; }
            catch (BusinessException e) {
                if (e.getErrorCode() != ErrorCode.STAR_NOT_PUBLISHED) throw e;
            }
        }
        boolean openBoard = open;
        jdbc.sql("""
                SELECT a.%s,a.target_type,a.target_id,
                    COALESCE(p.tic_id=:tic AND (
                        (a.target_type='analysis' AND %s) OR
                        (a.target_type='thread' AND p.kind='system_thread' AND p.status='visible' AND c.id IS NOT NULL)
                    ),false) AS available
                FROM post_source_links a
                LEFT JOIN published_analyses pa ON a.target_type='analysis' AND pa.id=a.target_id
                LEFT JOIN posts p ON p.id=CASE WHEN a.target_type='analysis' THEN pa.post_id ELSE a.target_id END
                LEFT JOIN candidates c ON c.id=p.candidate_id AND c.tic_id=p.tic_id
                WHERE a.%s IN (:ids) ORDER BY a.created_at,a.id
                """.formatted(parent.column, PublicAnalysisVisibility.VISIBLE, parent.column))
                .param("tic", tic).param("ids", parentIds).query((r,n) -> {
                    boolean analysis = "analysis".equals(r.getString(2));
                    boolean available = openBoard && r.getBoolean(4);
                    var ref = new Reference(analysis ? "PUBLIC_ANALYSIS" : "SIGNAL_THREAD",
                            available ? (analysis ? "pa-" : "st-") + r.getLong(3) : null, available);
                    result.computeIfAbsent(r.getLong(1), key -> new ArrayList<>()).add(ref);
                    return true;
                }).list();
        return result;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Card(String type, String id, boolean available, String ticId, Object author,
                       String judgment, OffsetDateTime submittedAt, String threadId, String candidateId,
                       CommunityReadService.Signal signal, Map<String, Object> judgmentSummary) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Card preview(long member, String type, String sourceId, String ticId) {
        members.requireActive(member);
        long tic = ExplorationIds.parseTic(ticId).orElseThrow(() -> error(ErrorCode.VALIDATION_FAILED));
        var link = new SourceLink(type, sourceId);
        var target = requireTarget(link, tic);
        if ("PUBLIC_ANALYSIS".equals(link.type())) {
            access.check(member, id(link), target.history());
            return jdbc.sql("""
                    SELECT pa.user_id,u.nickname,s.user_judgment,s.created_at
                    FROM published_analyses pa JOIN users u ON u.id=pa.user_id
                    JOIN analysis_histories h ON h.id=pa.history_id JOIN submissions s ON s.id=h.submission_id
                    WHERE pa.id=?
                    """).param(id(link)).query((r,n) -> new Card(type, sourceId, true, Long.toString(tic),
                            new PostService.Author("u-" + r.getLong(1), r.getString(2)), r.getString(3),
                            r.getObject(4, OffsetDateTime.class), null, null, null, null)).single();
        }
        var signal = jdbc.sql("SELECT period_days,epoch_btjd,duration_hours,depth_ppm FROM candidates WHERE id=?")
                .param(target.candidate()).query((r,n) -> new CommunityReadService.Signal(
                        r.getBigDecimal(1),r.getBigDecimal(2),r.getBigDecimal(3),r.getBigDecimal(4))).single();
        return new Card(type, sourceId, true, Long.toString(tic), Map.of("type", "SYSTEM", "displayName", "SYSTEM"),
                null, null, sourceId, "c-" + target.candidate(), signal, submissions.publicJudgmentSummary(target.candidate()));
    }

    private record Target(long tic, long candidate, Long history) {}
    private Target requireTarget(SourceLink link, Long tic) {
        long number = id(link);
        boolean analysis = "PUBLIC_ANALYSIS".equals(link.type());
        String sql = analysis ? "SELECT p.tic_id,p.candidate_id,pa.history_id FROM published_analyses pa JOIN posts p ON p.id=pa.post_id WHERE pa.id=? AND "
                + PublicAnalysisVisibility.VISIBLE : "SELECT p.tic_id,p.candidate_id,NULL::bigint FROM posts p JOIN candidates c ON c.id=p.candidate_id AND c.tic_id=p.tic_id WHERE p.id=? AND p.kind='system_thread' AND p.status='visible'";
        var target = jdbc.sql(sql).param(number).query((r,n) -> new Target(r.getLong(1),r.getLong(2),r.getObject(3,Long.class)))
                .optional().orElseThrow(() -> error(ErrorCode.RESOURCE_NOT_FOUND));
        try { stars.requireOpenStarBoard(target.tic()); }
        catch (BusinessException e) {
            if (e.getErrorCode() != ErrorCode.STAR_NOT_PUBLISHED) throw e;
            throw error(ErrorCode.RESOURCE_NOT_FOUND);
        }
        if (tic == null || target.tic() != tic) throw error(ErrorCode.TIC_MISMATCH);
        return target;
    }

    private List<SourceLink> stored(Parent parent, long parentId) {
        return jdbc.sql("SELECT target_type,target_id FROM post_source_links WHERE " + parent.column + "=? ORDER BY created_at,id")
                .param(parentId).query((r,n) -> new SourceLink("analysis".equals(r.getString(1)) ? "PUBLIC_ANALYSIS" : "SIGNAL_THREAD",
                        ("analysis".equals(r.getString(1)) ? "pa-" : "st-") + r.getLong(2))).list();
    }
    private static String dbType(SourceLink link) { return "PUBLIC_ANALYSIS".equals(link.type()) ? "analysis" : "thread"; }
    private static BusinessException error(ErrorCode code) { return new BusinessException(code); }
}
