package com.planetory.backend.domain.post.entity;

import com.planetory.backend.domain.member.entity.Member;
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
import org.hibernate.annotations.Generated;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "posts")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Post extends BaseTimeEntity {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false, updatable = false) private String kind;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "user_id", nullable = false, updatable = false)
    private Member author;
    @Column(nullable = false) private String board;
    private Long ticId;
    private String tag;
    @Column(nullable = false) private String title;
    @Column(nullable = false) private String body;
    @Column(nullable = false) private String status;
    // 생성 시각은 DB DEFAULT가 채운다. created_at과 같은 INSERT의 CURRENT_TIMESTAMP라 두 값이 정확히 같다.
    // 갱신 시각만 서비스가 정한다(BaseTimeEntity 주석).
    @Generated
    @Column(name = "updated_at", nullable = false, insertable = false) private Instant updatedAt;

    public Post(Member author, String board, Long ticId, String tag, String title, String body) {
        this.kind = "user";
        this.author = author;
        this.board = board;
        this.ticId = ticId;
        this.tag = tag;
        this.title = title;
        this.body = body;
        this.status = "visible";
    }

    public void update(String board, Long ticId, String tag, String title, String body, Instant now) {
        this.board = board;
        this.ticId = ticId;
        this.tag = tag;
        this.title = title;
        this.body = body;
        this.updatedAt = now;
    }

    public void delete(Instant now) {
        this.status = "deleted";
        this.updatedAt = now;
    }
}
