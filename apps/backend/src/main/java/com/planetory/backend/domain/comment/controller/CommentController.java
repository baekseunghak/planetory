package com.planetory.backend.domain.comment.controller;

import com.planetory.backend.domain.comment.service.CommentService;
import com.planetory.backend.domain.comment.service.CommentService.ParentType;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
@RequiredArgsConstructor
public class CommentController {
    private final CommentService comments;

    @Operation(summary = "댓글 작성")
    @PostMapping("/api/v1/comments")
    @ResponseStatus(HttpStatus.CREATED)
    public CommentService.Created create(@AuthenticationPrincipal MemberPrincipal principal, @RequestBody JsonNode request) {
        if (request == null || !request.isObject()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        rejectItems(request, "historyIds");
        rejectItems(request, "sourceLinks");
        ParentType parentType = parentType(text(request, "parentType"));
        return comments.create(principal.memberId(), new CommentService.CreateCommand(
                parentType, parentId(text(request, "parentId"), parentType),
                text(request, "body")));
    }

    @Operation(summary = "댓글 목록")
    @GetMapping("/api/v1/comments")
    public java.util.List<CommentService.Detail> list(@RequestParam String parentType, @RequestParam String parentId,
                                                       @RequestParam(defaultValue = CommentService.DEFAULT_LIST_SIZE) int size) {
        ParentType type = parentType(parentType);
        return comments.list(parentId(parentId, type), type, size);
    }

    @Operation(summary = "댓글 수정")
    @PatchMapping("/api/v1/comments/{commentId}")
    public CommentService.Detail patch(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String commentId,
                                       @RequestBody JsonNode request) {
        if (request == null || !request.isObject() || !request.has("body")) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        rejectItems(request, "historyIds");
        rejectItems(request, "sourceLinks");
        return comments.patch(principal.memberId(), commentId(commentId), text(request, "body"));
    }

    @Operation(summary = "댓글 삭제")
    @DeleteMapping("/api/v1/comments/{commentId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String commentId) {
        comments.delete(principal.memberId(), commentId(commentId));
    }

    private static void rejectItems(JsonNode request, String field) {
        JsonNode value = request.get(field);
        if (value == null || value.isNull()) return;
        if (!value.isArray() || !value.isEmpty()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
    }

    private static ParentType parentType(String value) {
        try { return ParentType.valueOf(value); }
        catch (IllegalArgumentException | NullPointerException e) { throw new BusinessException(ErrorCode.VALIDATION_FAILED); }
    }

    private static long parentId(String value, ParentType type) {
        return numericId(value, type == ParentType.POST ? "p-" : "st-");
    }

    private static long commentId(String value) { return numericId(value, "c-"); }

    private static long numericId(String value, String prefix) {
        if (value == null || !value.matches(prefix + "[1-9][0-9]*")) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        try { return Long.parseLong(value.substring(prefix.length())); }
        catch (NumberFormatException e) { throw new BusinessException(ErrorCode.VALIDATION_FAILED); }
    }

    private static String text(JsonNode request, String field) {
        JsonNode value = request.get(field);
        return value == null || value.isNull() ? null : value.isString() ? value.stringValue() : invalid();
    }

    private static String invalid() { throw new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
