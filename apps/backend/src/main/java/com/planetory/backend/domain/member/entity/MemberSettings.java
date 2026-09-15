package com.planetory.backend.domain.member.entity;

import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "user_settings")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class MemberSettings {
    @Id private Long userId;
    @Column(nullable = false) private boolean starListPublic = true;
    @Column(nullable = false) private boolean onboardingDone;

    public MemberSettings(Long userId) { this.userId = userId; }
}
