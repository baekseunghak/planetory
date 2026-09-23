package com.planetory.backend.domain.exploration;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.planetory.backend.global.security.InternalTokenFilter;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Publisher가 판 전환을 알리는 내부 경로 (탐사 API 10장 3단계) [S15P21C206-150].
 *
 * <p>토큰 검사 자체는 {@code InternalTokenFilterTest}가 본다. 여기서는 필터·CSRF·경로가 실제
 * 필터 체인에 붙어 있고 후처리 결과가 응답으로 나오는지를 확인한다.
 */
@ActiveProfiles("local")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "planetory.internal.service-token=" + InternalBundleActivationTest.TOKEN)
@AutoConfigureMockMvc
@Testcontainers
class InternalBundleActivationTest {

    static final String TOKEN = "publisher-test-token";

    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");

    private static final String SCHEMA =
            "internal_activation_" + UUID.randomUUID().toString().replace("-", "");

    private static final long TIC = 4101;

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", DB::getJdbcUrl);
        registry.add("spring.datasource.username", DB::getUsername);
        registry.add("spring.datasource.password", DB::getPassword);
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @org.springframework.boot.test.web.server.LocalServerPort int port;

    private long bundleId;

    @BeforeEach
    void seed() {
        jdbc.execute("TRUNCATE users, stars CASCADE");
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", TIC);
        bundleId = insertBundle("current");
    }

    /** 로그인 세션도 CSRF 토큰도 없이 후처리가 실행된다. 부르는 쪽은 사람이 아니라 배치다. */
    @Test
    void 서비스_토큰으로_판_전환_후처리를_실행한다() throws Exception {
        long member = member();
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason,"
                + " reopen_pending, completed_at) VALUES (?, ?, 'completed', 'undiscoverable_only', true, now())",
                member, TIC);
        insertCandidate(true);

        mvc.perform(post("/internal/bundles/b-" + bundleId + "/activated")
                        .header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
                .andExpect(jsonPath("$.applied").value(true))
                .andExpect(jsonPath("$.bundleId").value("b-" + bundleId))
                .andExpect(jsonPath("$.ticId").value(String.valueOf(TIC)))
                .andExpect(jsonPath("$.reopenedMembers").value(1))
                .andExpect(jsonPath("$.completedMembers").value(0))
                .andExpect(jsonPath("$.relabeledAchievements").value(0));
    }

    /** 알림은 정본이 아니다(10장). 지난 판을 알려도 오류가 아니라 "한 것이 없다"로 답한다. */
    @Test
    void 지난_판을_알려도_200으로_아무것도_하지_않았다고_답한다() throws Exception {
        long stale = insertBundle("archived");

        mvc.perform(post("/internal/bundles/b-" + stale + "/activated")
                        .header(InternalTokenFilter.HEADER, TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.applied").value(false))
                .andExpect(jsonPath("$.ticId").doesNotExist())
                .andExpect(jsonPath("$.reopenedMembers").value(0));
    }

    /** 같은 알림을 다시 받아도 결과가 같다. 호출자가 마음 놓고 재시도할 수 있어야 한다. */
    @Test
    void 같은_알림을_다시_받아도_재개는_한_번이다() throws Exception {
        long member = member();
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason,"
                + " completed_at) VALUES (?, ?, 'completed', 'undiscoverable_only', now())", member, TIC);
        insertCandidate(true);
        var request = post("/internal/bundles/b-" + bundleId + "/activated")
                .header(InternalTokenFilter.HEADER, TOKEN);

        mvc.perform(request).andExpect(jsonPath("$.reopenedMembers").value(1));
        mvc.perform(request).andExpect(jsonPath("$.reopenedMembers").value(0));

        org.junit.jupiter.api.Assertions.assertEquals(1, (int) jdbc.queryForObject(
                "SELECT count(*) FROM notifications WHERE type = 'reopen'", Integer.class));
    }

    @Test
    void 토큰이_없으면_401이다() throws Exception {
        mvc.perform(post("/internal/bundles/b-" + bundleId + "/activated"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
    }

    /** 판 식별자는 {@code b-{id}} 하나뿐이다. 숫자만 적은 값은 같은 대상의 다른 표기라 받지 않는다. */
    @Test
    void 판_식별자_형식이_아니면_404다() throws Exception {
        for (String bad : new String[] {String.valueOf(bundleId), "b-0" + bundleId, "b-abc", "b-"}) {
            mvc.perform(post("/internal/bundles/" + bad + "/activated")
                            .header(InternalTokenFilter.HEADER, TOKEN))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
        }
    }

    /**
     * 인코딩된 경로로도 토큰 검사를 우회할 수 없다 (MR !177 리뷰 P1, 백승학).
     *
     * <p>{@code getRequestURI()}는 서블릿 규약대로 디코딩하지 않은 값을 준다. 반면 Security의 경로
     * 매처와 MVC 라우팅은 디코딩한 경로를 쓴다. 필터가 원본 문자열을 직접 비교하면 {@code %69}가
     * 필터에는 다른 경로로, 라우팅에는 같은 경로로 보여 인증 없이 실행된다. MockMvc는 요청 URI를
     * 그대로 넣어 이 차이를 드러내지 못하므로 실제 서버로 확인한다.
     */
    @Test
    void 인코딩된_경로로도_토큰_검사를_우회할_수_없다() throws Exception {
        long member = member();
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason,"
                + " completed_at) VALUES (?, ?, 'completed', 'undiscoverable_only', now())", member, TIC);
        insertCandidate(true);

        for (String path : new String[] {"/%69nternal/bundles/b-" + bundleId + "/activated",
                                         "/internal/../internal/bundles/b-" + bundleId + "/activated",
                                         "/INTERNAL/bundles/b-" + bundleId + "/activated"}) {
            var response = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:" + port + path))
                            .POST(java.net.http.HttpRequest.BodyPublishers.noBody()).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());

            org.junit.jupiter.api.Assertions.assertNotEquals(200, response.statusCode(),
                    "토큰 없이 실행되면 안 된다: " + path + " -> " + response.body());
        }
        // 어느 경로로도 후처리가 돌지 않았다.
        org.junit.jupiter.api.Assertions.assertEquals("completed", jdbc.queryForObject(
                "SELECT progress_stage FROM user_star_progress WHERE user_id = ?", String.class, member));
        org.junit.jupiter.api.Assertions.assertEquals(0, (int) jdbc.queryForObject(
                "SELECT count(*) FROM notifications", Integer.class));
    }

    // ---------- 도우미 ----------

    private long member() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long insertBundle(String status) {
        return jdbc.queryForObject("INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest,"
                + " fold_reference_time_btjd, base_days) VALUES (?, ?, ?, ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, TIC, "v-" + UUID.randomUUID(), status, MANIFEST);
    }

    private void insertCandidate(boolean discoverable) {
        jdbc.update("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step, period_days,"
                + " epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, 3.5, 1501.0, 2.8, 400, 12.5, '{}'::jsonb, ?, false)",
                TIC, bundleId, discoverable);
    }
}
