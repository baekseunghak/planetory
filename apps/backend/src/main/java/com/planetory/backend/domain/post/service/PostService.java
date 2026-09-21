package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.post.entity.Post;
import com.planetory.backend.domain.post.repository.PostRepository;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class PostService {
    private static final Set<String> TAGS = Set.of("ANALYSIS", "QUESTION", "DISCUSSION", "INFORMATION", "GENERAL");
    private final PostRepository posts;
    private final MemberService members;
    private final StarService stars;
    private final Clock clock;
    private final HistoryAttachmentService attachments;
    private final SourceLinkService sources;

    public record SourceLink(String type, String id) {}
    public record CreateCommand(String title, String body, String purposeTag, String ticId,
                                List<String> historyIds, List<SourceLink> sourceLinks) {}
    public record PatchCommand(String title, boolean hasTitle, String body, boolean hasBody,
                               String purposeTag, boolean hasPurposeTag, String ticId, boolean hasTicId,
                               List<String> historyIds, List<SourceLink> sourceLinks) {}
    public record Created(String postId, Instant createdAt) {}
    public record Author(String memberId, String nickname) {}
    public record ReactionSummary(long agree, long disagree, String myReaction) {}
    /** 글 자체의 값만 담는다. 댓글 수처럼 다른 도메인이 소유한 값은 컨트롤러가 합친다. */
    public record Detail(String postId, String title, String body, String purposeTag, String ticId,
                         Author author, List<HistoryAttachmentService.Reference> attachments, List<java.util.Map<String, Object>> sourceLinks,
                         Instant createdAt, Instant updatedAt) {}

    @Transactional
    public Created create(long memberId, CreateCommand command) {
        var author = members.requireActive(memberId);
        Values values = validate(command.title(), command.body(), command.purposeTag(), command.ticId());
        var post = posts.saveAndFlush(new Post(author, values.board(), values.ticId(), values.tag(),
                values.title(), values.body()));
        attachments.replace(HistoryAttachmentService.Parent.POST, post.getId(), memberId, values.ticId(), command.historyIds());
        sources.replace(HistoryAttachmentService.Parent.POST, post.getId(), values.ticId(), command.sourceLinks(), false);
        return new Created(id(post), post.getCreatedAt());
    }

    @Transactional(readOnly = true)
    public Detail detail(long postId) {
        Post post = posts.findWithAuthorById(postId).filter(PostService::visible)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (post.getTicId() != null) stars.requireOpenStarBoard(post.getTicId());
        return detailOf(post);
    }

    @Transactional
    public Detail patch(long memberId, long postId, PatchCommand command) {
        members.requireActive(memberId);
        if (!command.hasTitle() && !command.hasBody() && !command.hasPurposeTag() && !command.hasTicId()
                && command.historyIds() == null && command.sourceLinks() == null) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        Post post = writable(memberId, postId);
        Values values = validate(command.hasTitle() ? command.title() : post.getTitle(),
                command.hasBody() ? command.body() : post.getBody(),
                command.hasPurposeTag() ? command.purposeTag() : post.getTag(),
                command.hasTicId() ? command.ticId() : post.getTicId() == null ? null : String.valueOf(post.getTicId()));
        attachments.replace(HistoryAttachmentService.Parent.POST, postId, memberId, values.ticId(), command.historyIds());
        boolean changedTic = !Objects.equals(post.getTicId(), values.ticId());
        sources.replace(HistoryAttachmentService.Parent.POST, postId, values.ticId(), command.sourceLinks(), changedTic);
        if (changedTic) {
            attachments.requireCommentTic(postId, values.ticId());
            sources.requireCommentTic(postId, values.ticId());
        }
        post.update(values.board(), values.ticId(), values.tag(), values.title(), values.body(), Instant.now(clock));
        posts.flush(); // 아래 JDBC 첨부 조회도 갱신된 TIC를 본다.
        return detailOf(post);
    }

    @Transactional
    public void delete(long memberId, long postId) {
        members.requireActive(memberId);
        Post post = posts.findByIdForUpdate(postId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        requireUserPost(post);
        if (post.getAuthor().getId() != memberId) {
            throw new BusinessException(visible(post) ? ErrorCode.FORBIDDEN : ErrorCode.RESOURCE_NOT_FOUND);
        }
        if (!"deleted".equals(post.getStatus())) post.delete(Instant.now(clock));
    }

    private Post writable(long memberId, long postId) {
        Post post = posts.findByIdForUpdate(postId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        requireUserPost(post);
        if (!visible(post)) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        if (post.getAuthor().getId() != memberId) throw new BusinessException(ErrorCode.FORBIDDEN);
        return post;
    }

    private Values validate(String titleInput, String bodyInput, String tagInput, String ticInput) {
        String title = titleInput == null ? null : titleInput.strip();
        if (title == null || title.isBlank() || hasLineBreak(title) || codePoints(title) > 100) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        if (bodyInput == null || bodyInput.isBlank() || codePoints(bodyInput) > 10_000) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        if (!TAGS.contains(tagInput)) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        Long ticId = parseTic(ticInput);
        // 공개 여부와 "한 명 이상 발견" 판정은 탐사 도메인 한 곳에서만 내린다.
        if (ticId != null) stars.requireOpenStarBoard(ticId);
        return new Values(ticId == null ? "free" : "star", ticId, tagInput, title, bodyInput);
    }

    private static int codePoints(String value) { return value.codePointCount(0, value.length()); }
    private static boolean hasLineBreak(String value) {
        return value.codePoints().anyMatch(c -> c == '\n' || c == '\r' || c == 0x85 || c == 0x2028 || c == 0x2029);
    }

    private static Long parseTic(String value) {
        if (value == null) return null;
        try {
            long tic = Long.parseLong(value);
            if (tic <= 0) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
            return tic;
        } catch (NumberFormatException e) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
    }

    private static void requireUserPost(Post post) {
        if (!"user".equals(post.getKind())) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
    }
    private static boolean visible(Post post) { return "user".equals(post.getKind()) && "visible".equals(post.getStatus()); }
    private static String id(Post post) { return "p-" + post.getId(); }
    private Detail detailOf(Post post) {
        return new Detail(id(post), post.getTitle(), post.getBody(), post.getTag(),
                post.getTicId() == null ? null : String.valueOf(post.getTicId()),
                new Author("u-" + post.getAuthor().getId(), post.getAuthor().getNickname()),
                attachments.references(HistoryAttachmentService.Parent.POST, post.getId()), sources.references(HistoryAttachmentService.Parent.POST, post.getId(), post.getTicId()),
                post.getCreatedAt(), post.getUpdatedAt());
    }
    private record Values(String board, Long ticId, String tag, String title, String body) {}
}
