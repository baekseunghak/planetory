package com.planetory.backend;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;

import static org.junit.jupiter.api.Assertions.*;

@org.testcontainers.junit.jupiter.Testcontainers
@ActiveProfiles("local")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PlanetoryApplicationTests {
    @org.testcontainers.junit.jupiter.Container
    static final org.testcontainers.containers.GenericContainer<?> REDIS =
            new org.testcontainers.containers.GenericContainer<>("redis:8.2-alpine").withExposedPorts(6379);

    // Every run uses its own schema; never migrate or delete development tables.
    private static final String SCHEMA = "backend_test_" + UUID.randomUUID().toString().replace("-", "");

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", REDIS::getHost);
        registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired Flyway flyway;
    @LocalServerPort int port;

    @AfterAll
    static void removeOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Test
    void databaseAndMigrationAreReadyAndNotAppliedTwice() {
        assertEquals(1, jdbc.queryForObject("SELECT 1", Integer.class));
        // 테이블 수를 고정하지 않는다. 마이그레이션이 늘어도 이 테스트는 "모두 적용됐고 다시 적용되지 않는다"만 본다.
        for (String table : List.of("users", "posts", "comments", "submissions", "operation_settings")) {
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM information_schema.tables "
                    + "WHERE table_schema = ? AND table_name = ?", Integer.class, SCHEMA, table), table);
        }
        // applied()에는 테스트 스키마 생성 표식(version null)도 들어오므로 버전이 있는 것만 센다.
        long applied = java.util.Arrays.stream(flyway.info().applied()).filter(m -> m.getVersion() != null).count();
        assertTrue(applied >= 1);
        assertEquals(0, flyway.info().pending().length);
        assertEquals(0, flyway.migrate().migrationsExecuted);
        assertEquals(0, flyway.migrate().migrationsExecuted);
        assertEquals(applied, jdbc.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE success AND version IS NOT NULL", Long.class));
    }

    @Test
    void erdV12ColumnsAndConstraintsExist() {
        // 제출 행은 판·규칙 등 FK가 많아 동작 검증은 제출 API 테스트에서 한다. 여기서는 V4 적용 결과만 본다.
        String columns = "SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable "
                + "FROM information_schema.columns WHERE table_schema = ? AND column_name IN "
                + "('world_x', 'world_y', 'layout_version', 'generation', 'source_peak_grid_index', "
                + "'source_peak_suggested_duration_hours', 'duration_limit_hours') ORDER BY 1";
        assertEquals(List.of(
                "star_unlocks.generation:smallint:YES",
                "star_unlocks.layout_version:text:NO",
                "star_unlocks.world_x:numeric:NO",
                "star_unlocks.world_y:numeric:NO",
                "submissions.duration_limit_hours:numeric:YES",
                "submissions.source_peak_grid_index:integer:YES",
                "submissions.source_peak_suggested_duration_hours:numeric:YES"),
                jdbc.queryForList(columns, String.class, SCHEMA));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace "
                + "WHERE n.nspname = ? AND c.conname = 'ck_submissions_source_peak_all_or_none'", Integer.class, SCHEMA));
    }

    @Test
    @Transactional
    void nicknameIsUniqueRegardlessOfCase() {
        jdbc.update("INSERT INTO users(provider, provider_user_id, nickname) VALUES ('test', '1', 'Explorer')");
        assertThrows(DuplicateKeyException.class, () -> jdbc.update(
                "INSERT INTO users(provider, provider_user_id, nickname) VALUES ('test', '2', 'explorer')"));
    }

    @Test
    void exampleHealthAndSwaggerAreAvailable() throws Exception {
        try (var client = HttpClient.newHttpClient()) {
            var hello = get(client, "/api/v1/hello");
            assertEquals(200, hello.statusCode());
            assertTrue(hello.body().contains("Planetory"));
            var health = get(client, "/actuator/health");
            assertEquals(200, health.statusCode());
            assertTrue(health.body().contains("UP"));
            var docs = get(client, "/v3/api-docs");
            assertEquals(200, docs.statusCode());
            assertTrue(docs.body().contains("/api/v1/hello"));
            assertEquals(200, get(client, "/swagger-ui/index.html").statusCode());
        }
    }

    private HttpResponse<String> get(HttpClient client, String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

}
