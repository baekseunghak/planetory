package com.planetory.backend.global.security;

import com.planetory.backend.global.error.ErrorCode;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 내부 경로({@code /internal/**})의 서비스 토큰 검사 [S15P21C206-150].
 *
 * <p>회원 세션이 아니라 공유 비밀로 인증한다. 부르는 쪽이 Publisher 배치라 로그인할 사람이 없다.
 *
 * <p><b>토큰이 설정되지 않았으면 모두 막는다.</b> 설정 누락이 인증 없는 경로로 이어지면 안 된다.
 *
 * <p><b>경로 판별은 {@code SecurityConfig}가 쓰는 것과 같은 매처로 한다.</b> 두 곳이 다른 방식으로
 * 경로를 보면 그 차이가 그대로 우회 통로가 된다. {@code getRequestURI()}는 서블릿 규약대로 디코딩하지
 * 않은 값을 주는데 Security의 인가 판정과 MVC 라우팅은 디코딩한 경로를 쓰므로, 원본 문자열을 직접
 * 비교하면 {@code /%69nternal/…}이 이 필터에는 다른 경로로, 라우팅에는 같은 경로로 보인다
 * (MR !177 리뷰, 백승학).
 *
 * <p>비교는 {@link MessageDigest#isEqual}로 한다. {@code String.equals}는 다른 첫 글자에서 바로
 * 끝나 응답 시간으로 토큰을 한 글자씩 맞춰 볼 수 있다.
 */
public final class InternalTokenFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Planetory-Service-Token";

    /** 인가 설정·CSRF 예외·이 필터가 모두 이 하나를 쓴다. 갈라지면 그 차이가 우회 통로가 된다. */
    public static final String PATTERN = "/internal/**";

    private final InternalApiProperties properties;
    private final SecurityErrorWriter errors;
    private final RequestMatcher internalPaths;

    public InternalTokenFilter(InternalApiProperties properties, SecurityErrorWriter errors,
                               RequestMatcher internalPaths) {
        this.properties = properties;
        this.errors = errors;
        this.internalPaths = internalPaths;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!internalPaths.matches(request)) {
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
