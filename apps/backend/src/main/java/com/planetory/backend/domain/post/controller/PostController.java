package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.comment.service.CommentService;
import com.planetory.backend.domain.post.service.PostService;
import com.planetory.backend.domain.post.service.SourceLinkService;
import com.planetory.backend.domain.post.service.PostReactionService;
import com.planetory.backend.domain.post.service.HistoryAttachmentService;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import java.time.Instant;
import java.util.List;
import tools.jackson.databind.JsonNode;

@RestController
@RequiredArgsConstructor
public class PostController {
    private final PostService posts;
    private final CommentService comments;
    private final PostReactionService reactions;

    /**
     * 글 상세 응답. 글 자체는 `PostService`, 댓글 수는 댓글 도메인이 소유하므로 여기서 합친다.
     * `GET /me`가 회원과 탐사 요약을 합치는 방식과 같다.
     */
    public record PostDetailResponse(String postId, String title, String body, String purposeTag, String ticId,
                                     PostService.Author author, List<HistoryAttachmentService.Reference> attachments,
                                     List<SourceLinkService.Reference> sourceLinks,
                                     PostService.ReactionSummary reactionSummary, int commentCount,
                                     Instant createdAt, Instant updatedAt) {
        static PostDetailResponse of(Detail post, int commentCount, PostService.ReactionSummary summary) {
            return new PostDetailResponse(post.postId(), post.title(), post.body(), post.purposeTag(), post.ticId(),
                    post.author(), post.attachments(), post.sourceLinks(), summary, commentCount,
                    post.createdAt(), post.updatedAt());
        }
    }

    private PostDetailResponse withCounts(Detail post, long memberId) {
        long postId = parsePostId(post.postId());
        return PostDetailResponse.of(post, comments.countVisible(postId), reactions.summary(postId, memberId));
    }

    @Operation(summary = "일반 게시글 작성")
    @PostMapping("/api/v1/posts")
    @ResponseStatus(HttpStatus.CREATED)
    public PostService.Created create(@AuthenticationPrincipal MemberPrincipal principal, @RequestBody JsonNode request) {
        if (request == null || !request.isObject()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        return posts.create(principal.memberId(), new CreateCommand(text(request, "title"), text(request, "body"),
                text(request, "purposeTag"), text(request, "ticId"), HistoryAttachmentService.input(request), SourceLinkService.input(request)));
    }

    @Operation(summary = "일반 게시글 상세")
    @GetMapping("/api/v1/posts/{postId}")
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PostDetailResponse detail(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String postId) {
        return withCounts(posts.detail(parsePostId(postId)), principal.memberId());
    }

    @Operation(summary = "일반 게시글 수정")
    @PatchMapping("/api/v1/posts/{postId}")
    @Transactional
    public PostDetailResponse patch(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String postId,
                                   @RequestBody JsonNode request) {
        if (request == null || !request.isObject()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        return withCounts(posts.patch(principal.memberId(), parsePostId(postId), new PostService.PatchCommand(
                text(request, "title"), request.has("title"), text(request, "body"), request.has("body"),
                text(request, "purposeTag"), request.has("purposeTag"), text(request, "ticId"), request.has("ticId"),
                HistoryAttachmentService.input(request), SourceLinkService.input(request))), principal.memberId());
    }

    @Operation(summary = "일반 글 반응 최종 상태 설정")
    @PutMapping("/api/v1/posts/{postId}/my-reaction")
    public PostReactionService.Result react(@AuthenticationPrincipal MemberPrincipal principal,
                                            @PathVariable String postId, @RequestBody JsonNode request) {
        if (request == null || !request.isObject()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        return reactions.put(principal.memberId(), parsePostId(postId), text(request, "reaction"));
    }

    @Operation(summary = "일반 글 반응자 목록")
    @GetMapping("/api/v1/posts/{postId}/reactions")
    public PostReactionService.ReactionList reactors(@PathVariable String postId, @RequestParam String reaction,
                                                    @RequestParam(defaultValue = "20") int size,
                                                    @RequestParam(required = false) String cursor) {
        return reactions.list(parsePostId(postId), reaction, size, cursor);
    }

    @Operation(summary = "일반 게시글 삭제")
    @DeleteMapping("/api/v1/posts/{postId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@AuthenticationPrincipal MemberPrincipal principal, @PathVariable String postId) {
        posts.delete(principal.memberId(), parsePostId(postId));
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
