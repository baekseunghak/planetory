package com.planetory.backend.domain.post.repository;

import com.planetory.backend.domain.post.entity.PostReaction;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface PostReactionRepository extends JpaRepository<PostReaction, Long> {
    Optional<PostReaction> findByPostIdAndMemberId(long postId, long memberId);

    interface Summary {
        long getAgree();
        long getDisagree();
        String getMyReaction();
    }

    @Query(value = """
            SELECT count(*) FILTER (WHERE r.reaction='agree') AS agree,
                   count(*) FILTER (WHERE r.reaction='disagree') AS disagree,
                   coalesce(max(CASE WHEN r.user_id=:memberId THEN upper(r.reaction) END), 'NONE') AS "myReaction"
              FROM post_reactions r JOIN posts p ON p.id=r.post_id
              JOIN users u ON u.id=r.user_id AND u.status='active'
             WHERE r.post_id=:postId AND p.kind='user' AND p.status='visible'
            """, nativeQuery = true)
    Summary summary(long postId, long memberId);

    @Query("""
            select r from PostReaction r join fetch r.member
             where r.post.id=:postId and r.reaction=:reaction
               and r.member.status='active'
               and r.post.kind='user' and r.post.status='visible'
             order by r.updatedAt desc, r.id desc
            """)
    List<PostReaction> firstPage(long postId, String reaction, Pageable limit);

    @Query("""
            select r from PostReaction r join fetch r.member
             where r.post.id=:postId and r.reaction=:reaction
               and r.member.status='active'
               and r.post.kind='user' and r.post.status='visible'
               and (r.updatedAt < :afterTime or (r.updatedAt = :afterTime and r.id < :afterId))
             order by r.updatedAt desc, r.id desc
            """)
    List<PostReaction> after(long postId, String reaction, Instant afterTime, long afterId, Pageable limit);
}
