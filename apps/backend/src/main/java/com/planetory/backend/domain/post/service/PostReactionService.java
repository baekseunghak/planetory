package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.post.entity.Post;
import com.planetory.backend.domain.post.entity.PostReaction;
import com.planetory.backend.domain.post.repository.PostReactionRepository;
import com.planetory.backend.domain.post.repository.PostRepository;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class PostReactionService {
    private final PostRepository posts;
    private final PostReactionRepository reactions;
    private final MemberService members;
    private final Clock clock;

    public record Result(String postId, String myReaction, long agree, long disagree) {}
    public record ReactionList(List<PostService.Author> items, String nextCursor, boolean hasNext) {}

    @Transactional
    public Result put(long memberId, long postId, String reaction) {
        validate(reaction, true);
        var member = members.lockActive(memberId);
        // 글 수정·삭제와 같은 잠금. 반응 행이 아직 없어도 회원×글의 최초 INSERT를 직렬화한다.
        Post post = parent(postId, true);
        var existing = reactions.findByPostIdAndMemberId(postId, memberId);
        if ("NONE".equals(reaction)) existing.ifPresent(reactions::delete);
        else {
            String stored = reaction.toLowerCase(Locale.ROOT);
            Instant now = Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
            if (existing.isPresent()) existing.get().change(stored, now);
            else reactions.save(new PostReaction(post, member, stored, now));
        }
        reactions.flush();
        var summary = summary(postId, memberId);
        return new Result("p-" + postId, summary.myReaction(), summary.agree(), summary.disagree());
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PostService.ReactionSummary summary(long postId, long memberId) {
        parent(postId, false);
        var summary = reactions.summary(postId, memberId);
        return new PostService.ReactionSummary(summary.getAgree(), summary.getDisagree(), summary.getMyReaction());
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public ReactionList list(long postId, String reaction, int size, String cursor) {
        validate(reaction, false);
        if (size < 1 || size > 100) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        parent(postId, false);
        var after = cursor == null ? null : ReactionCursor.decode(cursor, postId, reaction, size);
        var limit = PageRequest.ofSize(size + 1);
        String stored = reaction.toLowerCase(Locale.ROOT);
        var page = after == null ? reactions.firstPage(postId, stored, limit)
                : reactions.after(postId, stored, after.time(), after.id(), limit);
        boolean hasNext = page.size() > size;
        var shown = hasNext ? page.subList(0, size) : page;
        String next = null;
        if (hasNext) {
            var last = shown.getLast();
            next = new ReactionCursor(postId, reaction, size, last.getUpdatedAt(), last.getId()).encode();
        }
        return new ReactionList(shown.stream().map(r -> new PostService.Author(
                "u-" + r.getMember().getId(), r.getMember().getNickname())).toList(), next, hasNext);
    }

    private Post parent(long id, boolean lock) {
        return (lock ? posts.findByIdForUpdate(id) : posts.findById(id))
                .filter(p -> "user".equals(p.getKind()) && "visible".equals(p.getStatus()))
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
    }

    private static void validate(String reaction, boolean allowNone) {
        if (!"AGREE".equals(reaction) && !"DISAGREE".equals(reaction) && !(allowNone && "NONE".equals(reaction)))
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
    }
}
