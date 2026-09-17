package com.planetory.backend.domain.comment.entity;

import com.planetory.backend.domain.member.entity.Member;
import com.planetory.backend.domain.post.entity.Post;
import com.planetory.backend.global.entity.BaseTimeEntity;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Generated;

@Entity
@Table(name = "comments")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Comment extends BaseTimeEntity {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "post_id", nullable = false, updatable = false)
    private Post post;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "user_id", nullable = false, updatable = false)
    private Member author;
    @Column(nullable = false) private String body;
    @Column(nullable = false) private String status;
    @Generated
    @Column(name = "updated_at", nullable = false, insertable = false) private Instant updatedAt;

    public Comment(Post post, Member author, String body) {
        this.post = post;
        this.author = author;
        this.body = body;
        this.status = "visible";
    }

    public void update(String body, Instant now) {
        this.body = body;
        this.updatedAt = now;
    }

    public void delete(Instant now) {
        this.status = "deleted";
        this.updatedAt = now;
    }
}
