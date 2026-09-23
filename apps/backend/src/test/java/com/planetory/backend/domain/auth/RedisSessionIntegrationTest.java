package com.planetory.backend.domain.auth;

import com.planetory.backend.PlanetoryApplication;
import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.global.security.RedisSessions;
import jakarta.servlet.http.HttpServletRequest;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.client.registration.*;
import org.springframework.security.oauth2.core.*;
import org.springframework.session.Session;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.*;
import tools.jackson.databind.ObjectMapper;
import static org.junit.jupiter.api.Assertions.*;

@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class RedisSessionIntegrationTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");
    @Container static final GenericContainer<?> REDIS = new GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);
    @Container static final GenericContainer<?> CACHE = new GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);
    static final AuthIntegrationTest.TestIdentityProvider IDP = new AuthIntegrationTest.TestIdentityProvider();
    static final AuthIntegrationTest.MutableClock TIME = new AuthIntegrationTest.MutableClock();
    final CookieManager cookies = new CookieManager();
    final HttpClient http = HttpClient.newBuilder().cookieHandler(cookies).build();
    final ObjectMapper json = new ObjectMapper();
    ConfigurableApplicationContext app;
    String base;

    @TestConfiguration(proxyBeanMethods = false)
    static class Config {
        @Bean @Primary Clock redisTestClock() { return TIME; }
        @Bean @Primary GalaxyLayout layout() { return new AuthIntegrationTest.TestGalaxyLayout(); }
        @Bean FailureProbe failureProbe() { return new FailureProbe(); }
        @Bean ClientRegistrationRepository clients() {
            return new InMemoryClientRegistrationRepository(client("google", true), client("ssafy", false));
        }
        static ClientRegistration client(String name, boolean oidc) {
            return client(name, oidc, IDP);
        }
        static ClientRegistration client(String name, boolean oidc, AuthIntegrationTest.TestIdentityProvider provider) {
            var builder = ClientRegistration.withRegistrationId(name).clientId("test-client").clientSecret("test-secret")
                    .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                    .redirectUri("{baseUrl}/login/oauth2/code/{registrationId}")
                    .authorizationUri(provider.url() + "/authorize").tokenUri(provider.url() + "/token")
                    .userInfoUri(provider.url() + "/userinfo").userNameAttributeName(oidc ? "sub" : "userId")
                    .clientAuthenticationMethod(oidc ? ClientAuthenticationMethod.CLIENT_SECRET_BASIC
                            : ClientAuthenticationMethod.CLIENT_SECRET_POST)
                    .scope(oidc ? new String[]{"openid", "profile"} : new String[]{});
            if (oidc) builder.issuerUri(provider.url()).jwkSetUri(provider.url() + "/jwks");
            return builder.build();
        }
    }
    @RestController
    static class FailureProbe {
        @GetMapping("/api/v1/test/session-large")
        byte[] large() { return new byte[1024 * 1024]; }
        @GetMapping("/api/v1/test/session-large-failure")
        byte[] largeFailure(HttpServletRequest request) {
            fail(request);
            return large();
        }
        @GetMapping("/api/v1/test/session-save-failure")
        ResponseEntity<Void> fail(HttpServletRequest request) {
            request.getSession().setAttribute("save-probe", "changed");
            REDIS.getDockerClient().pauseContainerCmd(REDIS.getContainerId()).exec();
            return ResponseEntity.noContent().build();
        }
    }
    void start() {
        start("framework");
    }
    void start(String forwardedHeadersStrategy) {
        app = new SpringApplicationBuilder(PlanetoryApplication.class, Config.class).run(
                "--spring.profiles.active=local", "--server.port=0", "--planetory.session.redis.enabled=true",
                "--server.forward-headers-strategy=" + forwardedHeadersStrategy,
                "--spring.datasource.url=" + DB.getJdbcUrl(), "--spring.datasource.username=" + DB.getUsername(),
                "--spring.datasource.password=" + DB.getPassword(),
                "--planetory.redis.session.host=" + REDIS.getHost(), "--planetory.redis.session.port=" + REDIS.getMappedPort(6379),
                "--planetory.redis.cache.host=" + CACHE.getHost(), "--planetory.redis.cache.port=" + CACHE.getMappedPort(6379),
                // 의도적으로 없는 optional 리소스로 개인 OAuth 파일 import를 대체한다. 제공자는 Config.clients()가 등록한다.
                "--spring.config.import=optional:classpath:/oauth-test-no-local.properties");
        base = "http://127.0.0.1:" + ((WebServerApplicationContext) app).getWebServer().getPort();
    }
    HttpResponse<String> get(String path, String... headers) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(base + path));
        if (headers.length > 0) request.headers(headers);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
    HttpResponse<String> logout(String header, String token) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(base + "/api/v1/auth/logout")).POST(HttpRequest.BodyPublishers.noBody());
        if (token != null) request.header(header, token);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
    Map<String, String> query(String url) {
        Map<String, String> values = new HashMap<>();
        for (String item : URI.create(url).getRawQuery().split("&")) {
            var pair = item.split("=", 2);
            values.put(URLDecoder.decode(pair[0], StandardCharsets.UTF_8), URLDecoder.decode(pair[1], StandardCharsets.UTF_8));
        }
        return values;
    }
    void login(String provider, boolean restartDuringCallback) throws Exception {
        // Boot의 기본 use-relative-redirects=false로 실제 HTTP Location은 절대 주소다.
        login(provider, restartDuringCallback, base, base + "/api/v1/me");
    }
    void login(String provider, boolean restartDuringCallback, String redirectBase, String successLocation,
               String... headers) throws Exception {
        var response = get("/oauth2/authorization/" + provider, headers);
        assertEquals(302, response.statusCode());
        var params = query(response.headers().firstValue("location").orElseThrow());
        assertEquals(redirectBase + "/login/oauth2/code/" + provider, params.get("redirect_uri"));
        String code = IDP.issue("redis-" + provider, params.get("nonce"), "");
        if (restartDuringCallback) {
            app.close(); start();
            successLocation = base + "/api/v1/me";
        }
        response = get("/login/oauth2/code/" + provider + "?state=" + URLEncoder.encode(params.get("state"), StandardCharsets.UTF_8)
                + (provider.equals("ssafy") ? "&Code=" : "&code=") + code, headers);
        assertEquals(302, response.statusCode());
        assertEquals(successLocation, response.headers().firstValue("location").orElseThrow());
        assertEquals(200, get("/api/v1/me").statusCode());
    }

    @BeforeAll void startApplication() {
        TIME.now = Instant.now();
        start();
        var jdbc = app.getBean(JdbcTemplate.class);
        for (int i = 1; i <= 5; i++) {
            jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,0,'published')", i);
            jdbc.update("INSERT INTO tutorial_stars(seq,tic_id,intent,active) VALUES (?,?,'deep_confirmed',true)", i, i);
        }
    }
    @BeforeEach void resetClient() {
        TIME.now = Instant.now();
        cookies.getCookieStore().removeAll();
    }
    @AfterAll void stopApplication() {
        if (app != null) app.close();
        IDP.server.stop(0);
    }

    @Test void forwardedHeadersRestoreExternalOAuthRedirectsAndNoneIgnoresThem() throws Exception {
        app.close();
        start("none");
        for (String provider : List.of("google", "ssafy")) {
            cookies.getCookieStore().removeAll();
            login(provider, false);
            cookies.getCookieStore().removeAll();
            login(provider, false, base, base + "/api/v1/me",
                    "Forwarded", "proto=https;host=attacker.example:9443;for=192.0.2.1",
                    "X-Forwarded-Proto", "https", "X-Forwarded-Host", "attacker.example",
                    "X-Forwarded-Port", "9443", "X-Forwarded-Prefix", "/untrusted",
                    "X-Forwarded-Ssl", "on", "X-Forwarded-For", "192.0.2.1");
        }
        app.close();
        try {
            start("framework");
            for (String provider : List.of("google", "ssafy")) {
                cookies.getCookieStore().removeAll();
                login(provider, false);
                cookies.getCookieStore().removeAll();
                // 신뢰 프록시가 외부 전달 헤더를 제거하고 다시 설정한 입력만 가정한다.
                login(provider, false, "https://service.example", "https://service.example/api/v1/me",
                        "X-Forwarded-Proto", "https", "X-Forwarded-Host", "service.example");
            }
        } finally {
            app.close();
            start();
        }
    }

    @Test void oauthStateAndLoginSurviveRestartAndLogoutRequiresFreshToken() throws Exception {
        assertEquals(403, logout("X-CSRF-TOKEN", null).statusCode());
        var before = json.readTree(get("/api/v1/auth/csrf").body());
        login("google", true); // OAuth 인가 상태도 앱 재시작을 통과한다.
        assertEquals(403, logout(before.get("headerName").asText(), before.get("token").asText()).statusCode());
        app.close(); start();
        assertEquals(200, get("/api/v1/me").statusCode());
        var token = json.readTree(get("/api/v1/auth/csrf").body());
        assertEquals(204, logout(token.get("headerName").asText(), token.get("token").asText()).statusCode());
        assertEquals(401, get("/api/v1/me").statusCode());
        assertEquals(403, logout(token.get("headerName").asText(), token.get("token").asText()).statusCode());
        token = json.readTree(get("/api/v1/auth/csrf").body());
        assertEquals(204, logout(token.get("headerName").asText(), token.get("token").asText()).statusCode());
    }

    @Test void csrfDoesNotExtendAuthenticatedIdleTimeout() throws Exception {
        login("ssafy", false);
        TIME.advance(Duration.ofMinutes(29));
        assertEquals(200, get("/api/v1/auth/csrf").statusCode());
        TIME.advance(Duration.ofMinutes(1));
        assertEquals(401, get("/api/v1/auth/csrf").statusCode());
        assertEquals(200, get("/api/v1/auth/csrf").statusCode());
        TIME.now = Instant.now();
        login("google", false);
        var token = json.readTree(get("/api/v1/auth/csrf").body());
        TIME.advance(Duration.ofMinutes(30));
        assertEquals(403, logout(token.get("headerName").asText(), token.get("token").asText()).statusCode());
        token = json.readTree(get("/api/v1/auth/csrf").body());
        assertEquals(204, logout(token.get("headerName").asText(), token.get("token").asText()).statusCode());
    }

    @Test void cacheFailureKeepsHealthAndAuthenticatedReadWriteAvailable() throws Exception {
        login("google", false);
        CACHE.getDockerClient().pauseContainerCmd(CACHE.getContainerId()).exec();
        try {
            var cache = new StringRedisTemplate(app.getBean("redisConnectionFactory", LettuceConnectionFactory.class));
            assertThrows(org.springframework.dao.DataAccessException.class, () -> cache.opsForValue().get("probe"));
            assertEquals(200, get("/actuator/health").statusCode());
            assertEquals(200, get("/api/v1/me").statusCode());
            var token = json.readTree(get("/api/v1/auth/csrf").body());
            var update = HttpRequest.newBuilder(URI.create(base + "/api/v1/me/onboarding"))
                    .header("Content-Type", "application/json")
                    .header(token.get("headerName").asText(), token.get("token").asText())
                    .method("PATCH", HttpRequest.BodyPublishers.ofString("{\"onboardingDone\":true}")).build();
            assertEquals(200, http.send(update, HttpResponse.BodyHandlers.ofString()).statusCode());
        } finally { CACHE.getDockerClient().unpauseContainerCmd(CACHE.getContainerId()).exec(); }
    }

    @Test void sessionFailureReturns503BeforeLargeResponseCommit() throws Exception {
        login("google", false);
        var large = get("/api/v1/test/session-large");
        assertEquals(200, large.statusCode());
        assertEquals(1024 * 1024, large.body().length());
        try {
            assertEquals(503, get("/api/v1/test/session-large-failure").statusCode());
        } finally { REDIS.getDockerClient().unpauseContainerCmd(REDIS.getContainerId()).exec(); }
        try {
            var failedSave = get("/api/v1/test/session-save-failure");
            assertEquals(503, failedSave.statusCode());
            assertEquals("DEPENDENCY_UNAVAILABLE", json.readTree(failedSave.body()).get("code").asText());
            assertEquals(503, get("/actuator/health").statusCode());
            long outageStart = System.nanoTime();
            try (var requests = Executors.newFixedThreadPool(3)) {
                var results = new ArrayList<Future<Integer>>();
                for (int i = 0; i < 3; i++) results.add(requests.submit(() -> get("/api/v1/me").statusCode()));
                for (var result : results) assertEquals(503, result.get(15, TimeUnit.SECONDS));
            }
            assertTrue(Duration.ofNanos(System.nanoTime() - outageStart).compareTo(Duration.ofSeconds(15)) < 0);
        } finally { REDIS.getDockerClient().unpauseContainerCmd(REDIS.getContainerId()).exec(); }
    }

    @Test void repositoryPreservesActivityAndRejectsStaleSaves() throws Exception {
        verifyRepository(app.getBean(RedisSessions.class));
    }

    @Test void anonymousCsrfCreatesOneThirtyMinuteSessionPerCookielessRequest() throws Exception {
        var redis = new StringRedisTemplate(app.getBean("sessionRedisConnectionFactory", LettuceConnectionFactory.class));
        var before = redis.keys("planetory:session:sessions:*");
        try (var client = HttpClient.newHttpClient()) {
            for (int i = 0; i < 5; i++) {
                var response = client.send(HttpRequest.newBuilder(URI.create(base + "/api/v1/auth/csrf")).build(),
                        HttpResponse.BodyHandlers.ofString());
                assertEquals(200, response.statusCode());
                assertTrue(response.headers().firstValue("set-cookie").isPresent());
            }
        }
        var added = redis.keys("planetory:session:sessions:*");
        added.removeAll(before);
        assertEquals(5, added.size());
        for (String key : added) assertTrue(redis.getExpire(key) > 1790 && redis.getExpire(key) <= 1800);
        redis.delete(added);
    }

    @Test void anonymousAccessTimeCannotMoveBackwards() {
        verifyAnonymousActivity(app.getBean(RedisSessions.class));
    }
    <S extends Session> void verifyAnonymousActivity(RedisSessions<S> sessions) {
        S session = sessions.createSession();
        sessions.save(session);
        S older = sessions.findById(session.getId()), newer = sessions.findById(session.getId());
        var latest = Instant.now().plusSeconds(10).truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        newer.setLastAccessedTime(latest);
        sessions.save(newer);
        sessions.save(older);
        assertEquals(latest, sessions.findById(session.getId()).getLastAccessedTime());
        sessions.deleteById(session.getId());
    }

    <S extends Session> void verifyRepository(RedisSessions<S> sessions) throws Exception {
        var now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        S session = sessions.createSession();
        session.setAttribute(RedisSessions.LAST_ACTIVITY, now);
        // 정상 콜백은 제공자 토큰을 즉시 제거한다. 저장소 직렬화 지원 자체도 합성 값으로 검증한다.
        session.setAttribute("authorized-client-probe", new org.springframework.security.oauth2.client.OAuth2AuthorizedClient(
                Config.client("ssafy", false), "fixture", new OAuth2AccessToken(
                OAuth2AccessToken.TokenType.BEARER, "test-only", now, now.plusSeconds(60))));
        sessions.save(session);
        assertInstanceOf(org.springframework.security.oauth2.client.OAuth2AuthorizedClient.class,
                sessions.findById(session.getId()).getAttribute("authorized-client-probe"));
        String id = session.getId();
        S stale = sessions.findById(id), recent = sessions.findById(id);
        recent.setAttribute(RedisSessions.LAST_ACTIVITY, now.plusSeconds(2));
        stale.setAttribute(RedisSessions.LAST_ACTIVITY, now.plusSeconds(1));
        var stored = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var newer = executor.submit(() -> { sessions.save(recent); stored.countDown(); });
            var older = executor.submit(() -> { stored.await(); sessions.save(stale); return null; });
            newer.get(10, TimeUnit.SECONDS); older.get(10, TimeUnit.SECONDS);
        }
        assertEquals(now.plusSeconds(2), sessions.findById(id).getAttribute(RedisSessions.LAST_ACTIVITY));
        var redis = new StringRedisTemplate(app.getBean("sessionRedisConnectionFactory", LettuceConnectionFactory.class));
        long ttl = redis.getExpire("planetory:session:sessions:" + id);
        assertTrue(ttl >= 1790 && ttl <= 1802);
        S csrfOnly = sessions.findById(id);
        csrfOnly.setLastAccessedTime(now.plusSeconds(100));
        sessions.save(csrfOnly);
        assertEquals(now.plusSeconds(2), sessions.findById(id).getLastAccessedTime());
        assertFalse(sessions.active(id, now.plusSeconds(1802), false));
        S inFlight = sessions.findById(id);
        sessions.deleteById(id);
        inFlight.setAttribute("late", "write");
        sessions.save(inFlight);
        assertNull(sessions.findById(id));
        S rotating = sessions.createSession();
        sessions.save(rotating);
        String oldId = rotating.getId();
        S oldRequest = sessions.findById(oldId);
        rotating.changeSessionId();
        sessions.save(rotating);
        oldRequest.setAttribute("late", "write");
        sessions.save(oldRequest);
        assertNull(sessions.findById(oldId));
        assertNotNull(sessions.findById(rotating.getId()));
        sessions.deleteById(rotating.getId());
        S missing = sessions.createSession();
        sessions.save(missing);
        assertFalse(sessions.active(missing.getId(), now, true));
        sessions.deleteById(missing.getId());
    }
}
