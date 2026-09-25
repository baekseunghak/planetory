package com.planetory.backend.domain.auth;

import com.planetory.backend.PlanetoryApplication;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.time.Duration;
import java.util.*;
import javax.net.ssl.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.client.registration.*;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.*;
import org.testcontainers.images.builder.Transferable;
import tools.jackson.databind.ObjectMapper;
import static org.junit.jupiter.api.Assertions.*;

/** 235: 실제 prod 설정·TLS nginx·Redis 세션과 전용 PostgreSQL 중단 관찰. 운영 인수가 아니다. */
@Testcontainers
class AuthRuntimeVerificationTest {
    // Docker의 자동 할당 포트는 stop/start 시 바뀐다. 이번 시험에서 선택한 빈 포트를 명시해 유지한다.
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withCreateContainerCmdModifier(command -> command.getHostConfig().withPortBindings(
                    new com.github.dockerjava.api.model.PortBinding(
                            com.github.dockerjava.api.model.Ports.Binding.bindIpAndPort("127.0.0.1", availablePort()),
                            new com.github.dockerjava.api.model.ExposedPort(5432))));
    @Container static final GenericContainer<?> SESSION = new GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);
    @Container static final GenericContainer<?> CACHE = new GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);
    static final AuthIntegrationTest.TestIdentityProvider IDP = new AuthIntegrationTest.TestIdentityProvider();
    @TempDir Path temporary;
    final ObjectMapper json = new ObjectMapper();
    final List<String> observations = new ArrayList<>();
    ConfigurableApplicationContext app;
    GenericContainer<?> proxy;
    SSLContext tls;
    String origin, backend;

    static int availablePort() {
        try (var socket = new java.net.ServerSocket(0)) { return socket.getLocalPort(); }
        catch (java.io.IOException failure) { throw new IllegalStateException("No test database port available", failure); }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Providers {
        @Bean ClientRegistrationRepository clients() {
            // 기존 합성 OIDC/OAuth2 공급자만 재사용한다. 회원·배치·시계는 실제 구현이다.
            return new InMemoryClientRegistrationRepository(
                    RedisSessionIntegrationTest.Config.client("google", true, IDP),
                    RedisSessionIntegrationTest.Config.client("ssafy", false, IDP));
        }
    }

    @Test void measureSecureCookiesAndDatabaseOutageThroughNginx() throws Exception {
        var rootLogger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        var previousLogLevel = rootLogger.getLevel();
        try {
            app = new SpringApplicationBuilder(PlanetoryApplication.class, Providers.class).run(
                    "--spring.profiles.active=prod", "--server.port=0", "--planetory.session.redis.enabled=true",
                    "--spring.config.import=optional:classpath:/oauth-test-no-local.properties",
                    "--spring.datasource.url=" + DB.getJdbcUrl(), "--spring.datasource.username=" + DB.getUsername(),
                    "--spring.datasource.password=" + DB.getPassword(),
                    "--spring.datasource.hikari.connection-timeout=1500",
                    "--planetory.redis.session.host=" + SESSION.getHost(), "--planetory.redis.session.port=" + SESSION.getMappedPort(6379),
                    "--planetory.redis.cache.host=" + CACHE.getHost(), "--planetory.redis.cache.port=" + CACHE.getMappedPort(6379),
                    // ORM/풀의 드라이버 예외 원문 대신 이 시험의 허용된 관찰값만 남긴다.
                    "--logging.level.root=OFF");
            int port = ((WebServerApplicationContext) app).getWebServer().getPort();
            backend = "http://localhost:" + port;
            assertArrayEquals(new String[]{"prod"}, app.getEnvironment().getActiveProfiles());
            assertEquals("true", app.getEnvironment().getProperty("server.servlet.session.cookie.secure"));
            var jdbc = app.getBean(JdbcTemplate.class);
            for (int i = 1; i <= 5; i++) {
                jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,0,'published')", i);
                jdbc.update("INSERT INTO tutorial_stars(seq,tic_id,intent,active) VALUES (?,?,'deep_confirmed',true)", i, i);
            }
            startTlsProxy(port);
            observations.add("profile=prod; forward-headers=framework; java=" + System.getProperty("java.version"));
            observations.add("postgres-image=" + DB.getContainerInfo().getImageId());
            observations.add("session-image=" + SESSION.getContainerInfo().getImageId());
            observations.add("cache-image=" + CACHE.getContainerInfo().getImageId());
            observations.add("nginx-image=" + proxy.getContainerInfo().getImageId());
            observations.add("database-container=" + DB.getContainerId());
            observations.add("database-before=" + DB.getJdbcUrl());
            var anonymous = client(new CookieManager());
            error("anonymous-me", get(anonymous, "/api/v1/me"), 401, "AUTH_REQUIRED");
            var authenticatedCookies = new CookieManager();
            var authenticated = client(authenticatedCookies);
            var csrfBefore = json.readTree(get(authenticated, "/api/v1/auth/csrf").body());
            for (String provider : List.of("google", "ssafy")) {
                var jar = new CookieManager();
                var browser = client(jar);
                var authorization = get(browser, "/oauth2/authorization/" + provider);
                cookie("authorization-" + provider, authorization, false);
                var callback = get(browser, callback(authorization, provider));
                status("login-" + provider, callback, 302);
                assertEquals(origin + "/api/v1/me", callback.headers().firstValue("location").orElseThrow());
                cookie("login-" + provider, callback, false);
                status("authenticated-me-" + provider, get(browser, "/api/v1/me"), 200);
            }
            status("login-for-outage", get(authenticated, callback(get(authenticated, "/oauth2/authorization/google"), "google")), 302);
            error("logout-stale-csrf", logout(authenticated, csrfBefore.get("token").asText()), 403, "FORBIDDEN");
            error("logout-no-csrf", logout(authenticated, null), 403, "FORBIDDEN");
            var logoutJar = new CookieManager();
            var logoutClient = client(logoutJar);
            var csrf = get(logoutClient, "/api/v1/auth/csrf");
            cookie("csrf", csrf, false);
            var loggedOut = logout(logoutClient, json.readTree(csrf.body()).get("token").asText());
            status("logout", loggedOut, 204);
            cookie("logout", loggedOut, true);
            error("logout-old-token", logout(logoutClient, json.readTree(csrf.body()).get("token").asText()), 403, "FORBIDDEN");
            status("logout-fresh-token", logout(logoutClient,
                    json.readTree(get(logoutClient, "/api/v1/auth/csrf").body()).get("token").asText()), 204);

            for (String provider : List.of("google", "ssafy")) {
                error("invalid-callback-backend-" + provider,
                        direct(new CookieManager(), "/login/oauth2/code/" + provider + "?error=access_denied&state=invalid"), 401, "AUTH_REQUIRED");
                proxyFailure("invalid-callback-proxy-" + provider,
                        get(anonymous, "/login/oauth2/code/" + provider + "?error=access_denied&state=invalid"), "access_denied");
            }

            // 중단 대상은 이 클래스가 만든 컨테이너 객체의 ID뿐이다. 공유 DB를 선택하는 입력은 없다.
            HttpResponse<String> initialOutage, prolongedOutage;
            DB.getDockerClient().stopContainerCmd(DB.getContainerId()).withTimeout(1).exec();
            try {
                assertFalse(DB.getDockerClient().inspectContainerCmd(DB.getContainerId()).exec().getState().getRunning());
                initialOutage = get(authenticated, "/api/v1/me");
                observeOutage("database-down-authenticated-me", initialOutage);
                error("database-down-anonymous-me", get(anonymous, "/api/v1/me"), 401, "AUTH_REQUIRED");
                for (String provider : List.of("google", "ssafy")) {
                    var jar = new CookieManager();
                    var browser = client(jar);
                    var authorization = get(browser, "/oauth2/authorization/" + provider);
                    status("database-down-authorization-" + provider, authorization, 302);
                    var failure = direct(jar, callback(authorization, provider));
                    error("database-down-callback-backend-" + provider, failure, 503, "DEPENDENCY_UNAVAILABLE");
                    cookie("database-down-callback-" + provider, failure, true);
                    jar.getCookieStore().removeAll();
                    authorization = get(browser, "/oauth2/authorization/" + provider);
                    proxyFailure("database-down-callback-proxy-" + provider,
                            get(browser, callback(authorization, provider)), "service_unavailable");
                }
                prolongedOutage = get(authenticated, "/api/v1/me");
                observeOutage("database-down-after-pool-reconnect", prolongedOutage);
                var unavailable = assertThrows(org.springframework.transaction.CannotCreateTransactionException.class,
                        () -> app.getBean(com.planetory.backend.domain.member.service.MemberService.class).requireActive(-1));
                observations.add("database-member-lookup-exception=" + unavailable.getClass().getSimpleName());
                error("database-down-authenticated-csrf", get(authenticated, "/api/v1/auth/csrf"), 503, "DEPENDENCY_UNAVAILABLE");
            } finally {
                DB.getDockerClient().startContainerCmd(DB.getContainerId()).exec();
            }
            String restoredPort = DB.getDockerClient().inspectContainerCmd(DB.getContainerId()).exec()
                    .getNetworkSettings().getPorts().getBindings().get(new com.github.dockerjava.api.model.ExposedPort(5432))[0].getHostPortSpec();
            observations.add("database-restart-host-port-changed=" + !restoredPort.equals(DB.getMappedPort(5432).toString()));
            observations.add("database-after-container=" + DB.getContainerId() + "; mapped-port=" + restoredPort);
            assertEquals(DB.getMappedPort(5432).toString(), restoredPort, "Recovery requires the same database address");
            long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();
            HttpResponse<String> recovered;
            do {
                recovered = get(authenticated, "/api/v1/me");
                observations.add("database-recovery-poll status=" + recovered.statusCode());
                if (recovered.statusCode() == 200) break;
                error("database-recovering-me", recovered, 503, "DEPENDENCY_UNAVAILABLE");
                Thread.sleep(250);
            } while (recovered.statusCode() == 503 && System.nanoTime() < deadline);
            if (recovered.statusCode() != 200) {
                try { jdbc.queryForObject("SELECT 1", Integer.class); }
                catch (Exception failure) {
                    for (Throwable cause = failure; cause != null; cause = cause.getCause())
                        observations.add("database-recovery-probe-exception=" + cause.getClass().getSimpleName());
                }
            }
            status("database-recovered-same-session-me", recovered, 200);
            assertAll(
                    () -> error("database-down-authenticated-me", initialOutage, 503, "DEPENDENCY_UNAVAILABLE"),
                    () -> error("database-down-after-pool-reconnect", prolongedOutage, 503, "DEPENDENCY_UNAVAILABLE"));
        } finally {
            Files.createDirectories(Path.of("build", "runtime-235"));
            Files.write(Path.of("build", "runtime-235", "observations.txt"), observations);
            if (proxy != null) proxy.close();
            if (app != null) app.close();
            IDP.server.stop(0);
            rootLogger.setLevel(previousLogLevel);
            // Testcontainers가 이 클래스의 세 컨테이너만 정리한다.
        }
    }

    void startTlsProxy(int backendPort) throws Exception {
        Path store = temporary.resolve("tls.p12");
        String password = UUID.randomUUID().toString();
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
                "-genkeypair", "-alias", "tls", "-keyalg", "RSA", "-storetype", "PKCS12",
                "-keystore", store.toString(), "-storepass", password, "-dname", "CN=localhost",
                "-ext", "SAN=dns:localhost", "-validity", "2").redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        assertEquals(0, process.waitFor());
        var keyStore = KeyStore.getInstance("PKCS12");
        try (var stream = Files.newInputStream(store)) { keyStore.load(stream, password.toCharArray()); }
        var trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(keyStore);
        tls = SSLContext.getInstance("TLS");
        tls.init(null, trust.getTrustManagers(), null);
        String config = Files.readString(Path.of("../frontend/nginx.conf"))
                .replace("listen 8080;", "listen 8080 ssl;\n    ssl_certificate /tmp/tls.crt;\n    ssl_certificate_key /tmp/tls.key;")
                .replace("backend:8080", "host.testcontainers.internal:" + backendPort);
        // 라우팅·오류 처리·전달 헤더는 저장소 nginx 설정 그대로다. TLS와 전용 upstream만 치환한다.
        org.testcontainers.Testcontainers.exposeHostPorts(backendPort);
        proxy = new GenericContainer<>("nginxinc/nginx-unprivileged:1.27-alpine").withExposedPorts(8080).withAccessToHost(true)
                .withCopyToContainer(Transferable.of(config), "/etc/nginx/conf.d/default.conf")
                .withCopyToContainer(Transferable.of(pem("CERTIFICATE", keyStore.getCertificate("tls").getEncoded())), "/tmp/tls.crt")
                .withCopyToContainer(Transferable.of(pem("PRIVATE KEY", keyStore.getKey("tls", password.toCharArray()).getEncoded()), 0600), "/tmp/tls.key")
                .withCreateContainerCmdModifier(command -> command.withUser("0"))
                // 동적 nginx resolver는 /etc/hosts를 읽지 않으므로 전용 터널의 주소만 치환한다.
                .withCommand("/bin/sh", "-ec", "address=$(getent hosts host.testcontainers.internal | awk '{print $1}'); "
                        + "test -n \"$address\"; sed -i \"s/host.testcontainers.internal/$address/g\" /etc/nginx/conf.d/default.conf; "
                        + "exec nginx -g 'daemon off;'");
        proxy.start();
        origin = "https://localhost:" + proxy.getMappedPort(8080);
    }
    String pem(String type, byte[] bytes) {
        return "-----BEGIN " + type + "-----\n" + Base64.getMimeEncoder(64, new byte[]{'\n'}).encodeToString(bytes)
                + "\n-----END " + type + "-----\n";
    }
    HttpClient client(CookieManager jar) { return HttpClient.newBuilder().sslContext(tls).cookieHandler(jar).build(); }
    HttpResponse<String> get(HttpClient client, String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(origin + path)).timeout(Duration.ofSeconds(40)).build(), HttpResponse.BodyHandlers.ofString());
    }
    HttpResponse<String> logout(HttpClient client, String token) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(origin + "/api/v1/auth/logout")).POST(HttpRequest.BodyPublishers.noBody());
        if (token != null) request.header("X-CSRF-TOKEN", token);
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
    HttpResponse<String> direct(CookieManager jar, String path) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(backend + path)).timeout(Duration.ofSeconds(40))
                .header("X-Forwarded-Proto", "https").header("X-Forwarded-Host", URI.create(origin).getAuthority());
        // 내부 응답 비교용 호출이다. Secure 쿠키는 메모리에서만 전달하며 출력하지 않는다.
        for (var cookie : jar.getCookieStore().getCookies()) request.header("Cookie", cookie.getName() + "=" + cookie.getValue());
        try (var client = HttpClient.newHttpClient()) { return client.send(request.build(), HttpResponse.BodyHandlers.ofString()); }
    }
    String callback(HttpResponse<String> authorization, String provider) throws Exception {
        assertEquals(302, authorization.statusCode());
        Map<String, String> parameters = new HashMap<>();
        for (String part : URI.create(authorization.headers().firstValue("location").orElseThrow()).getRawQuery().split("&")) {
            String[] pair = part.split("=", 2);
            parameters.put(URLDecoder.decode(pair[0], StandardCharsets.UTF_8), URLDecoder.decode(pair[1], StandardCharsets.UTF_8));
        }
        assertEquals(origin + "/login/oauth2/code/" + provider, parameters.get("redirect_uri"));
        String code = IDP.issue("runtime-235-" + provider, parameters.get("nonce"), "");
        return "/login/oauth2/code/" + provider + "?state=" + URLEncoder.encode(parameters.get("state"), StandardCharsets.UTF_8)
                + (provider.equals("ssafy") ? "&Code=" : "&code=") + code;
    }
    void status(String label, HttpResponse<String> response, int expected) {
        observations.add(label + " status=" + response.statusCode());
        assertEquals(expected, response.statusCode(), label);
    }
    void observeOutage(String label, HttpResponse<String> response) {
        var body = json.readTree(response.body());
        observations.add(label + " status=" + response.statusCode() + "; body-fields=" + body.propertyNames());
        // 상태·고정 공개 코드만 기록한다. 기본 오류 응답의 가변 필드 값은 보관하지 않는다.
        String code = body.path("code").asText();
        observations.add(label + " public-code=" + (Set.of("DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR").contains(code) ? code : "absent"));
    }
    void error(String label, HttpResponse<String> response, int expected, String code) {
        status(label, response, expected);
        var body = json.readTree(response.body());
        assertEquals(code, body.path("code").asText(), label);
        assertEquals(Set.of("code", "message"), body.propertyNames(), label);
        assertEquals("no-store", response.headers().firstValue("cache-control").orElseThrow());
        assertEquals(code.equals("AUTH_REQUIRED") ? "로그인이 필요합니다."
                : code.equals("FORBIDDEN") ? "접근 권한이 없습니다."
                : "일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.", body.path("message").asText());
        observations.add(label + " body=" + body);
    }
    void proxyFailure(String label, HttpResponse<String> response, String error) {
        status(label, response, 302);
        assertEquals("/oauth/callback?error=" + error, response.headers().firstValue("location").orElseThrow());
        observations.add(label + " location=/oauth/callback?error=" + error);
    }
    void cookie(String label, HttpResponse<String> response, boolean deletion) {
        var headers = response.headers().allValues("set-cookie");
        assertFalse(headers.isEmpty(), label);
        for (String header : headers) {
            String name = header.substring(0, header.indexOf('='));
            String attributes = header.substring(header.indexOf(';') + 1).trim();
            observations.add(label + " cookie=" + name + "; " + attributes);
            assertEquals("SESSION", name);
            String lower = attributes.toLowerCase(Locale.ROOT);
            assertTrue(lower.contains("path=/"));
            assertTrue(lower.contains("secure"));
            if (!deletion) {
                assertTrue(lower.contains("httponly"));
                assertTrue(lower.contains("samesite=lax"));
            } else assertTrue(HttpCookie.parse(header).getFirst().hasExpired());
        }
    }
}
