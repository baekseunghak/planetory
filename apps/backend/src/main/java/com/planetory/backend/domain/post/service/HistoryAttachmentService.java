package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.exploration.service.HistoryService;
import com.planetory.backend.domain.exploration.service.HistoryViews;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** 글·댓글의 History 참조만 소유한다. 원본 저장·공식 공개·성과·계산은 변경하지 않는다. */
@Service
@RequiredArgsConstructor
public class HistoryAttachmentService {
    private final JdbcClient jdbc;
    private final HistoryService histories;
    private final StarService stars;

    public enum Parent {
        POST("post_history_attachments", "post_id", "p-"),
        COMMENT("comment_history_attachments", "comment_id", "c-");

        final String table, column, prefix;

        Parent(String table, String column, String prefix) {
            this.table = table;
            this.column = column;
            this.prefix = prefix;
        }
    }

    public record Reference(String historyId) {}

    /** null과 생략은 구분한다. 배열을 보냈다면 전체 교체이며 null은 잘못된 입력이다. */
    public static List<String> input(JsonNode request) {
        if (!request.has("historyIds")) return null;
        JsonNode value = request.get("historyIds");
        if (!value.isArray()) throw error(ErrorCode.VALIDATION_FAILED);
        List<String> ids = new ArrayList<>();
        for (JsonNode id : value) {
            if (!id.isString()) throw error(ErrorCode.VALIDATION_FAILED);
            ids.add(id.asText());
        }
        return ids;
    }

    /** 호출자가 부모 행을 잠근 쓰기 트랜잭션 안에서 검증과 교체를 수행한다. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void replace(Parent parent, long parentId, long author, Long tic, List<String> input) {
        List<Long> ids = input == null ? storedIds(parent, parentId) : parse(input);
        if (!ids.isEmpty() && tic == null) throw error(ErrorCode.TIC_MISMATCH);
        for (long id : ids) {
            var row = jdbc.sql("SELECT user_id,tic_id FROM analysis_histories WHERE id=?").param(id)
                    .query((r, n) -> new long[]{r.getLong(1), r.getLong(2)}).optional()
                    .orElseThrow(() -> error(ErrorCode.RESOURCE_NOT_FOUND));
            if (row[0] != author) throw error(ErrorCode.FORBIDDEN);
            if (row[1] != tic) throw error(ErrorCode.TIC_MISMATCH);
        }
        if (input == null) return;
        // 같은 참조는 attached_at을 유지한다. 부모 잠금이 동시 교체를 직렬화한다.
        for (long old : storedIds(parent, parentId)) {
            if (!ids.contains(old)) {
                jdbc.sql("DELETE FROM " + parent.table + " WHERE " + parent.column + "=? AND history_id=?")
                        .params(parentId, old).update();
            }
        }
        for (long id : ids) {
            jdbc.sql("INSERT INTO " + parent.table + "(" + parent.column + ",history_id) VALUES (?,?) ON CONFLICT DO NOTHING")
                    .params(parentId, id).update();
        }
    }

    /** 부모 TIC 변경이 다른 작성자의 댓글 자료를 암묵적으로 제거하거나 다른 별에 노출하지 않게 한다. */
    public void requireCommentTic(long postId, Long tic) {
        boolean mismatch = jdbc.sql("""
                SELECT EXISTS(SELECT 1 FROM comments c
                JOIN comment_history_attachments a ON a.comment_id=c.id
                JOIN analysis_histories h ON h.id=a.history_id
                WHERE c.post_id=:post AND c.status<>'deleted' AND h.tic_id IS DISTINCT FROM CAST(:tic AS BIGINT))
                """).param("post", postId).param("tic", tic).query(Boolean.class).single();
        if (mismatch) throw error(ErrorCode.TIC_MISMATCH);
    }

    public List<Reference> references(Parent parent, long id) {
        return references(parent, List.of(id)).getOrDefault(id, List.of());
    }

