package com.planetory.backend.domain.member.service;

import com.planetory.backend.domain.exploration.service.InitialExplorationService;
import com.planetory.backend.domain.member.entity.Member;
import com.planetory.backend.domain.member.entity.MemberSettings;
import com.planetory.backend.domain.member.repository.MemberRepository;
import com.planetory.backend.domain.member.repository.MemberSettingsRepository;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.text.Normalizer;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;

@Service
@RequiredArgsConstructor
public class MemberService {
    private final MemberRepository members;
    private final MemberSettingsRepository settings;
    private final InitialExplorationService exploration;
    private final PlatformTransactionManager transactionManager;
    private final JdbcClient jdbc;

    // 검증된 제공자 응답에서만 호출한다. 외부 요청의 provider ID를 받는 API는 없다.
    public Member login(String provider, String subject) {
        if (!Set.of("google", "ssafy").contains(provider) || subject == null || subject.isBlank()) {
            throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        }
        var existing = members.findByProviderAndProviderUserId(provider, subject);
        if (existing.isPresent()) return requireActive(existing.get());
        try {
            return new TransactionTemplate(transactionManager).execute(status -> {
                // 20자 이내, 영문·숫자·밑줄만 사용. DB lower(nickname) 유일 제약도 적용된다.
                var member = members.saveAndFlush(new Member(provider, subject,
                        "별_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16)));
                settings.saveAndFlush(new MemberSettings(member.getId()));
                exploration.initialize(member.getId());
                return member;
            });
        } catch (DataIntegrityViolationException collision) {
            // PostgreSQL에서 실패한 트랜잭션을 종료한 뒤, 동시 가입으로 먼저 저장된 회원을 읽는다.
            return members.findByProviderAndProviderUserId(provider, subject)
                    .map(this::requireActive).orElseThrow(() -> collision);
        }
    }

    public Member requireActive(long memberId) {
        return requireActive(members.findById(memberId)
                .orElseThrow(() -> new BusinessException(ErrorCode.AUTH_REQUIRED)));
    }

    /** 쓰기 트랜잭션의 첫 잠금. 탈퇴 상태 확정과 회원 쓰기를 같은 DB 순서로 직렬화한다. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Member lockActive(long memberId) {
        if (jdbc.sql("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE")
                .param(memberId).query(Long.class).optional().isEmpty()) {
            throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        }
        return requireActive(memberId);
    }

    private Member requireActive(Member member) {
        if (!"active".equals(member.getStatus())) throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        return member;
    }

    public MemberSettings settings(long memberId) {
        return settings.findById(memberId).orElseGet(() -> new MemberSettings(memberId));
    }

    public Member publicProfile(long memberId) {
        return members.findById(memberId).filter(member -> "active".equals(member.getStatus()))
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
    }

    public Member changeNickname(long memberId, String input) {
        if (input == null) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        String nickname = Normalizer.normalize(input.strip(), Normalizer.Form.NFC);
        if (!nickname.matches("[가-힣A-Za-z0-9_]{2,20}")
                || Set.of("system", "admin", "관리자", "운영자").contains(nickname.toLowerCase(Locale.ROOT))) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        try {
            return new TransactionTemplate(transactionManager).execute(status -> {
                var member = lockActive(memberId);
                member.changeNickname(nickname);
                return members.saveAndFlush(member);
            });
        } catch (DataIntegrityViolationException collision) {
            throw new BusinessException(ErrorCode.NICKNAME_CONFLICT);
        }
    }

    @Transactional
    public void completeOnboarding(long memberId) {
        lockActive(memberId);
        settings.completeOnboarding(memberId);
    }

    @Transactional
    public boolean changeStarListVisibility(long memberId, String visibility) {
        boolean starListPublic;
        if ("PUBLIC".equals(visibility)) starListPublic = true;
        else if ("PRIVATE".equals(visibility)) starListPublic = false;
        else throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        lockActive(memberId);
        settings.changeStarListPublic(memberId, starListPublic);
        return starListPublic;
    }
}
