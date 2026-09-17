package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.post.service.PostService;
import com.planetory.backend.domain.post.service.PostService.CreateCommand;
import com.planetory.backend.domain.post.service.PostService.Detail;
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
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
@RequiredArgsConstructor
public class PostController {
    private final PostService posts;

    @Operation(summary = "일반 게시글 작성")
    @PostMapping("/api/v1/posts")
    @ResponseStatus(HttpStatus.CREATED)
    public PostService.Created create(@AuthenticationPrincipal MemberPrincipal principal, @RequestBody CreateCommand request) {
        if (request == null) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        return posts.create(principal.memberId(), request);
    }

    @Operation(summary = "일반 게시글 상세")
    @GetMapping("/api/v1/posts/{postId}")
    public Detail detail(@PathVariable String postId) { return posts.detail(parsePostId(postId)); }

    @Operation(summary = "일반 게시글 수정")
    @PatchMapping("/api/v1/posts/{postId}")
    public Detail patch(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String postId,
                        @RequestBody JsonNode request) {
        if (request == null || !request.isObject()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        // 명세 5.2의 연결 해제 예제가 빈 배열을 함께 보낸다. 빈 값은 받고 실제 항목이 있을 때만 거절한다.
        rejectItems(request, "historyIds");
        rejectItems(request, "sourceLinks");
        return posts.patch(principal.memberId(), parsePostId(postId), new PostService.PatchCommand(
                text(request, "title"), request.has("title"), text(request, "body"), request.has("body"),
                text(request, "purposeTag"), request.has("purposeTag"), text(request, "ticId"), request.has("ticId")));
    }

    @Operation(summary = "일반 게시글 삭제")
    @DeleteMapping("/api/v1/posts/{postId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String postId) {
        posts.delete(principal.memberId(), parsePostId(postId));
    }

    /** F09·F24 첨부가 구현되기 전까지 항목을 담은 요청만 막는다. 없음·null·빈 배열은 변경 없음으로 본다. */
    private static void rejectItems(JsonNode request, String field) {
        JsonNode value = request.get(field);
        if (value == null || value.isNull()) return;
        if (!value.isArray() || !value.isEmpty()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
    }

    private static String text(JsonNode request, String field) {
        JsonNode value = request.get(field);
        return value == null || value.isNull() ? null : value.isString() ? value.stringValue() : invalid();
    }

    private static String invalid() { throw new BusinessException(ErrorCode.VALIDATION_FAILED); }

    private static long parsePostId(String value) {
        if (!value.matches("p-[1-9][0-9]*")) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        try { return Long.parseLong(value.substring(2)); }
        catch (NumberFormatException e) { throw new BusinessException(ErrorCode.VALIDATION_FAILED); }
    }
}
