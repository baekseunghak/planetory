package com.planetory.backend.domain.gold;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Gold 카탈로그 역할 권한 인수 조건 (완료 조건 5) [S15P21C206-134].
 *
 * <p>PostgreSQL 역할은 스키마가 아니라 클러스터 전역이라 공용 개발 DB에서 검증하면
 * 역할이 남고 동시 실행이 충돌한다. 그래서 이 테스트만 일회용 컨테이너를 쓴다.
 * 스키마 제약·배열 검증은 {@link GoldCatalogSchemaTest}가 기존 로컬 DB에서 수행한다.
 *
 * <p>Compose의 service-db와 같은 이미지를 쓴다. Docker는 이미 빌드에 필요하므로
 * 팀원이 새로 설치할 것은 없다.
 */
@Testcontainers
class GoldRolePermissionTest {

    /** B 묶음 12테이블. 앱 역할은 전부 읽기만 가능해야 한다. */
    private static final List<String> B_GROUP = List.of(
            "stars", "observation_datasets", "publication_bundles", "light_curve_segments",
            "periodograms", "candidates", "candidate_aliases", "external_signal_references",
            "candidate_dispositions", "candidate_status_history", "ai_executions", "ai_evaluations");

    private static final List<String> WRITE_PRIVILEGES = List.of("INSERT", "UPDATE", "DELETE");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withDatabaseName("planetory_poc")
            .withUsername("planetory")
            .withPassword("ssafy");

    @BeforeAll
    static void migrateAndCreateLoginUsers() throws SQLException {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();

        // 배포에서 할 일을 테스트가 대신한다: 접속 계정에 그룹 역할을 부여한다.
        try (Connection owner = connectionAs(POSTGRES.getUsername(), POSTGRES.getPassword());
             Statement st = owner.createStatement()) {
            st.execute("CREATE USER app_login PASSWORD 'app'");
            st.execute("GRANT planetory_app TO app_login");
            st.execute("CREATE USER writer_login PASSWORD 'writer'");
            st.execute("GRANT planetory_gold_writer TO writer_login");
        }
    }

    /** 권한 카탈로그 검사: 앱 역할은 B 묶음 전체에 SELECT만 갖는다. */
    @Test
    void 앱_역할은_B_묶음에_읽기_권한만_갖는다() throws SQLException {
        try (Connection owner = connectionAs(POSTGRES.getUsername(), POSTGRES.getPassword())) {
            for (String table : B_GROUP) {
                assertTrue(hasPrivilege(owner, "planetory_app", table, "SELECT"),
                        table + ": 앱 역할은 읽을 수 있어야 한다");
                for (String privilege : WRITE_PRIVILEGES) {
                    assertFalse(hasPrivilege(owner, "planetory_app", table, privilege),
                            table + ": 앱 역할에 " + privilege + " 권한이 남아 있다");
                }
            }
        }
    }

    @Test
    void 배치_역할은_B_묶음에_읽기와_쓰기_권한을_갖는다() throws SQLException {
        try (Connection owner = connectionAs(POSTGRES.getUsername(), POSTGRES.getPassword())) {
            for (String table : B_GROUP) {
                assertTrue(hasPrivilege(owner, "planetory_gold_writer", table, "SELECT"), table);
                for (String privilege : WRITE_PRIVILEGES) {
                    assertTrue(hasPrivilege(owner, "planetory_gold_writer", table, privilege),
                            table + ": 배치 역할에 " + privilege + " 권한이 필요하다");
                }
            }
        }
    }

    /**
     * 카탈로그만 믿지 않고 실제 접속으로 집행을 확인한다. stars는 유효한 행을 만들 수 있어서
     * NOT NULL 위반이 아니라 권한 거절임을 SQLState 42501로 구분할 수 있다.
     */
    @Test
    void 앱_계정의_실제_INSERT가_권한으로_거절된다() throws SQLException {
        String insert = "INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (261136679, 0, 'published')";

        try (Connection app = connectionAs("app_login", "app"); Statement st = app.createStatement()) {
            SQLException denied = assertThrows(SQLException.class, () -> st.execute(insert));
            assertEquals("42501", denied.getSQLState(), "권한 부족(42501)이어야 한다: " + denied.getMessage());
        }

        // 같은 문장이 배치 계정으로는 성공해야 거절이 권한 때문임이 증명된다.
        try (Connection writer = connectionAs("writer_login", "writer");
             Statement st = writer.createStatement()) {
            assertDoesNotThrow(() -> st.execute(insert));
            st.execute("DELETE FROM stars WHERE tic_id = 261136679");
        }
    }

    /** 티켓 명시: C15-2 앱 후처리는 변경 이력을 읽되 INSERT 권한은 갖지 않는다. */
    @Test
    void 앱_계정은_후보_변경_이력을_읽되_쓰지_못한다() throws SQLException {
        try (Connection app = connectionAs("app_login", "app"); Statement st = app.createStatement()) {
            assertDoesNotThrow(() -> st.execute("SELECT 1 FROM candidate_status_history LIMIT 1"));

            SQLException denied = assertThrows(SQLException.class, () -> st.execute(
                    "INSERT INTO candidate_status_history(candidate_id, bundle_id, field, changed_at, rule_version)"
                            + " VALUES (1, 1, 'status', now(), 'r1')"));
            assertEquals("42501", denied.getSQLState(), denied.getMessage());
        }
    }

    private static boolean hasPrivilege(Connection connection, String role, String table, String privilege)
            throws SQLException {
        try (var ps = connection.prepareStatement("SELECT has_table_privilege(?, ?, ?)")) {
            ps.setString(1, role);
            ps.setString(2, table);
            ps.setString(3, privilege);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    private static Connection connectionAs(String user, String password) throws SQLException {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), user, password);
    }
}
