package com.planetory.backend;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.planetory.backend.domain.exploration.command.CandidateCorrectionPrecheckCommand;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 사전검사 명령의 <b>기동 단계</b>가 DB를 바꾸지 않는지 [S15P21C206-154 리뷰].
 *
 * <p>Flyway는 {@code ApplicationRunner}보다 먼저 돌고 배포 compose는 마이그레이션 계정까지 넘긴다.
 * 그래서 마이그레이션이 한 번도 돌지 않은 DB를 흉내 낸다 — 테이블이 하나도 없는 빈 스키마를 만들고
 * 실제 기동 경로로 띄운 뒤, 스키마가 그대로 비어 있는지 본다. 보호가 없으면 여기서 전체 스키마와
 * {@code flyway_schema_history}가 만들어진다.
 *
 * <p>컨텍스트를 일부러 실패시키므로 {@code @SpringBootTest}를 쓰지 않고 직접 띄운다. 접속값은
 * {@code application-local.properties}와 같은 규칙으로 읽는다.
 */
class CandidateCorrectionPrecheckBootTest {

    private static final String URL = System.getenv().getOrDefault(
            "DATABASE_URL", "jdbc:postgresql://localhost:15432/planetory_poc");
    private static final String USER = System.getenv().getOrDefault("DATABASE_USER", "planetory");
    private static final String PASSWORD = System.getenv().getOrDefault("DATABASE_PASSWORD", "ssafy");

    private String schema;

    @BeforeEach
    void createEmptySchema() throws Exception {
        schema = "correction_boot_" + UUID.randomUUID().toString().replace("-", "");
        execute("CREATE SCHEMA " + schema);
        assertEquals(0, tableCount(), "시작할 때 비어 있어야 검사가 의미 있다");
    }

    @AfterEach
    void dropOnlyThisTestSchema() throws Exception {
        execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    }

    /**
     * 마이그레이션이 적용되지 않은 DB를 향해 실제 기동 경로로 띄운다.
     *
     * <p>기대: <b>아무것도 만들지 않고 실패한다.</b> Flyway는 인자로 꺼져 있고, 그다음 Hibernate의
     * {@code ddl-auto=validate}가 필요한 테이블이 없다고 기동을 멈춘다. 둘 중 하나라도 빠지면 이
     * 실행이 스키마를 통째로 만들어 버린다.
     */
    @Test
    void 미적용_스키마에서는_아무것도_만들지_않고_실패한다() throws Exception {
        String[] args = PlanetoryApplication.withReadOnlyGuards(new String[] {
                "--planetory.command=" + CandidateCorrectionPrecheckCommand.NAME,
                "--spring.profiles.active=local",
                "--spring.datasource.hikari.schema=" + schema,
                "--planetory.correction.kind=merge",
                "--planetory.correction.candidates=1,2",
                "--planetory.correction.keep=1",
        });
        assertTrue(List.of(args).contains("--spring.flyway.enabled=false"),
                "운영자가 빼먹어도 기동 경로가 붙여야 한다");

        assertThrows(Exception.class, () -> PlanetoryApplication.application(args).run(args).close(),
                "스키마가 준비되지 않았으면 조용히 진행하지 않는다");

        assertEquals(0, tableCount(), "기동이 테이블을 하나라도 만들면 읽기 전용이 아니다");
        assertFalse(hasTable("flyway_schema_history"), "마이그레이션 이력 테이블도 생기지 않는다");
    }

    private int tableCount() throws Exception {
        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT count(*) FROM information_schema.tables WHERE table_schema = '" + schema + "'")) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private boolean hasTable(String name) throws Exception {
        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT count(*) FROM information_schema.tables WHERE table_schema = '" + schema
                             + "' AND table_name = '" + name + "'")) {
            rows.next();
            return rows.getInt(1) > 0;
        }
    }

    private void execute(String sql) throws Exception {
        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD);
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
