package com.planetory.backend.domain.member.entity;

import com.planetory.backend.global.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "users")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Member extends BaseTimeEntity {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    @Column(nullable = false, updatable = false) private String provider;
    @Column(nullable = false, updatable = false) private String providerUserId;
    @Column(nullable = false) private String nickname;
    @Column(nullable = false) private String role = "member";
    @Column(nullable = false) private String status = "active";

    public Member(String provider, String providerUserId, String nickname) {
        this.provider = provider;
        this.providerUserId = providerUserId;
        this.nickname = nickname;
    }
}
