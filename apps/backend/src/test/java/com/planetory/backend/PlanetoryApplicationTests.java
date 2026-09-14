package com.planetory.backend;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
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

@ActiveProfiles("local")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class PlanetoryApplicationTests {

    // Every run uses its own schema; never migrate or delete development tables.
    private static final String SCHEMA = "backend_test_" + UUID.randomUUID().toString().replace("-", "");

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
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
        assertEquals(33, jdbc.queryForObject("SELECT count(*) FROM information_schema.tables "
                + "WHERE table_schema = ? AND table_type = 'BASE TABLE' AND table_name <> 'flyway_schema_history'",
                Integer.class, SCHEMA));
        assertEquals("1", flyway.info().current().getVersion().toString());
        assertEquals(0, flyway.migrate().migrationsExecuted);
        assertEquals(0, flyway.migrate().migrationsExecuted);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE version = '1' AND success",
                Integer.class));
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
