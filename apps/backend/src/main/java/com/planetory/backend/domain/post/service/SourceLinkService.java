package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.PublicAnalysisVisibility;
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
import java.util.LinkedHashMap;
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
            case "PUBLIC_ANALYSIS" -> "pa-";
            case "SIGNAL_THREAD" -> "st-";
            default -> throw error(ErrorCode.VALIDATION_FAILED);
        };
        if (link.id() == null || !link.id().matches(prefix + "[1-9][0-9]*")) throw error(ErrorCode.VALIDATION_FAILED);
        try { return Long.parseLong(link.id().substring(3)); }
        catch (NumberFormatException e) { throw error(ErrorCode.VALIDATION_FAILED); }
    }

    /** 부모 잠금 안에서 호출한다. 생략은 기존 무효 출처도 보존하며 별 변경만 전체를 재검증한다. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void replace(Parent parent, long parentId, Long tic, List<SourceLink> input, boolean changedTic) {
        if (input == null && !changedTic) return;
        List<SourceLink> links = input == null ? stored(parent, parentId) : input;
        validate(links);
        for (SourceLink link : links) requireTarget(link, tic, true);
        if (input == null) return;
        jdbc.sql("DELETE FROM post_source_links WHERE " + parent.column + "=?").param(parentId).update();
        for (SourceLink link : links) jdbc.sql("INSERT INTO post_source_links(" + parent.column + ",target_type,target_id) VALUES (?,?,?)")
                .params(parentId, dbType(link), id(link)).update();
    }

    public void requireCommentTic(long post, Long tic) {
        var ids = jdbc.sql("SELECT id FROM comments WHERE post_id=? AND status<>'deleted'").param(post).query(Long.class).list();
        for (long comment : ids) for (SourceLink link : stored(Parent.COMMENT, comment)) requireTarget(link, tic, true);
    }

    public List<Map<String, Object>> references(Parent parent, long parentId, Long tic) {
        // ponytail: 부모당 최대 3개 출처를 현재 상태로 조회한다. 큰 댓글 페이지 비용이 측정되면 일괄 조회로 바꾼다.
        return stored(parent, parentId).stream().map(link -> {
            try {
                requireTarget(link, tic, false);
                return Map.<String, Object>of("type", link.type(), "id", link.id(), "available", true);
            } catch (BusinessException e) {
                if (e.getErrorCode() != ErrorCode.RESOURCE_NOT_FOUND && e.getErrorCode() != ErrorCode.TIC_MISMATCH) throw e;
                return Map.<String, Object>of("type", link.type(), "available", false);
            }
        }).toList();
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Map<String, Object> preview(long member, String type, String sourceId, String ticId) {
        members.requireActive(member);
        long tic;
        try {
            if (ticId == null || !ticId.matches("[1-9][0-9]*")) throw error(ErrorCode.VALIDATION_FAILED);
            tic = Long.parseLong(ticId);
        } catch (NumberFormatException e) { throw error(ErrorCode.VALIDATION_FAILED); }
        return card(new SourceLink(type, sourceId), tic, false, member);
    }

    private Map<String, Object> card(SourceLink link, Long tic, boolean lock, Long member) {
        var target = requireTarget(link, tic, lock);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("type", link.type()); result.put("id", link.id()); result.put("available", true);
        result.put("ticId", Long.toString(target.tic()));
        if ("PUBLIC_ANALYSIS".equals(link.type())) {
            if (member != null) access.check(member, id(link), target.history());
            result.putAll(jdbc.sql("""
                    SELECT pa.user_id,u.nickname,s.user_judgment,s.created_at
                    FROM published_analyses pa JOIN users u ON u.id=pa.user_id
                    JOIN analysis_histories h ON h.id=pa.history_id JOIN submissions s ON s.id=h.submission_id
                    WHERE pa.id=?
                    """).param(id(link)).query((r,n) -> Map.<String,Object>of(
                            "author", new PostService.Author("u-" + r.getLong(1), r.getString(2)),
                            "judgment", r.getString(3), "submittedAt", r.getObject(4, OffsetDateTime.class))).single());
        } else {
            result.put("threadId", link.id()); result.put("candidateId", "c-" + target.candidate());
            result.put("author", Map.of("type", "SYSTEM", "displayName", "SYSTEM"));
            result.put("signal", jdbc.sql("SELECT period_days,epoch_btjd,duration_hours,depth_ppm FROM candidates WHERE id=?")
                    .param(target.candidate()).query((r,n) -> new CommunityReadService.Signal(
                            r.getBigDecimal(1),r.getBigDecimal(2),r.getBigDecimal(3),r.getBigDecimal(4))).single());
            result.put("judgmentSummary", submissions.publicJudgmentSummary(target.candidate()));
        }
        return result;
    }

    private record Target(long tic, long candidate, Long history) {}
    private Target requireTarget(SourceLink link, Long tic, boolean lock) {
        long number = id(link);
        boolean analysis = "PUBLIC_ANALYSIS".equals(link.type());
        if (lock) {
            // 공개 상태 변경과 같은 순서: SYSTEM 부모 → 공개 분석 행.
            String parentSql = analysis
                    ? "SELECT p.id FROM posts p JOIN published_analyses pa ON pa.post_id=p.id WHERE pa.id=? FOR SHARE OF p"
                    : "SELECT p.id FROM posts p WHERE p.id=? FOR SHARE OF p";
            jdbc.sql(parentSql).param(number).query(Long.class).optional()
                    .orElseThrow(() -> error(ErrorCode.RESOURCE_NOT_FOUND));
        }
        String sql = analysis ? "SELECT p.tic_id,p.candidate_id,pa.history_id FROM published_analyses pa JOIN posts p ON p.id=pa.post_id WHERE pa.id=? AND "
                + PublicAnalysisVisibility.VISIBLE : "SELECT p.tic_id,p.candidate_id,NULL::bigint FROM posts p JOIN candidates c ON c.id=p.candidate_id AND c.tic_id=p.tic_id WHERE p.id=? AND p.kind='system_thread' AND p.status='visible'";
        if (lock) sql += analysis ? " FOR SHARE OF pa,p" : " FOR SHARE OF p";
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
