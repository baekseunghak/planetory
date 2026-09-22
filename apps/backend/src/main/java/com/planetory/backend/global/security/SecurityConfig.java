package com.planetory.backend.global.security;

import com.planetory.backend.domain.auth.oauth.OAuthLoginSuccessHandler;
import com.planetory.backend.domain.auth.oauth.SsafyCallbackFilter;
import com.planetory.backend.domain.auth.oauth.SsafyOAuth2UserService;
import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.ErrorCode;
import jakarta.servlet.DispatcherType;
import java.time.Clock;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.HttpSessionOAuth2AuthorizedClientRepository;
import org.springframework.security.oauth2.client.web.OAuth2LoginAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.util.matcher.RequestMatcher;

@Configuration
// 웹 서버 없이 뜨는 운영 명령(PlanetoryApplication)에는 HttpSecurity가 없어 기동이 막힌다.
// 서버로 뜰 때는 항상 서블릿 앱이므로 적용 범위가 줄지 않는다 [S15P21C206-139].
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SecurityConfig {
    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, MemberService members, AuthSessionService sessions,
            SecurityErrorWriter errors, OAuthLoginSuccessHandler success, Clock clock, Environment environment,
            ObjectProvider<ClientRegistrationRepository> clients) throws Exception {
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
                            .requestMatchers(HttpMethod.GET, "/api/v1/auth/csrf", "/actuator/health").permitAll()
                            .requestMatchers(logoutPost).permitAll();
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
                .addFilterBefore(new SessionAuthenticationFilter(members, sessions, errors, clock), CsrfFilter.class);
        if (clients.getIfAvailable() != null) {
            http.addFilterBefore(new SsafyCallbackFilter(errors), OAuth2LoginAuthenticationFilter.class);
            http.oauth2Login(oauth -> oauth
                    .loginPage("/login")
                    .userInfoEndpoint(userInfo -> userInfo.userService(new SsafyOAuth2UserService()))
                    .authorizedClientRepository(new HttpSessionOAuth2AuthorizedClientRepository())
                    .successHandler(success)
                    .failureHandler((request, response, e) -> {
                        sessions.logout(request, response);
                        errors.write(response, ErrorCode.AUTH_REQUIRED);
                    }));
        }
        return http.build();
    }
}
