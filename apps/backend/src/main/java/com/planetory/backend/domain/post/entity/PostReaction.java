package com.planetory.backend.domain.post.entity;

import com.planetory.backend.domain.member.entity.Member;
import jakarta.persistence.*;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "post_reactions")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PostReaction {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "post_id", nullable = false, updatable = false)
    private Post post;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "user_id", nullable = false, updatable = false)
    private Member member;
    @Column(nullable = false) private String reaction;
    @Column(nullable = false) private Instant updatedAt;

    public PostReaction(Post post, Member member, String reaction, Instant now) {
        this.post = post;
        this.member = member;
        this.reaction = reaction;
        this.updatedAt = now;
    }

    public void change(String reaction, Instant now) {
        if (!this.reaction.equals(reaction)) {
            this.reaction = reaction;
            this.updatedAt = now;
        }
    }
}
