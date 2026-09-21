package com.planetory.backend.domain.member;

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

/** 회원·커뮤니티 도메인의 앱 역할 권한 인수 조건 [S15P21C206-238]. */
@Testcontainers
class MemberCommunityPermissionTest {

    private static final List<String> WRITABLE =
            List.of("users", "user_settings", "posts", "comments");
    private static final List<String> UNUSED = List.of(
            "follows", "notifications",
            "stats_snapshots");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-alpine")
            .withDatabaseName("planetory_poc")
            .withUsername("planetory")
            .withPassword("ssafy");

    @BeforeAll
    static void migrateAndCreateLoginUser() throws SQLException {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .target("12")
                .load()
                .migrate();

        Flyway throughVisibility = Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .target("15")
                .load();
        assertEquals(3, throughVisibility.migrate().migrationsExecuted); // V13 첨부 → V14 공개 등록 → V15 공개 상태
        Flyway throughReactions = Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").target("16").load();
        assertEquals(1, throughReactions.migrate().migrationsExecuted);
        Flyway upgraded = Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .load();
        // V16 이후 제출 상세 V17과 출처 권한 V18을 순서대로 적용한다.
        var applied = upgraded.migrate();
        assertEquals(List.of("17", "18"), applied.migrations.stream().map(m -> m.version).toList());
        Flyway restarted = Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .load();
        restarted.validate();
        assertEquals(0, restarted.migrate().migrationsExecuted);

        try (Connection owner = connectionAs(POSTGRES.getUsername(), POSTGRES.getPassword());
             Statement st = owner.createStatement()) {
            st.execute("CREATE USER app_login PASSWORD 'app'");
            st.execute("GRANT planetory_app TO app_login");
        }
    }

    @Test
    void 앱_역할은_회원과_커뮤니티_테이블에_필요한_권한만_갖는다() throws SQLException {
        try (Connection owner = asOwner()) {
            for (String table : WRITABLE) {
                for (String allowed : List.of("SELECT", "INSERT", "UPDATE")) {
                    assertTrue(hasPrivilege(owner, table, allowed), table + ": " + allowed);
                }
                for (String denied : List.of("DELETE", "TRUNCATE")) {
                    assertFalse(hasPrivilege(owner, table, denied), table + ": " + denied);
                }
            }

            assertTrue(hasPrivilege(owner, "published_analyses", "SELECT"));
            for (String allowed : List.of("SELECT", "INSERT", "UPDATE", "DELETE"))
                assertTrue(hasPrivilege(owner, "post_reactions", allowed));
            assertFalse(hasPrivilege(owner, "post_reactions", "TRUNCATE"));
            for (String table : List.of("post_history_attachments", "comment_history_attachments", "post_source_links")) {
                for (String allowed : List.of("SELECT", "INSERT", "DELETE")) assertTrue(hasPrivilege(owner, table, allowed));
                for (String denied : List.of("UPDATE", "TRUNCATE")) assertFalse(hasPrivilege(owner, table, denied));
            }
            assertTrue(hasPrivilege(owner, "published_analyses", "INSERT"));
            for (String denied : List.of("UPDATE", "DELETE", "TRUNCATE")) {
                assertFalse(hasPrivilege(owner, "published_analyses", denied), denied);
            }

            for (String table : UNUSED) {
                for (String privilege : List.of("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")) {
                    assertFalse(hasPrivilege(owner, table, privilege), table + ": " + privilege);
                }
            }
        }
    }

    @Test
    void 앱_계정은_회원과_커뮤니티_행을_생성하고_갱신하며_users를_잠글_수_있다()
            throws SQLException {
        try (Connection app = connectionAs("app_login", "app"); Statement st = app.createStatement()) {
            app.setAutoCommit(false);

            long userId = returnedId(st, "INSERT INTO users(provider, provider_user_id, nickname) "
                    + "VALUES ('test', 'permission-user', 'before') RETURNING id");
            st.execute("INSERT INTO user_settings(user_id) VALUES (" + userId + ")");
            long postId = returnedId(st, "INSERT INTO posts(kind, user_id, board, tag, title, body, status) "
                    + "VALUES ('user', " + userId
                    + ", 'free', 'GENERAL', 'title', 'before', 'visible') RETURNING id");
            st.execute("INSERT INTO comments(post_id, user_id, body, status) VALUES ("
                    + postId + ", " + userId + ", 'before', 'visible')");
            long reactionId = returnedId(st, "INSERT INTO post_reactions(post_id,user_id,reaction) VALUES ("
                    + postId + "," + userId + ",'agree') RETURNING id");
            assertEquals(1, st.executeUpdate("UPDATE post_reactions SET reaction='disagree' WHERE id=" + reactionId));
            assertEquals(1, st.executeUpdate("DELETE FROM post_reactions WHERE id=" + reactionId));

            assertEquals(1, st.executeUpdate("UPDATE users SET nickname = 'after' WHERE id = " + userId));
            assertEquals(1, st.executeUpdate(
                    "UPDATE user_settings SET onboarding_done = true WHERE user_id = " + userId));
            assertEquals(1, st.executeUpdate("UPDATE posts SET body = 'after' WHERE id = " + postId));
            assertEquals(1, st.executeUpdate(
                    "UPDATE comments SET body = 'after' WHERE post_id = " + postId));
            assertDoesNotThrow(() -> st.executeQuery(
                    "SELECT id FROM users WHERE id = " + userId + " FOR UPDATE").close());

            long source = returnedId(st, "INSERT INTO post_source_links(post_id,target_type,target_id) VALUES (" + postId + ",'thread',1) RETURNING id");
            assertEquals(1, st.executeUpdate("DELETE FROM post_source_links WHERE id=" + source));
            app.rollback();
        }
    }

    @Test
    void 앱_계정은_공개취소열만_변경하고_운영숨김과_원본은_변경할수없다() throws SQLException {
        try (Connection app = connectionAs("app_login", "app"); Statement st = app.createStatement()) {
            assertPermissionDenied(() -> st.execute("DELETE FROM users WHERE id = -1"));
            assertPermissionDenied(() -> st.execute("TRUNCATE post_reactions"));
            assertDoesNotThrow(() -> st.execute("UPDATE published_analyses SET unpublished_at=now() WHERE id=-1"));
            assertDoesNotThrow(() -> st.executeQuery("SELECT id FROM published_analyses WHERE id=-1 FOR UPDATE").close());
            for (String column : List.of("hidden_at", "published_at")) {
                assertPermissionDenied(() -> st.execute("UPDATE published_analyses SET " + column + "=now() WHERE id=-1"));
            }
            assertPermissionDenied(() -> st.execute("UPDATE published_analyses SET history_id=history_id WHERE id=-1"));
            assertPermissionDenied(() -> st.execute("DELETE FROM published_analyses WHERE id=-1"));
        }
    }

    private static long returnedId(Statement statement, String sql) throws SQLException {
        try (ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private static void assertPermissionDenied(SqlAction action) {
        SQLException denied = assertThrows(SQLException.class, action::run);
        assertEquals("42501", denied.getSQLState(), denied.getMessage());
    }

    private static boolean hasPrivilege(Connection connection, String table, String privilege)
            throws SQLException {
        try (var ps = connection.prepareStatement(
                "SELECT has_table_privilege('planetory_app', ?, ?)")) {
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

    @FunctionalInterface
    private interface SqlAction {
        void run() throws SQLException;
    }
}
