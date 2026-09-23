package com.planetory.backend.global.security;

import com.planetory.backend.domain.auth.oauth.OAuthLoginSuccessHandler;
import com.planetory.backend.domain.auth.oauth.SsafyCallbackFilter;
import com.planetory.backend.domain.auth.oauth.SsafyOAuth2UserService;
import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.ErrorCode;
import jakarta.servlet.DispatcherType;
import java.time.Clock;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.HttpSessionOAuth2AuthorizedClientRepository;
import org.springframework.security.oauth2.client.web.OAuth2LoginAuthenticationFilter;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;

@Configuration
@EnableScheduling
@Slf4j
// 웹 서버 없이 뜨는 운영 명령(PlanetoryApplication)에는 HttpSecurity가 없어 기동이 막힌다.
// 서버로 뜰 때는 항상 서블릿 앱이므로 적용 범위가 줄지 않는다 [S15P21C206-139].
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, MemberService members, AuthSessionService sessions,
            SecurityErrorWriter errors, OAuthLoginSuccessHandler success, Clock clock, Environment environment,
            InternalApiProperties internal, ObjectProvider<ClientRegistrationRepository> clients) throws Exception {
        // 인가·CSRF 예외·토큰 검사가 같은 매처를 쓴다. 문자열을 각자 비교하면 디코딩 차이로
        // 한쪽만 통과하는 경로가 생긴다(MR !177 리뷰 P1).
        RequestMatcher internalPaths = PathPatternRequestMatcher.withDefaults()
                .matcher(InternalTokenFilter.PATTERN);
        RequestMatcher logoutPost = request -> request.getMethod().equals("POST")
                && request.getRequestURI().equals(request.getContextPath() + "/api/v1/auth/logout");
        http.httpBasic(basic -> basic.disable())
                .formLogin(form -> form.disable())
                .requestCache(cache -> cache.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED)
                        .sessionFixation(fixation -> fixation.changeSessionId()))
                .authorizeHttpRequests(auth -> {
                    auth.dispatcherTypeMatchers(DispatcherType.ERROR, DispatcherType.ASYNC).permitAll()
                            .requestMatchers("/login", "/oauth2/authorization/*", "/login/oauth2/code/*").permitAll()
                            .requestMatchers(HttpMethod.GET, "/api/v1/auth/csrf", "/actuator/health",
                                    "/api/v1/withdrawal-requests/*").permitAll()
                            .requestMatchers(logoutPost).permitAll();
                    // 내부 경로는 InternalTokenFilter의 서비스 토큰이 막는다. 회원 인증 대상이
                    // 아니므로 여기서 authenticated()로 두면 토큰이 맞아도 401이 된다.
                    auth.requestMatchers(internalPaths).permitAll();
                    if (environment.acceptsProfiles(Profiles.of("local"))) {
                        auth.requestMatchers("/swagger-ui/**", "/v3/api-docs/**", "/api/v1/hello").permitAll();
                    }
                    auth.requestMatchers("/api/v1/operator/**").hasRole("OPERATOR")
                            .anyRequest().authenticated();
                })
                .exceptionHandling(exceptions -> exceptions
                        .authenticationEntryPoint((request, response, e) -> errors.write(response, ErrorCode.AUTH_REQUIRED))
                        .accessDeniedHandler((request, response, e) -> errors.write(response, ErrorCode.FORBIDDEN)))
                .logout(logout -> logout.logoutUrl("/api/v1/auth/logout").deleteCookies("SESSION")
                        .logoutSuccessHandler((request, response, auth) -> response.setStatus(204)))
                // 내부 경로는 쿠키가 아니라 요청 헤더의 서비스 토큰으로 인증한다. 브라우저가
                // 교차 출처에서 그 헤더를 붙일 수 없으므로 CSRF가 막을 공격이 없다. 대신 토큰이
                // 없거나 틀리면 InternalTokenFilter가 먼저 401로 끝낸다.
                .csrf(csrf -> csrf.ignoringRequestMatchers(internalPaths))
                .addFilterBefore(new InternalTokenFilter(internal, errors, internalPaths), CsrfFilter.class)
                .addFilterBefore(new SessionAuthenticationFilter(members, sessions, errors, clock), CsrfFilter.class);
        if (clients.getIfAvailable() != null) {
            http.addFilterBefore(new SsafyCallbackFilter(errors), OAuth2LoginAuthenticationFilter.class);
            http.oauth2Login(oauth -> oauth
                    .loginPage("/login")
                    .userInfoEndpoint(userInfo -> userInfo.userService(new SsafyOAuth2UserService()))
                    .authorizedClientRepository(new HttpSessionOAuth2AuthorizedClientRepository())
                    .successHandler(success)
                    .failureHandler((request, response, e) -> {
                        log.warn("OAuth authentication failed: exception={} oauth_error={}",
                                e.getClass().getSimpleName(), safeOAuthErrorCode(e));
                        sessions.logout(request, response);
                        errors.write(response, ErrorCode.AUTH_REQUIRED);
                    }));
        }
        return http.build();
    }

    private static String safeOAuthErrorCode(AuthenticationException exception) {
        if (!(exception instanceof OAuth2AuthenticationException oauth)) return "unavailable";
        // 제공자 오류 코드는 외부 입력이다. 알려진 값만 그대로 쓰고 본문·URI·토큰은 기록하지 않는다.
        return switch (oauth.getError().getErrorCode()) {
            case "access_denied", "invalid_request", "invalid_client", "invalid_grant", "invalid_scope",
                    "unauthorized_client", "unsupported_grant_type", "unsupported_response_type",
                    "server_error", "temporarily_unavailable", "invalid_token_response",
                    "invalid_user_info_response", "invalid_id_token", "invalid_nonce",
                    "invalid_state_parameter", "authorization_request_not_found",
                    "client_registration_not_found", "missing_user_info_uri", "missing_user_name_attribute" ->
                    oauth.getError().getErrorCode();
            default -> "unrecognized";
        };
    }
}
