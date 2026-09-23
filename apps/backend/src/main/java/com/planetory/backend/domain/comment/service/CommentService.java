package com.planetory.backend.domain.comment.service;

import com.planetory.backend.domain.comment.entity.Comment;
import com.planetory.backend.domain.comment.repository.CommentRepository;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.post.entity.Post;
import com.planetory.backend.domain.post.repository.PostRepository;
import com.planetory.backend.domain.post.service.HistoryAttachmentService;
import com.planetory.backend.domain.post.service.SourceLinkService;
import com.planetory.backend.domain.post.service.PostService.SourceLink;
import com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent;
import com.planetory.backend.domain.post.service.HistoryAttachmentService.Reference;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class CommentService {
    private static final int MAX_BODY_CODE_POINTS = 2_000;
    /** @RequestParam defaultValue가 문자열만 받으므로 기본 크기도 문자열 상수 하나로 둔다. */
    public static final String DEFAULT_LIST_SIZE = "20";
    public static final int MAX_LIST_SIZE = 100;
    private final CommentRepository comments;
    private final PostRepository posts;
    private final MemberService members;
    private final Clock clock;
    private final HistoryAttachmentService attachments;
    private final StarService stars;
    private final SourceLinkService sources;
    private final com.planetory.backend.domain.member.service.NotificationService notifications;

    public enum ParentType { POST, SIGNAL_THREAD }
    public record CreateCommand(ParentType parentType, long parentId, String body, List<String> historyIds, List<SourceLink> sourceLinks) {}
    public record PatchCommand(String body, boolean hasBody, List<String> historyIds, List<SourceLink> sourceLinks) {}
    public record Created(String commentId, Instant createdAt) {}
    public record Author(String memberId, String nickname) {}
    public record Detail(String commentId, Author author, String body, List<Reference> attachments,
                         List<SourceLinkService.Reference> sourceLinks, Instant createdAt, Instant updatedAt) {}

    /** {@code hasNext}는 {@code nextCursor != null}과 같은 뜻이다. 피드 4.1과 같은 목록 구조를 쓴다. */
    public record CommentList(List<Detail> items, String nextCursor, boolean hasNext) {}

    @Transactional
    public Created create(long memberId, CreateCommand command) {
        var author = members.lockActive(memberId);
        // 부모 삭제도 같은 Post 행을 잠그므로, 삭제가 먼저면 새 댓글을 저장하지 않는다.
        Post parent = parent(command.parentId(), command.parentType(), true);
        Comment comment = comments.saveAndFlush(new Comment(parent, author, body(command.body())));
        attachments.replace(Parent.COMMENT, comment.getId(), memberId, parent.getTicId(), command.historyIds());
        sources.replace(Parent.COMMENT, comment.getId(), parent.getTicId(), command.sourceLinks(), false);
        if ("user".equals(parent.getKind())) notifications.commentCreated(memberId, parent.getAuthor().getId(), parent.getId(), comment.getId());
        return new Created(id(comment), comment.getCreatedAt());
    }

    /** 글 상세가 쓰는 공개 댓글 수. 세는 규칙을 댓글 도메인 한 곳에 둔다(삭제·숨김 제외, SB-D22). */
    @Transactional(readOnly = true)
    public int countVisible(long postId) {
        return comments.countVisibleByVisiblePostId(postId);
    }

    /**
     * 최신순 한 페이지. 커서는 부모 종류·부모 ID·size에 묶이므로 조건을 바꾸면 이어읽을 수 없고 400이다.
     *
     * <p>정렬 키는 {@code createdAt} 내림차순이고 동률은 {@code id}로 가른다.
     */
    @Transactional(readOnly = true, isolation = org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public CommentList list(long parentId, ParentType parentType, int size, String cursor) {
        if (size < 1 || size > MAX_LIST_SIZE) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        Post parent = parent(parentId, parentType, false);
        CommentCursor expected = new CommentCursor(parentType.name(), parentId, size, 0, 0);
        CommentCursor after = null;
        if (cursor != null && !cursor.isBlank()) {
            after = CommentCursor.decode(cursor, expected)
                    .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));
        }
        // 한 건 더 읽어 다음 페이지가 있는지 본다. 별도 count 질의를 하지 않는다.
        var limit = PageRequest.ofSize(size + 1);
        List<Comment> page = after == null
                ? comments.findVisibleFirstPage(parentId, limit)
                : comments.findVisibleAfter(parentId, after.afterCreatedAt(), after.afterId(), limit);
        boolean hasNext = page.size() > size;
        List<Comment> shown = hasNext ? page.subList(0, size) : page;
        String next = null;
        if (hasNext) {
            Comment last = shown.get(shown.size() - 1);
            next = CommentCursor.after(parentType.name(), parentId, size,
                    last.getCreatedAt(), last.getId()).encode();
        }
        var refs = attachments.references(Parent.COMMENT, shown.stream().map(Comment::getId).toList());
        var sourceRefs = sources.references(Parent.COMMENT, shown.stream().map(Comment::getId).toList(), parent.getTicId());
        return new CommentList(shown.stream().map(c -> detailOf(c, refs.getOrDefault(c.getId(), List.of()),
                sourceRefs.getOrDefault(c.getId(), List.of()))).toList(), next, hasNext);
    }

    @Transactional
    public Detail patch(long memberId, long commentId, PatchCommand command) {
        members.lockActive(memberId);
        if (!command.hasBody() && command.historyIds() == null && command.sourceLinks() == null) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        Comment comment = comments.findByIdForUpdate(commentId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        Post parent = requireOpenParent(comment.getPost().getId());
        writable(comment, memberId);
        attachments.replace(Parent.COMMENT, commentId, memberId, parent.getTicId(), command.historyIds());
        sources.replace(Parent.COMMENT, commentId, parent.getTicId(), command.sourceLinks(), false);
        comment.update(command.hasBody() ? body(command.body()) : comment.getBody(), Instant.now(clock));
        return detailOf(comment, attachments.references(Parent.COMMENT, commentId),
                sources.references(Parent.COMMENT, commentId, parent.getTicId()));
    }

    @Transactional
    public void delete(long memberId, long commentId) {
        members.lockActive(memberId);
        Comment comment = comments.findByIdForUpdate(commentId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (comment.getAuthor().getId() != memberId) {
            throw new BusinessException(visible(comment) && visible(comment.getPost())
                    ? ErrorCode.FORBIDDEN : ErrorCode.RESOURCE_NOT_FOUND);
        }
        if (!"deleted".equals(comment.getStatus())) comment.delete(Instant.now(clock));
    }

    /** 수정은 부모가 공개일 때만 허용한다(SB-D22). 삭제는 부모 상태를 보지 않으므로 여기를 거치지 않는다. */
    private Post requireOpenParent(long postId) {
        Post post = posts.findByIdForUpdate(postId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (!visible(post)) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        if (post.getTicId() != null) stars.requireOpenStarBoard(post.getTicId());
        return post;
    }

    private Post parent(long postId, ParentType type, boolean lock) {
        Post post = (lock ? posts.findByIdForUpdate(postId) : posts.findById(postId))
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (!visible(post) || typeOf(post) != type) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        if (post.getTicId() != null) stars.requireOpenStarBoard(post.getTicId());
        return post;
    }

    private static void writable(Comment comment, long memberId) {
        if (!visible(comment)) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        if (comment.getAuthor().getId() != memberId) throw new BusinessException(ErrorCode.FORBIDDEN);
    }

    private static String body(String input) {
        if (input == null || input.isBlank() || input.codePointCount(0, input.length()) > MAX_BODY_CODE_POINTS) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return input;
    }

    private static ParentType typeOf(Post post) {
        return switch (post.getKind()) {
            case "user" -> ParentType.POST;
            case "system_thread" -> ParentType.SIGNAL_THREAD;
            default -> throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        };
    }

    private static boolean visible(Post post) { return "visible".equals(post.getStatus()); }
    private static boolean visible(Comment comment) { return "visible".equals(comment.getStatus()); }
    private static String id(Comment comment) { return "c-" + comment.getId(); }
    private Detail detailOf(Comment comment, List<Reference> attachments, List<SourceLinkService.Reference> sourceLinks) {
        var shown = com.planetory.backend.domain.post.service.PostService.publicAuthor(
                comment.getAuthor().getId(), comment.getAuthor().getNickname(), comment.getAuthor().getStatus());
        return new Detail(id(comment), new Author(shown.memberId(), shown.nickname()),
                comment.getBody(), attachments, sourceLinks, comment.getCreatedAt(), comment.getUpdatedAt());
    }
}
