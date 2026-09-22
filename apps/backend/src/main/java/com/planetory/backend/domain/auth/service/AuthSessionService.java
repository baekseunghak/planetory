package com.planetory.backend.domain.auth.service;

import com.planetory.backend.domain.member.entity.Member;
import com.planetory.backend.global.security.MemberPrincipal;
import com.planetory.backend.global.security.RedisSessions;
import org.springframework.beans.factory.ObjectProvider;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import java.time.Clock;
import java.time.Duration;
import org.springframework.boot.convert.DurationStyle;
import org.springframework.core.env.Environment;
import java.time.Instant;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.logout.CookieClearingLogoutHandler;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.stereotype.Service;

@Service
public class AuthSessionService {
    private static final String LAST_ACTIVITY = RedisSessions.LAST_ACTIVITY;
    private final Duration idleTimeout;
    private final Clock clock;
    private final ObjectProvider<RedisSessions<?>> redisSessions;

    public AuthSessionService(Clock clock, ObjectProvider<RedisSessions<?>> redisSessions, Environment environment) {
        this.clock = clock;
        this.redisSessions = redisSessions;
        this.idleTimeout = DurationStyle.detectAndParse(environment.getRequiredProperty("server.servlet.session.timeout"));
    }

    public void login(Member member, HttpServletRequest request, HttpServletResponse response) {
        // OAuth2LoginAuthenticationFilter의 세션 ID 교체·CSRF 토큰 교체 이후 호출된다.
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                new MemberPrincipal(member.getId()), null,
                List.of(new SimpleGrantedAuthority("ROLE_" + member.getRole().toUpperCase(java.util.Locale.ROOT)))));
        SecurityContextHolder.setContext(context);
        new HttpSessionSecurityContextRepository().saveContext(context, request, response);
        HttpSession session = request.getSession();
        session.setMaxInactiveInterval((int) idleTimeout.toSeconds());
        session.setAttribute(LAST_ACTIVITY, clock.instant());
    }

    public boolean isExpired(HttpSession session, Instant receivedAt) {
        if (session == null) return true;
        var repository = redisSessions.getIfAvailable();
        // ponytail: MockHttpSession 회귀 이관 완료 시 테스트 전용 메모리 폴백과 Gradle 비활성 속성을 함께 제거한다.
        if (repository != null) return !repository.active(session.getId(), receivedAt, false);
        var last = session.getAttribute(LAST_ACTIVITY);
        return !(last instanceof Instant instant) || !receivedAt.isBefore(instant.plus(idleTimeout));
    }

    public void touch(HttpSession session, Instant receivedAt) {
        if (session == null) throw new IllegalStateException("Session was invalidated");
        var repository = redisSessions.getIfAvailable();
        if (repository != null && !repository.active(session.getId(), receivedAt, true)) {
            throw new IllegalStateException("Session was invalidated");
        }
        var last = session.getAttribute(LAST_ACTIVITY);
        if (!(last instanceof Instant instant)) throw new IllegalStateException("Session activity is missing");
        if (receivedAt.isAfter(instant)) session.setAttribute(LAST_ACTIVITY, receivedAt);
    }

    public void logout(HttpServletRequest request, HttpServletResponse response) {
        new SecurityContextLogoutHandler().logout(request, response, SecurityContextHolder.getContext().getAuthentication());
        new CookieClearingLogoutHandler("SESSION").logout(request, response, null);
    }
}
