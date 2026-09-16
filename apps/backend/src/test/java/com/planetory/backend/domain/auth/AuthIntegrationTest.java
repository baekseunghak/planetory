package com.planetory.backend.domain.auth;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.security.MemberPrincipal;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import javax.sql.DataSource;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.oauth2.client.registration.*;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 외부 자격 증명 없이 실제 code 교환·OIDC 서명·state/nonce 검증과 DB 가입을 함께 실행한다. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AuthIntegrationTest {
    private static final String SCHEMA = "backend_test_" + UUID.randomUUID().toString().replace("-", "");
    private static final TestIdentityProvider IDP = new TestIdentityProvider();
    private static final MutableClock TIME = new MutableClock();
    private static final TestGalaxyLayout LAYOUT = new TestGalaxyLayout();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Config {
        @Bean @Primary Clock authTestClock() { return TIME; }
        @Bean @Primary GalaxyLayout testGalaxyLayout() { return LAYOUT; }
        @Bean ClientRegistrationRepository testClients() {
            return new InMemoryClientRegistrationRepository(client("google", true), client("ssafy", false));
        }
        private ClientRegistration client(String name, boolean oidc) {
            var builder = ClientRegistration.withRegistrationId(name)
                    .clientId("test-client").clientSecret("test-secret")
                    .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                    .redirectUri("{baseUrl}/login/oauth2/code/{registrationId}")
                    .authorizationUri(IDP.url() + "/authorize")
                    .tokenUri(IDP.url() + "/token")
                    .userInfoUri(IDP.url() + "/userinfo")
                    .userNameAttributeName(oidc ? "sub" : "userId")
                    .clientAuthenticationMethod(oidc ? ClientAuthenticationMethod.CLIENT_SECRET_BASIC
                            : ClientAuthenticationMethod.CLIENT_SECRET_POST)
                    .scope(oidc ? new String[]{"openid", "profile"} : new String[]{});
            if (oidc) builder.issuerUri(IDP.url()).jwkSetUri(IDP.url() + "/jwks");
            return builder.build();
        }
    }

    @Autowired MockMvc mvc;
    @Autowired MemberService members;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper mapper;

    @BeforeEach
    void resetOnlyTestData() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        for (int i = 1; i <= 5; i++) {
            jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", i);
            jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (?, ?, 'deep_confirmed', true)", i, i);
        }
        TIME.now = Instant.parse("2026-09-15T01:00:00Z");
        LAYOUT.fail = false;
    }

    @AfterAll
    static void cleanup(@Autowired DataSource dataSource) {
        IDP.server.stop(0);
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Test
    void googleAndSsafyLoginUseProviderIdentityAndInitializeOnlyOnce() throws Exception {
        var google = login("google", "same-id");
        mvc.perform(get("/api/v1/me").session(google))
                .andExpect(status().isOk()).andExpect(jsonPath("$.role").value("MEMBER"))
                .andExpect(jsonPath("$.memberId").value("u-" + memberId(google)))
                .andExpect(jsonPath("$.onboardingDone").value(false))
                .andExpect(jsonPath("$.tutorialCompleted").value(false))
                .andExpect(jsonPath("$.achievementSummary.discoveredStarCount").value(1))
                .andExpect(jsonPath("$.achievementSummary.signalCount").value(0))
                .andExpect(jsonPath("$.providerUserId").doesNotExist())
                .andExpect(jsonPath("$.email").doesNotExist())
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")));
        assertEquals(memberId(google), memberId(login("google", "same-id")));
        assertNotEquals(memberId(google), memberId(login("ssafy", "same-id")));
        assertEquals(2, count("users"));
        assertEquals(2, count("user_settings"));
        assertEquals(2, count("star_unlocks"));
        assertEquals(2, count("user_star_progress"));
        // 첫 별은 튜토리얼 1번이며 좌표·배치 버전은 배치 함수 결과를 그대로 저장한다.
        var unlocks = jdbc.queryForList("""
                SELECT user_id, tic_id, unlock_reason, world_x::float8 AS x, world_y::float8 AS y,
                       depth_z::float8 AS z, layout_version, generation FROM star_unlocks""");
        for (var row : unlocks) {
            var expected = LAYOUT.place((Long) row.get("user_id"), (Long) row.get("tic_id"));
            assertEquals(1L, row.get("tic_id"));
            assertEquals("tutorial", row.get("unlock_reason"));
            assertEquals(expected.worldX(), (Double) row.get("x"));
            assertEquals(expected.worldY(), (Double) row.get("y"));
            assertEquals(expected.depthZ(), (Double) row.get("z"));
            assertEquals(TestGalaxyLayout.VERSION, row.get("layout_version"));
            assertNull(row.get("generation"));
        }
        assertTrue(jdbc.queryForObject("SELECT bool_and(nickname ~ '^별_[a-f0-9]{16}$') FROM users", Boolean.class));
        assertTrue(Collections.list(google.getAttributeNames()).stream().noneMatch(name -> name.contains("AUTHORIZED_CLIENT")));
    }

    @Test
    void profileNicknameValidationAndConflictUseCurrentMember() throws Exception {
        var first = login("google", "profile-first");
        var second = login("google", "profile-second");
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content("{\"nickname\":\"  관측자_1  \"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.nickname").value("관측자_1"));
        mvc.perform(get("/api/v1/me").session(first)).andExpect(jsonPath("$.nickname").value("관측자_1"));
        mvc.perform(patch("/api/v1/me/profile").session(second).with(csrf())
                        .contentType("application/json").content("{\"nickname\":\"관측자_1\"}"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("NICKNAME_CONFLICT"));
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content("{\"nickname\":\"Explorer\"}"))
                .andExpect(status().isOk());
        mvc.perform(patch("/api/v1/me/profile").session(second).with(csrf())
                        .contentType("application/json").content("{\"nickname\":\"explorer\"}"))
                .andExpect(status().isConflict());
        for (String nickname : List.of("ADMIN", "가", "내부 공백", "a@b")) {
            mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                            .contentType("application/json").content(mapper.writeValueAsString(Map.of("nickname", nickname))))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content("null"))
                .andExpect(status().isBadRequest());
    }

    /** SB-D14의 "NFC·앞뒤 공백 제거 후 2~20자" 중 정규화 동작과 길이 경계를 직접 확인한다. */
    @Test
    void nicknameIsStoredAsNfcAndLengthBoundsFollowSbD14() throws Exception {
        var first = login("google", "nfc-first");
        var second = login("google", "nfc-second");
        // 조합형(NFD) 한글 6코드포인트. 정규화하지 않으면 완성형 정규식에 걸려 400이 된다.
        String decomposed = "가나다";
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content(mapper.writeValueAsString(Map.of("nickname", decomposed))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.nickname").value("가나다"));
        assertEquals(3, jdbc.queryForObject("SELECT length(nickname) FROM users WHERE id = ?", Integer.class, memberId(first)));
        // 저장값이 NFC이므로 완성형으로 보낸 다른 회원도 같은 이름으로 본다.
        mvc.perform(patch("/api/v1/me/profile").session(second).with(csrf())
                        .contentType("application/json").content(mapper.writeValueAsString(Map.of("nickname", "가나다"))))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("NICKNAME_CONFLICT"));
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content(mapper.writeValueAsString(Map.of("nickname", "a".repeat(20)))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.nickname").value("a".repeat(20)));
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content(mapper.writeValueAsString(Map.of("nickname", "a".repeat(21)))))
                .andExpect(status().isBadRequest());
        // 공백 제거 후 20자면 통과한다. 제거 전 길이로 재면 실패한다.
        mvc.perform(patch("/api/v1/me/profile").session(first).with(csrf())
                        .contentType("application/json").content(mapper.writeValueAsString(Map.of("nickname", "  " + "b".repeat(20) + "  "))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.nickname").value("b".repeat(20)));
    }

    @Test
    void onboardingOnlyMovesToTrueAndKeepsOtherSettings() throws Exception {
        var session = login("google", "onboarding");
        long id = memberId(session);
        jdbc.update("UPDATE user_settings SET star_list_public = false, notification_prefs = '{\"achievement\":false}'::jsonb WHERE user_id = ?", id);
        mvc.perform(patch("/api/v1/me/onboarding").session(session).with(csrf())
                        .contentType("application/json").content("{\"onboardingDone\":true}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.onboardingDone").value(true));
        mvc.perform(patch("/api/v1/me/onboarding").session(session).with(csrf())
                        .contentType("application/json").content("{\"onboardingDone\":true}"))
                .andExpect(status().isOk());
        for (String value : List.of("false", "null")) {
            mvc.perform(patch("/api/v1/me/onboarding").session(session).with(csrf())
                            .contentType("application/json").content("{\"onboardingDone\":" + value + "}"))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(patch("/api/v1/me/onboarding").session(session).with(csrf())
                        .contentType("application/json").content("null"))
                .andExpect(status().isBadRequest());
        assertTrue(jdbc.queryForObject("SELECT onboarding_done FROM user_settings WHERE user_id = ?", Boolean.class, id));
        assertFalse(jdbc.queryForObject("SELECT star_list_public FROM user_settings WHERE user_id = ?", Boolean.class, id));
        assertEquals("false", jdbc.queryForObject("SELECT notification_prefs ->> 'achievement' FROM user_settings WHERE user_id = ?", String.class, id));
        mvc.perform(get("/api/v1/me").session(login("google", "onboarding")))
                .andExpect(jsonPath("$.onboardingDone").value(true));
        jdbc.update("DELETE FROM user_settings WHERE user_id = ?", id);
        mvc.perform(patch("/api/v1/me/onboarding").session(session).with(csrf())
                        .contentType("application/json").content("{\"onboardingDone\":true}"))
                .andExpect(status().isOk());
        assertEquals(1, count("user_settings"));
        jdbc.update("DELETE FROM user_settings WHERE user_id = ?", id);
        var start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var requests = List.of(executor.submit(() -> { start.await(); members.completeOnboarding(id); return true; }),
                    executor.submit(() -> { start.await(); members.completeOnboarding(id); return true; }));
            start.countDown();
            for (var request : requests) assertTrue(request.get(10, TimeUnit.SECONDS));
        }
        assertEquals(1, count("user_settings"));
        assertTrue(jdbc.queryForObject("SELECT onboarding_done FROM user_settings WHERE user_id = ?", Boolean.class, id));
    }

    @Test
    void publicProfileShowsOnlyPublicSummaryEvenWhenStarListIsPrivate() throws Exception {
        var viewer = login("google", "viewer");
        var owner = login("google", "owner");
        long id = memberId(owner);
        jdbc.update("UPDATE user_settings SET star_list_public = false WHERE user_id = ?", id);
        mvc.perform(get("/api/v1/members/u-" + id).session(viewer))
                .andExpect(status().isOk()).andExpect(jsonPath("$.starListVisibility").value("PRIVATE"))
                .andExpect(jsonPath("$.achievementSummary.signalCount").value(0))
                .andExpect(jsonPath("$.achievementSummary.starCountByGrade.A").value(0))
                .andExpect(jsonPath("$.achievementSummary.discoveredStarCount").doesNotExist())
                .andExpect(jsonPath("$.email").doesNotExist())
                .andExpect(jsonPath("$.providerUserId").doesNotExist())
                .andExpect(jsonPath("$.onboardingDone").doesNotExist());
        mvc.perform(get("/api/v1/members/u-999999").session(viewer)).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/members/u-" + id)).andExpect(status().isUnauthorized());
        jdbc.update("UPDATE users SET status = 'withdrawn' WHERE id = ?", id);
        mvc.perform(get("/api/v1/members/u-" + id).session(viewer)).andExpect(status().isNotFound());
    }

    @Test
    void ssafyRejectsMissingStateAndAmbiguousCode() throws Exception {
        mvc.perform(get("/login")).andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("/oauth2/authorization/ssafy")))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("/oauth2/authorization/google")));
        for (boolean ambiguous : List.of(false, true)) {
            var start = mvc.perform(get("/oauth2/authorization/ssafy")).andReturn();
            var session = (MockHttpSession) start.getRequest().getSession(false);
            var params = query(start.getResponse().getRedirectedUrl());
            assertFalse(params.containsKey("scope"));
            var callback = get("/login/oauth2/code/ssafy").session(session).param("Code", "test-code");
            if (ambiguous) callback.param("code", "other-code").param("state", params.get("state"));
            mvc.perform(callback).andExpect(status().isUnauthorized());
        }
        assertEquals(0, count("users"));
    }

    @Test
    void callbackRejectsWrongStateAndInvalidIdTokens() throws Exception {
        var start = mvc.perform(get("/oauth2/authorization/google")).andExpect(status().is3xxRedirection()).andReturn();
        mvc.perform(get("/login/oauth2/code/google").session((MockHttpSession) start.getRequest().getSession(false))
                        .param("state", "wrong-state").param("code", "unused"))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
        for (String invalid : List.of("nonce", "audience", "issuer", "expiry", "signature")) {
            var request = mvc.perform(get("/oauth2/authorization/google")).andReturn();
            var params = query(request.getResponse().getRedirectedUrl());
            String code = IDP.issue("attacker", params.get("nonce"), invalid);
            mvc.perform(get("/login/oauth2/code/google")
                            .session((MockHttpSession) request.getRequest().getSession(false))
                            .param("state", params.get("state")).param("code", code))
                    .andExpect(status().isUnauthorized());
        }
        assertEquals(0, count("users"));
    }

    @Test
    void sessionExpiresAtThirtyMinutesAndOnlyAuthenticatedApiActivityExtendsIt() throws Exception {
        var session = login("google", "idle");
        TIME.advance(Duration.ofMinutes(29));
        mvc.perform(get("/api/v1/me").session(session)).andExpect(status().isOk());
        TIME.advance(Duration.ofMinutes(29));
        mvc.perform(get("/api/v1/auth/csrf").session(session)).andExpect(status().isOk());
        mvc.perform(get("/api/v1/hello").session(session)).andExpect(status().isOk());
        TIME.advance(Duration.ofMinutes(1));
        mvc.perform(get("/api/v1/me").session(session))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
        assertTrue(session.isInvalid());
        mvc.perform(post("/api/v1/me/profile")).andExpect(status().isUnauthorized());
    }

    @Test
    void forbiddenRequestsExtendActivityAndRoleAndProfileChangesAreVisibleImmediately() throws Exception {
        var session = login("google", "roles");
        TIME.advance(Duration.ofMinutes(29));
        mvc.perform(get("/api/v1/operator/probe").session(session)).andExpect(status().isForbidden());
        TIME.advance(Duration.ofMinutes(29));
        jdbc.update("UPDATE users SET nickname = '새닉네임', role = 'operator' WHERE id = ?", memberId(session));
        mvc.perform(get("/api/v1/me").session(session)).andExpect(status().isOk())
                .andExpect(jsonPath("$.nickname").value("새닉네임")).andExpect(jsonPath("$.role").value("OPERATOR"));
        mvc.perform(get("/api/v1/operator/probe").session(session)).andExpect(status().isNotFound());
        jdbc.update("UPDATE users SET role = 'member' WHERE id = ?", memberId(session));
        mvc.perform(get("/api/v1/operator/probe").session(session)).andExpect(status().isForbidden());
    }

    @Test
    void csrfIsRequiredAndLogoutOnlyInvalidatesCurrentDevice() throws Exception {
        var first = login("google", "devices");
        var second = login("google", "devices");
        mvc.perform(post("/api/v1/auth/logout").session(first)).andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
        var token = mapper.readTree(mvc.perform(get("/api/v1/auth/csrf").session(first))
                .andReturn().getResponse().getContentAsString());
        mvc.perform(post("/api/v1/auth/logout").session(first)
                        .header(token.get("headerName").asText(), token.get("token").asText()))
                .andExpect(status().isNoContent()).andExpect(cookie().maxAge("SESSION", 0));
        assertTrue(first.isInvalid());
        mvc.perform(get("/api/v1/me").session(second)).andExpect(status().isOk());
        mvc.perform(post("/api/v1/auth/logout")).andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/me")).andExpect(status().isUnauthorized());
    }

    @Test
    void oldCsrfTokenDoesNotSurviveLoginAndSessionIdChanges() throws Exception {
        var before = mvc.perform(get("/api/v1/auth/csrf")).andReturn();
        var session = (MockHttpSession) before.getRequest().getSession(false);
        String oldId = session.getId();
        var oldToken = mapper.readTree(before.getResponse().getContentAsString());
        session = login("google", "fixation", session);
        assertNotEquals(oldId, session.getId());
        mvc.perform(post("/api/v1/auth/logout").session(session)
                        .header(oldToken.get("headerName").asText(), oldToken.get("token").asText()))
                .andExpect(status().isForbidden());
    }

    @Test
    void withdrawnMemberCannotUseExistingSessionOrLogInAgain() throws Exception {
        var session = login("google", "withdrawn");
        jdbc.update("UPDATE users SET status = 'withdrawn' WHERE id = ?", memberId(session));
        mvc.perform(get("/api/v1/me").session(session)).andExpect(status().isUnauthorized());
        assertTrue(session.isInvalid());
        assertThrows(BusinessException.class, () -> members.login("google", "withdrawn"));
    }

    @Test
    void signupRollsBackIfTutorialIsMissing() throws Exception {
        jdbc.update("DELETE FROM tutorial_stars WHERE seq = 1");
        var start = mvc.perform(get("/oauth2/authorization/google")).andReturn();
        var params = query(start.getResponse().getRedirectedUrl());
        var session = (MockHttpSession) start.getRequest().getSession(false);
        mvc.perform(get("/login/oauth2/code/google").session(session)
                        .param("state", params.get("state")).param("code", IDP.issue("rollback", params.get("nonce"), "")))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("DEPENDENCY_UNAVAILABLE"));
        assertTrue(session.isInvalid());
        assertEquals(0, count("users"));
        assertEquals(0, count("user_settings"));
    }

    @Test
    void signupRollsBackIfGalaxyLayoutFails() {
        LAYOUT.fail = true;
        assertThrows(RuntimeException.class, () -> members.login("google", "layout-failure"));
        assertEquals(0, count("users"));
        assertEquals(0, count("star_unlocks"));
    }

    @Test
    void starUnlockRejectsNonFiniteCoordinatesAndOutOfRangeDepth() {
        long userId = members.login("google", "constraints").getId();
        for (String values : List.of("'NaN', 0, 0", "'Infinity', 0, 0", "0, '-Infinity', 0", "0, 0, 1.01")) {
            assertThrows(org.springframework.dao.DataIntegrityViolationException.class, () -> jdbc.update(
                    "INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, world_x, world_y, depth_z, layout_version, unlocked_at) "
                            + "VALUES (?, 2, 'tutorial', " + values + ", 'v', now())", userId));
        }
        assertThrows(org.springframework.dao.DataIntegrityViolationException.class, () -> jdbc.update(
                "INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, world_x, world_y, depth_z, layout_version, unlocked_at) "
                        + "VALUES (?, 2, 'tutorial', 0, 0, 0, ' ', now())", userId));
    }

    @Test
    void concurrentFirstLoginsCreateOneAccount() throws Exception {
        var start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(6)) {
            List<Future<Long>> results = new ArrayList<>();
            for (int i = 0; i < 6; i++) results.add(executor.submit(() -> {
                assertTrue(start.await(10, TimeUnit.SECONDS));
                return members.login("google", "concurrent").getId();
            }));
            start.countDown();
            Set<Long> ids = new HashSet<>();
            for (var result : results) ids.add(result.get(20, TimeUnit.SECONDS));
            assertEquals(1, ids.size());
        }
        assertEquals(1, count("users"));
        assertEquals(1, count("star_unlocks"));
        assertEquals(1, count("user_settings"));
    }

    private int count(String table) { return jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class); }
    private long memberId(MockHttpSession session) {
        var context = (SecurityContext) session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        return ((MemberPrincipal) context.getAuthentication().getPrincipal()).memberId();
    }
    private MockHttpSession login(String provider, String subject) throws Exception {
        return login(provider, subject, new MockHttpSession());
    }
    private MockHttpSession login(String provider, String subject, MockHttpSession session) throws Exception {
        var start = mvc.perform(get("/oauth2/authorization/" + provider).session(session))
                .andExpect(status().is3xxRedirection()).andReturn();
        var params = query(start.getResponse().getRedirectedUrl());
        assertNotNull(params.get("state"));
        var result = mvc.perform(get("/login/oauth2/code/" + provider).session(session)
                        .param("state", params.get("state")).param(provider.equals("ssafy") ? "Code" : "code",
                                IDP.issue(subject, params.get("nonce"), "")))
                .andExpect(status().is3xxRedirection()).andExpect(redirectedUrl("/api/v1/me")).andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }
    private static Map<String, String> query(String uri) {
        Map<String, String> params = new HashMap<>();
        for (String part : URI.create(uri).getRawQuery().split("&")) {
            var pair = part.split("=", 2);
            params.put(URLDecoder.decode(pair[0], StandardCharsets.UTF_8),
                    URLDecoder.decode(pair[1], StandardCharsets.UTF_8));
        }
        return params;
    }
    /** 원점이 아닌 결정적 좌표를 돌려 저장 값이 배치 함수에서 왔는지 구분한다. */
    static class TestGalaxyLayout implements GalaxyLayout {
        static final String VERSION = "test-layout-1";
        volatile boolean fail;
        @Override public StarPosition place(long userId, long ticId) {
            if (fail) throw new IllegalStateException("layout unavailable");
            return new StarPosition(userId * 10.5, ticId * -2.25, 0.5, VERSION);
        }
    }

    static class MutableClock extends Clock {
        volatile Instant now = Instant.parse("2026-09-15T01:00:00Z");
        void advance(Duration duration) { now = now.plus(duration); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    static class TestIdentityProvider {
        final HttpServer server;
        final com.nimbusds.jose.jwk.RSAKey key;
        final Map<String, Map<String, Object>> tokens = new ConcurrentHashMap<>();
        final Map<String, String> subjects = new ConcurrentHashMap<>();
        final ObjectMapper json = new ObjectMapper();

        TestIdentityProvider() {
            try {
                key = new RSAKeyGenerator(2048).keyID("test-key").generate();
                server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                server.createContext("/jwks", exchange -> {
                    byte[] body = json.writeValueAsBytes(Map.of("keys", List.of(key.toPublicJWK().toJSONObject())));
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, body.length);
                    exchange.getResponseBody().write(body); exchange.close();
                });
                server.createContext("/token", exchange -> {
                    String form = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                    var parameters = query("http://test/?" + form);
                    var token = tokens.remove(parameters.get("code"));
                    if (token != null && !token.containsKey("id_token")) {
                        // SSAFY는 Basic 인증이 아니라 form body로 클라이언트를 인증한다.
                        if (!"test-client".equals(parameters.get("client_id"))
                                || !"test-secret".equals(parameters.get("client_secret"))
                                || !"authorization_code".equals(parameters.get("grant_type"))
                                || !parameters.getOrDefault("redirect_uri", "").endsWith("/login/oauth2/code/ssafy")) token = null;
                    }
                    byte[] body = json.writeValueAsBytes(token == null ? Map.of("error", "invalid_grant") : token);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(token == null ? 400 : 200, body.length);
                    exchange.getResponseBody().write(body); exchange.close();
                });
                server.createContext("/userinfo", exchange -> {
                    String subject = subjects.get(exchange.getRequestHeaders().getFirst("Authorization").substring(7));
                    String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
                    // SSAFY 형식은 userId만 반환해도 가입 가능하다. 이름·이메일은 필수가 아니다.
                    boolean ssafy = contentType != null && contentType.startsWith("application/x-www-form-urlencoded");
                    byte[] body = json.writeValueAsBytes(ssafy ? Map.of("userId", subject)
                            : Map.of("sub", subject, "email", "same@example.com"));
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, body.length);
                    exchange.getResponseBody().write(body); exchange.close();
                });
                server.start();
            } catch (Exception e) { throw new IllegalStateException(e); }
        }
        String url() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        String issue(String subject, String nonce, String invalid) throws Exception {
            String code = UUID.randomUUID().toString();
            String access = UUID.randomUUID().toString();
            subjects.put(access, subject);
            Map<String, Object> response = new HashMap<>(Map.of("access_token", access,
                    "token_type", nonce == null ? "bearer" : "Bearer", "expires_in", "300"));
            if (nonce != null) {
                Instant now = Instant.now();
                var claims = new JWTClaimsSet.Builder().subject(subject)
                        .issuer(invalid.equals("issuer") ? "https://wrong.invalid" : url())
                        .audience(invalid.equals("audience") ? "wrong-client" : "test-client")
                        .issueTime(Date.from(now.minusSeconds(10)))
                        .expirationTime(Date.from(now.plusSeconds(invalid.equals("expiry") ? -600 : 300)))
                        .claim("nonce", invalid.equals("nonce") ? "wrong-nonce" : nonce).build();
                var jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType.JWT)
                        .keyID("test-key").build(), claims);
                jwt.sign(new RSASSASigner(invalid.equals("signature") ? new RSAKeyGenerator(2048).generate() : key));
                response.put("id_token", jwt.serialize());
            }
            tokens.put(code, response);
            return code;
        }
    }
}
