package com.planetory.backend.domain.gold;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 배포 환경에서의 V2 적용 가능성 [S15P21C206-134].
 *
 * <p>운영 DB는 애플리케이션 계정에 CREATEROLE을 주지 않는다. 그 계정으로 Flyway가 돌 때
 * V2가 실패하면 앱이 기동하지 못하므로 두 경로를 모두 고정한다.
 *
 * <p>역할과 확장은 DB·클러스터 전역이라 한 컨테이너를 공유하면 앞 테스트가 뒤 테스트의
 * 전제를 깬다. 그래서 컨테이너를 정적으로 두지 않고 테스트마다 새로 띄운다.
 */
@Testcontainers
class GoldRoleDeploymentTest {

    @Container
    private final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withDatabaseName("planetory_poc")
            .withUsername("planetory")
            .withPassword("ssafy");

    /** 운영 경로: 프로비저닝이 역할을 미리 만들어 두면 CREATEROLE 없는 계정도 통과한다. */
    @Test
    void 역할이_미리_있으면_CREATEROLE_없는_계정도_마이그레이션에_성공한다() throws SQLException {
        try (Connection owner = asOwner(); Statement st = owner.createStatement()) {
            // 운영 DB 프로비저닝이 하는 일
            st.execute("CREATE ROLE planetory_gold_writer NOLOGIN");
            st.execute("CREATE ROLE planetory_app NOLOGIN");
        }
        createMigrationAccount("provisioned");

        assertFalse(canCreateRole("provisioned"), "CREATEROLE이 없어야 이 검증에 의미가 있다");
        assertDoesNotThrow(() -> migrateAs("provisioned", "provisioned"));
    }

    /** 프로비저닝이 빠졌을 때: 원인과 조치를 담은 메시지로 실패해야 한다. */
    @Test
    void 역할도_없고_CREATEROLE도_없으면_안내와_함께_실패한다() throws SQLException {
        createMigrationAccount("unprovisioned");

        Exception failure = assertThrows(Exception.class,
                () -> migrateAs("unprovisioned", "unprovisioned"));

        String message = allMessages(failure);
        assertTrue(message.contains("CREATEROLE"), "원인을 알려야 한다:\n" + message);
        assertTrue(message.contains("planetory_app"), "조치를 알려야 한다:\n" + message);
    }

    /**
     * 마이그레이션 계정 모델: 자기 스키마를 소유하고 DB에 CREATE 권한을 갖는다.
     * DB CREATE는 V1의 {@code CREATE EXTENSION pg_trgm}에 필요하다.
     */
    private void createMigrationAccount(String name) throws SQLException {
        try (Connection owner = asOwner(); Statement st = owner.createStatement()) {
            st.execute("CREATE USER " + name + " PASSWORD 'x'");
            st.execute("CREATE SCHEMA " + name + " AUTHORIZATION " + name);
            st.execute("GRANT CREATE ON DATABASE " + postgres.getDatabaseName() + " TO " + name);
        }
    }

    private void migrateAs(String user, String schema) {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), user, "x")
                .schemas(schema)
                .defaultSchema(schema)
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    private static String allMessages(Throwable throwable) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = throwable; c != null; c = c.getCause()) {
            sb.append(c.getMessage()).append('\n');
            if (c instanceof SQLException sqlException) {
                for (Throwable next : sqlException) {
                    sb.append(next.getMessage()).append('\n');
                }
            }
        }
        return sb.toString();
    }

    private boolean canCreateRole(String user) throws SQLException {
        try (Connection owner = asOwner();
             var ps = owner.prepareStatement("SELECT rolcreaterole FROM pg_roles WHERE rolname = ?")) {
            ps.setString(1, user);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    private Connection asOwner() throws SQLException {
        return DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
    }
}
