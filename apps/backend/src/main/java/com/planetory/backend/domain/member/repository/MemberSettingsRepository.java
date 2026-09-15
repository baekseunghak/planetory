package com.planetory.backend.domain.member.repository;

import com.planetory.backend.domain.member.entity.MemberSettings;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MemberSettingsRepository extends JpaRepository<MemberSettings, Long> {}
