package com.planetory.backend.domain.auth;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.planetory.backend.domain.auth.oauth.OAuthLoginSuccessHandler;
import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.RedisSessions;
import com.planetory.backend.global.security.SecurityErrorWriter;
import java.time.Clock;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.core.ResolvableType;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClient;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.web.HttpSessionOAuth2AuthorizedClientRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.OAuth2AccessToken;
import org.springframework.security.oauth2.core.OAuth2RefreshToken;
import org.springframework.security.oauth2.core.user.DefaultOAuth2User;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.transaction.TransactionSystemException;
import tools.jackson.databind.ObjectMapper;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class OAuthLoginSuccessHandlerTest {
    @Test void initializationFailuresKeepResponsesClearSessionsAndLogOnlySafeDiagnostics() throws Exception {
        record Failure(RuntimeException exception, ErrorCode code, String branch, Level level) {}
        var failures = List.of(
                new Failure(new BusinessException(ErrorCode.AUTH_REQUIRED, "synthetic-private-message"),
                        ErrorCode.AUTH_REQUIRED, "business", Level.WARN),
                new Failure(new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE, "synthetic-private-message"),
                        ErrorCode.DEPENDENCY_UNAVAILABLE, "business", Level.WARN),
                new Failure(new DataAccessResourceFailureException("synthetic-private-message",
                        new IllegalArgumentException("synthetic-private-cause")),
                        ErrorCode.DEPENDENCY_UNAVAILABLE, "database", Level.ERROR),
                new Failure(new CannotCreateTransactionException("synthetic-private-message",
                        new IllegalArgumentException("synthetic-private-cause")),
                        ErrorCode.DEPENDENCY_UNAVAILABLE, "database", Level.ERROR),
                new Failure(new TransactionSystemException("synthetic-private-message"),
                        ErrorCode.INTERNAL_ERROR, "unexpected", Level.ERROR),
                new Failure(new IllegalStateException("synthetic-private-message",
                        new IllegalArgumentException("synthetic-private-cause")),
                        ErrorCode.INTERNAL_ERROR, "unexpected", Level.ERROR));
        var mapper = new ObjectMapper();
        var sessions = new AuthSessionService(Clock.systemUTC(), new DefaultListableBeanFactory()
                .getBeanProvider(ResolvableType.forClass(RedisSessions.class)),
                new MockEnvironment().withProperty("server.servlet.session.timeout", "30m"));
        var logger = (Logger) LoggerFactory.getLogger(OAuthLoginSuccessHandler.class);
        var logs = new ListAppender<ILoggingEvent>();
        logs.start();
        logger.addAppender(logs);
        try {
            for (var failure : failures) {
                logs.list.clear();
                var members = mock(MemberService.class);
                when(members.login("google", "synthetic-private-subject")).thenThrow(failure.exception());
                var handler = new OAuthLoginSuccessHandler(members, sessions, new SecurityErrorWriter(mapper),
                        "/api/v1/me");
                var request = new MockHttpServletRequest();
                var response = new MockHttpServletResponse();
                var session = new MockHttpSession();
                request.setSession(session);
                var authorities = List.of(new SimpleGrantedAuthority("ROLE_USER"));
                var oauth = new OAuth2AuthenticationToken(new DefaultOAuth2User(authorities,
                        Map.of("sub", "synthetic-private-subject", "email", "synthetic-private-attribute"), "sub"),
                        authorities, "google");
                var context = SecurityContextHolder.createEmptyContext();
                context.setAuthentication(oauth);
                SecurityContextHolder.setContext(context);
                session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, context);
                var client = ClientRegistration.withRegistrationId("google").clientId("synthetic-client")
                        .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                        .redirectUri("https://example.invalid/login/oauth2/code/google")
                        .authorizationUri("https://example.invalid/authorize")
                        .tokenUri("https://example.invalid/token").build();
                var clients = new HttpSessionOAuth2AuthorizedClientRepository();
                clients.saveAuthorizedClient(new OAuth2AuthorizedClient(client, oauth.getName(),
                        new OAuth2AccessToken(OAuth2AccessToken.TokenType.BEARER, "synthetic-private-access",
                                Instant.EPOCH, Instant.EPOCH.plusSeconds(300)),
                        new OAuth2RefreshToken("synthetic-private-refresh", Instant.EPOCH)), oauth, request, response);
                assertNotNull(clients.loadAuthorizedClient("google", oauth, request));

                handler.onAuthenticationSuccess(request, response, oauth);

                assertEquals(failure.code().getStatus().value(), response.getStatus());
                assertEquals(failure.code().name(), mapper.readTree(response.getContentAsString()).path("code").asText());
                assertEquals("no-store", response.getHeader("Cache-Control"));
                assertNull(response.getRedirectedUrl());
                assertTrue(session.isInvalid());
                assertNull(request.getSession(false));
                assertNull(SecurityContextHolder.getContext().getAuthentication());
                assertNotNull(response.getCookie("SESSION"));
                assertEquals(0, response.getCookie("SESSION").getMaxAge());
                assertEquals(1, logs.list.size());
                var event = logs.list.getFirst();
                assertEquals(failure.level(), event.getLevel());
                assertEquals("OAuth member initialization failed: branch=" + failure.branch()
                        + " code=" + failure.code() + " exception=" + failure.exception().getClass().getSimpleName(),
                        event.getFormattedMessage());
                assertNull(event.getThrowableProxy());
                assertFalse((event.getFormattedMessage() + Arrays.toString(event.getArgumentArray())
                        + response.getContentAsString()).contains("synthetic-private-"));
                verify(members).login("google", "synthetic-private-subject");
            }
        } finally {
            SecurityContextHolder.clearContext();
            logger.detachAppender(logs);
            logs.stop();
        }
    }
}
