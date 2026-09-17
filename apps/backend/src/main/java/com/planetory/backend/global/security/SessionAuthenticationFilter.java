package com.planetory.backend.global.security;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.List;
import java.util.Locale;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** 인증 API만 활동으로 센다. CSRF/인가보다 먼저 검사해 미인증 변경 요청도 401로 응답한다. */
public class SessionAuthenticationFilter extends OncePerRequestFilter {
    private final MemberService members;
    private final AuthSessionService sessions;
    private final SecurityErrorWriter errors;
    private final Clock clock;

    public SessionAuthenticationFilter(MemberService members, AuthSessionService sessions,
                                       SecurityErrorWriter errors, Clock clock) {
        this.members = members;
        this.sessions = sessions;
        this.errors = errors;
        this.clock = clock;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (!path.startsWith("/api/v1/")) {
            chain.doFilter(request, response);
            return;
        }
        var receivedAt = clock.instant();
        boolean csrf = path.equals("/api/v1/auth/csrf") && request.getMethod().equals("GET");
        boolean logout = path.equals("/api/v1/auth/logout") && request.getMethod().equals("POST");
        // local 전용 무상태 예제도 로그인 활동에 포함하지 않는다. 공개 여부는 SecurityConfig가 결정한다.
        boolean hello = path.equals("/api/v1/hello");
        var authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.isAuthenticated()
                && authentication.getPrincipal() instanceof MemberPrincipal principal) {
            try {
                if (sessions.isExpired(request.getSession(false), receivedAt)) {
                    sessions.logout(request, response);
                    if (!logout) { errors.write(response, ErrorCode.AUTH_REQUIRED); return; }
                } else {
                    var member = members.requireActive(principal.memberId());
                    // 이 요청의 context만 교체한다. 세션에 저장한 역할이 이후 권한 변경을 우회하지 못한다.
                    var context = SecurityContextHolder.createEmptyContext();
                    context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(principal, null,
                            List.of(new SimpleGrantedAuthority("ROLE_" + member.getRole().toUpperCase(Locale.ROOT)))));
                    SecurityContextHolder.setContext(context);
                    if (!csrf && !logout && !hello) sessions.touch(request.getSession(false), receivedAt);
                }
            } catch (BusinessException e) {
                sessions.logout(request, response);
                errors.write(response, e.getErrorCode());
                return;
            } catch (DataAccessException e) {
                errors.write(response, ErrorCode.DEPENDENCY_UNAVAILABLE);
                return;
            } catch (IllegalStateException e) {
                // 다른 탭의 로그아웃과 경합해 이미 무효화된 세션.
                SecurityContextHolder.clearContext();
                errors.write(response, ErrorCode.AUTH_REQUIRED);
                return;
            }
        } else if (!csrf && !logout && !hello) {
            errors.write(response, ErrorCode.AUTH_REQUIRED);
            return;
        }
        chain.doFilter(request, response);
    }
}
