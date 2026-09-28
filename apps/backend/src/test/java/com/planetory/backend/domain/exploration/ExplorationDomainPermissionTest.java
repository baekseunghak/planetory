package com.planetory.backend.domain.exploration;

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
 * 탐사 도메인 권한 인수 조건 (완료 조건 3) [S15P21C206-135].
 *
 * <p>ERD 미결 5·6의 불변 강제를 트리거가 아니라 권한 회수로 처리한다는 결정을 검증한다.
 * 역할은 클러스터 전역이라 공용 개발 DB를 쓰지 않고 일회용 컨테이너에서 확인한다.
 */
@Testcontainers
class ExplorationDomainPermissionTest {

    /** 앱이 행을 만들고 갱신한다. */
    private static final List<String> WRITABLE = List.of(
            "submissions", "user_candidate_achievements", "user_star_progress", "star_unlocks");

    /** 앱이 만들되 고치지 않는다(HIS-06). */
    private static final List<String> APPEND_ONLY = List.of(
            "analysis_histories", "analysis_snapshots");

    /** 운영이 설정하고 앱은 읽기만 한다. */
    private static final List<String> READ_ONLY = List.of(
            "operation_settings", "tutorial_stars", "challenge_rounds", "challenge_round_extra_targets");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withDatabaseName("planetory_poc")
            .withUsername("planetory")
            .withPassword("ssafy");

    @BeforeAll
    static void migrateAndGrantRole() throws SQLException {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();

        try (Connection owner = connectionAs(POSTGRES.getUsername(), POSTGRES.getPassword());
             Statement st = owner.createStatement()) {
            st.execute("CREATE USER app_login PASSWORD 'app'");
            st.execute("GRANT planetory_app TO app_login");
        }
    }

    /** 완료 조건 (3): 히스토리는 생성 후 고치거나 지울 수 없다. */
    @Test
    void 앱_역할은_히스토리를_만들_수_있으나_고치거나_지울_수_없다() throws SQLException {
        try (Connection owner = asOwner()) {
            for (String table : APPEND_ONLY) {
                assertTrue(hasPrivilege(owner, table, "SELECT"), table);
                assertTrue(hasPrivilege(owner, table, "INSERT"), table + ": 새 기록은 만들어야 한다");
                assertFalse(hasPrivilege(owner, table, "UPDATE"),
                        table + ": 불변 기록에 UPDATE 권한이 남아 있다");
                assertFalse(hasPrivilege(owner, table, "DELETE"),
                        table + ": 불변 기록에 DELETE 권한이 남아 있다");
            }
        }
    }

    /** 카탈로그만 믿지 않고 실제 접속으로 집행을 확인한다. */
    @Test
    void 앱_계정의_실제_히스토리_수정이_권한으로_거절된다() throws SQLException {
        try (Connection app = connectionAs("app_login", "app"); Statement st = app.createStatement()) {
            SQLException onUpdate = assertThrows(SQLException.class,
                    () -> st.execute("UPDATE analysis_histories SET tic_id = 1"));
            assertEquals("42501", onUpdate.getSQLState(), onUpdate.getMessage());

            SQLException onDelete = assertThrows(SQLException.class,
                    () -> st.execute("DELETE FROM analysis_histories"));
            assertEquals("42501", onDelete.getSQLState(), onDelete.getMessage());

            assertDoesNotThrow(() -> st.execute("SELECT 1 FROM analysis_histories LIMIT 1"));
        }
    }

    @Test
    void 앱_역할은_제출과_진행을_쓸_수_있고_지울_수_없다() throws SQLException {
        try (Connection owner = asOwner()) {
            for (String table : WRITABLE) {
                assertTrue(hasPrivilege(owner, table, "SELECT"), table);
                assertTrue(hasPrivilege(owner, table, "INSERT"), table);
                assertTrue(hasPrivilege(owner, table, "UPDATE"), table);
                assertFalse(hasPrivilege(owner, table, "DELETE"),
                        table + ": 탈퇴 처리 범위가 정해지기 전에는 DELETE를 주지 않는다");
            }
        }
    }

    @Test
    void 앱_역할은_운영_설정을_읽기만_한다() throws SQLException {
        try (Connection owner = asOwner()) {
            for (String table : READ_ONLY) {
                assertTrue(hasPrivilege(owner, table, "SELECT"), table);
                for (String write : List.of("INSERT", "UPDATE", "DELETE")) {
                    assertFalse(hasPrivilege(owner, table, write),
                            table + ": 앱에 " + write + " 권한이 남아 있다");
                }
            }
        }
    }

    /** Gold는 여전히 읽기만 가능해야 한다. V5가 B 묶음 권한을 되돌리지 않았는지 본다. */
    @Test
    void Gold_카탈로그_권한이_그대로_유지된다() throws SQLException {
        try (Connection owner = asOwner()) {
            for (String table : List.of("stars", "candidates", "publication_bundles")) {
                assertTrue(hasPrivilege(owner, table, "SELECT"), table);
                for (String write : List.of("INSERT", "UPDATE", "DELETE")) {
                    assertFalse(hasPrivilege(owner, table, write), table);
                }
            }
        }
    }

    private static boolean hasPrivilege(Connection connection, String table, String privilege)
            throws SQLException {
        try (var ps = connection.prepareStatement("SELECT has_table_privilege('planetory_app', ?, ?)")) {
            ps.setString(1, table);
            ps.setString(2, privilege);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    private static Connection asOwner() throws SQLException {
        return connectionAs(POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static Connection connectionAs(String user, String password) throws SQLException {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), user, password);
    }
}
