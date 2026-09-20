package com.planetory.backend.domain.member.repository;

import com.planetory.backend.domain.member.entity.MemberSettings;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface MemberSettingsRepository extends JpaRepository<MemberSettings, Long> {
    @Modifying
    @Query(value = "INSERT INTO user_settings(user_id, onboarding_done) VALUES (?1, true) "
            + "ON CONFLICT (user_id) DO UPDATE SET onboarding_done = true", nativeQuery = true)
    void completeOnboarding(long memberId);

    @Modifying
    @Query(value = "INSERT INTO user_settings(user_id, star_list_public) VALUES (?1, ?2) "
            + "ON CONFLICT (user_id) DO UPDATE SET star_list_public = EXCLUDED.star_list_public", nativeQuery = true)
    void changeStarListPublic(long memberId, boolean starListPublic);
}