    /** 댓글 페이지 전체를 한 번에 읽는다. 무효 관계의 ID도 응답에 넣지 않는다. */
    public Map<Long, List<Reference>> references(Parent parent, List<Long> ids) {
        Map<Long, List<Reference>> result = new HashMap<>();
        if (ids.isEmpty()) return result;
        jdbc.sql("SELECT a." + parent.column + " AS parent_id,h.id" + visibleFrom(parent)
                + " AND a." + parent.column + " IN (:ids) ORDER BY a.attached_at,a.id")
                .param("ids", ids).query((r, n) -> {
                    result.computeIfAbsent(r.getLong(1), k -> new ArrayList<>()).add(new Reference("h-" + r.getLong(2)));
                    return true;
                }).list();
        return result;
    }

    /** 148이 새 읽기 트랜잭션마다 실행하므로, 미리 구한 권한이나 JPA 캐시를 사용하지 않는다. */
    public void checkAccess(long member, Parent parent, long parentId, long historyId) {
        if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')")
                .param(member).query(Boolean.class).single()) throw error(ErrorCode.AUTH_REQUIRED);
        long tic = jdbc.sql("SELECT p.tic_id" + visibleFrom(parent)
                + " AND a." + parent.column + "=? AND h.id=?")
                .params(parentId, historyId).query(Long.class).optional()
                .orElseThrow(() -> error(ErrorCode.RESOURCE_NOT_FOUND));
        try {
            stars.requireOpenStarBoard(tic);
        } catch (BusinessException e) {
            if (e.getErrorCode() != ErrorCode.STAR_NOT_PUBLISHED) throw e;
            throw error(ErrorCode.RESOURCE_NOT_FOUND);
        }
    }

    public HistoryViews.PublicHistory read(long member, Parent parent, long parentId, String historyId,
                                           String mode, boolean includeGraph) {
        if (!List.of("CURRENT", "SUBMITTED").contains(mode)) throw error(ErrorCode.VALIDATION_FAILED);
        long id = id(historyId, "h-", ErrorCode.RESOURCE_NOT_FOUND);
        Runnable access = () -> checkAccess(member, parent, parentId, id);
        var content = histories.publicContent(historyId, access);
        return includeGraph ? content.withGraph(histories.publicGraph(historyId, mode, access)) : content;
    }

    public static long parentId(Parent parent, String value) {
        return id(value, parent.prefix, ErrorCode.RESOURCE_NOT_FOUND);
    }

    private static List<Long> parse(List<String> values) {
        if (values.size() > 3 || new HashSet<>(values).size() != values.size()) {
            throw error(ErrorCode.VALIDATION_FAILED);
        }
        return values.stream().map(v -> id(v, "h-", ErrorCode.VALIDATION_FAILED)).toList();
    }

    private List<Long> storedIds(Parent parent, long id) {
        return jdbc.sql("SELECT history_id FROM " + parent.table + " WHERE " + parent.column + "=?")
                .param(id).query(Long.class).list();
    }

    private static String visibleFrom(Parent parent) {
        String join = parent == Parent.POST ? " JOIN posts p ON p.id=a.post_id" :
                " JOIN comments c ON c.id=a.comment_id JOIN posts p ON p.id=c.post_id";
        String author = parent == Parent.POST ? "p.user_id" : "c.user_id";
        return " FROM " + parent.table + " a" + join + " JOIN analysis_histories h ON h.id=a.history_id"
                + " WHERE p.status='visible' AND p.tic_id=h.tic_id AND h.user_id=" + author
                + (parent == Parent.POST ? " AND p.kind='user'" : " AND c.status='visible' AND p.kind IN ('user','system_thread')");
    }

    private static long id(String value, String prefix, ErrorCode code) {
        if (value == null || !value.matches(prefix + "[1-9][0-9]*")) throw error(code);
        try {
            return Long.parseLong(value.substring(prefix.length()));
        } catch (NumberFormatException e) {
            throw error(code);
        }
    }

    private static BusinessException error(ErrorCode code) { return new BusinessException(code); }
}
