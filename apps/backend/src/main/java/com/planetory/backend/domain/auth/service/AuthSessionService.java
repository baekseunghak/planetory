package com.planetory.backend.domain.auth.service;

import com.planetory.backend.domain.member.entity.Member;
import com.planetory.backend.global.security.MemberPrincipal;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.logout.CookieClearingLogoutHandler;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class AuthSessionService {
    private static final String LAST_ACTIVITY = AuthSessionService.class.getName() + ".lastActivity";
    private static final Duration IDLE_TIMEOUT = Duration.ofMinutes(30);
    private final Clock clock;

    public void login(Member member, HttpServletRequest request, HttpServletResponse response) {
        // OAuth2LoginAuthenticationFilter의 세션 ID 교체·CSRF 토큰 교체 이후 호출된다.
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                new MemberPrincipal(member.getId()), null,
                List.of(new SimpleGrantedAuthority("ROLE_" + member.getRole().toUpperCase(java.util.Locale.ROOT)))));
        SecurityContextHolder.setContext(context);
        new HttpSessionSecurityContextRepository().saveContext(context, request, response);
        HttpSession session = request.getSession();
        session.setMaxInactiveInterval((int) IDLE_TIMEOUT.toSeconds());
        session.setAttribute(LAST_ACTIVITY, clock.instant());
    }

    public boolean isExpired(HttpSession session, Instant receivedAt) {
        if (session == null) return true;
        synchronized (session) {
            var last = session.getAttribute(LAST_ACTIVITY);
            return !(last instanceof Instant instant) || !receivedAt.isBefore(instant.plus(IDLE_TIMEOUT));
        }
    }

    public void touch(HttpSession session, Instant receivedAt) {
        synchronized (session) {
            var last = (Instant) session.getAttribute(LAST_ACTIVITY);
            // 병렬 요청의 처리 순서가 바뀌어도 마지막 접수 시각을 과거로 되돌리지 않는다.
            if (receivedAt.isAfter(last)) session.setAttribute(LAST_ACTIVITY, receivedAt);
        }
    }

    public void logout(HttpServletRequest request, HttpServletResponse response) {
        new SecurityContextLogoutHandler().logout(request, response, SecurityContextHolder.getContext().getAuthentication());
        new CookieClearingLogoutHandler("SESSION").logout(request, response, null);
    }
}
