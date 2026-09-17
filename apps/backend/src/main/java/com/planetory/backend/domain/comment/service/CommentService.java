package com.planetory.backend.domain.comment.service;

import com.planetory.backend.domain.comment.entity.Comment;
import com.planetory.backend.domain.comment.repository.CommentRepository;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.post.entity.Post;
import com.planetory.backend.domain.post.repository.PostRepository;
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

    public enum ParentType { POST, SIGNAL_THREAD }
    public record CreateCommand(ParentType parentType, long parentId, String body) {}
    public record Created(String commentId, Instant createdAt) {}
    public record Author(String memberId, String nickname) {}
    public record Detail(String commentId, Author author, String body, List<Object> attachments,
                         List<Object> sourceLinks, Instant createdAt, Instant updatedAt) {}

    @Transactional
    public Created create(long memberId, CreateCommand command) {
        var author = members.requireActive(memberId);
        // 부모 삭제도 같은 Post 행을 잠그므로, 삭제가 먼저면 새 댓글을 저장하지 않는다.
        Post parent = parent(command.parentId(), command.parentType(), true);
        Comment comment = comments.saveAndFlush(new Comment(parent, author, body(command.body())));
        return new Created(id(comment), comment.getCreatedAt());
    }

    /** 글 상세가 쓰는 공개 댓글 수. 세는 규칙을 댓글 도메인 한 곳에 둔다(삭제·숨김 제외, SB-D22). */
    @Transactional(readOnly = true)
    public int countVisible(long postId) {
        return comments.countByPostIdAndStatus(postId, "visible");
    }

    @Transactional(readOnly = true)
    public List<Detail> list(long parentId, ParentType parentType, int size) {
        if (size < 1 || size > MAX_LIST_SIZE) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        parent(parentId, parentType, false);
        return comments.findVisibleByPostId(parentId, PageRequest.ofSize(size)).stream()
                .map(CommentService::detailOf).toList();
    }

    @Transactional
    public Detail patch(long memberId, long commentId, String input) {
        members.requireActive(memberId);
        Comment comment = comments.findByIdForUpdate(commentId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        writable(comment, memberId);
        requireOpenParent(comment.getPost().getId());
        comment.update(body(input), Instant.now(clock));
        return detailOf(comment);
    }

    @Transactional
    public void delete(long memberId, long commentId) {
        members.requireActive(memberId);
        Comment comment = comments.findByIdForUpdate(commentId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (comment.getAuthor().getId() != memberId) {
            throw new BusinessException(visible(comment) ? ErrorCode.FORBIDDEN : ErrorCode.RESOURCE_NOT_FOUND);
        }
        if (!"deleted".equals(comment.getStatus())) comment.delete(Instant.now(clock));
    }

    /** 수정은 부모가 공개일 때만 허용한다(SB-D22). 삭제는 부모 상태를 보지 않으므로 여기를 거치지 않는다. */
    private void requireOpenParent(long postId) {
        Post post = posts.findByIdForUpdate(postId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (!visible(post)) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    }

    private Post parent(long postId, ParentType type, boolean lock) {
        Post post = (lock ? posts.findByIdForUpdate(postId) : posts.findById(postId))
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (!visible(post) || typeOf(post) != type) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
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
    private static Detail detailOf(Comment comment) {
        return new Detail(id(comment), new Author("u-" + comment.getAuthor().getId(), comment.getAuthor().getNickname()),
                comment.getBody(), List.of(), List.of(), comment.getCreatedAt(), comment.getUpdatedAt());
    }
}
