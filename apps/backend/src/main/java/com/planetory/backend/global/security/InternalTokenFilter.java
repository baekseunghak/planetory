package com.planetory.backend.global.security;

import com.planetory.backend.global.error.ErrorCode;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 내부 경로({@code /internal/**})의 서비스 토큰 검사 [S15P21C206-150].
 *
 * <p>회원 세션이 아니라 공유 비밀로 인증한다. 부르는 쪽이 Publisher 배치라 로그인할 사람이 없다.
 *
 * <p><b>토큰이 설정되지 않았으면 모두 막는다.</b> 설정 누락이 인증 없는 경로로 이어지면 안 된다.
 *
 * <p>비교는 {@link MessageDigest#isEqual}로 한다. {@code String.equals}는 다른 첫 글자에서 바로
 * 끝나 응답 시간으로 토큰을 한 글자씩 맞춰 볼 수 있다.
 */
public final class InternalTokenFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Planetory-Service-Token";
    public static final String PREFIX = "/internal/";

    private final InternalApiProperties properties;
    private final SecurityErrorWriter errors;

    public InternalTokenFilter(InternalApiProperties properties, SecurityErrorWriter errors) {
        this.properties = properties;
        this.errors = errors;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (!path.startsWith(PREFIX)) {
            chain.doFilter(request, response);
            return;
        }
        if (!properties.enabled() || !matches(request.getHeader(HEADER))) {
            errors.write(response, ErrorCode.AUTH_REQUIRED);
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean matches(String presented) {
        if (presented == null) {
            return false;
        }
        return MessageDigest.isEqual(properties.serviceToken().getBytes(StandardCharsets.UTF_8),
                presented.getBytes(StandardCharsets.UTF_8));
    }
}
