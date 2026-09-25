package com.planetory.backend.domain.statistics.service;

import java.sql.DriverManager;
import java.util.List;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import static org.junit.jupiter.api.Assertions.*;

/** V20은 173 통합본이 제공해야 한다. 누락된 번호를 무시하거나 outOfOrder로 숨기지 않는다. */
@Testcontainers
class StatisticsMigrationTest {
    @Container static final PostgreSQLContainer<?> DB=new PostgreSQLContainer<>("postgres:18.6-alpine");
    Flyway flyway(String target) {
        return Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword())
                .locations("classpath:db/migration").target(target).load();
    }
    @Test void V19에서V20다음V21적용검증재실행영건() throws Exception {
        // target은 버전 마이그레이션만 제한하고 반복 마이그레이션(R__)은 함께 적용되므로 버전만 센다.
        assertEquals(19,flyway("19").migrate().migrations.stream().filter(m->"Versioned".equals(m.category)).count());
        var twenty=flyway("20").migrate();
        assertEquals(List.of("20"),twenty.migrations.stream().map(m->m.version).toList());
        var twentyOne=flyway("21").migrate();
        assertEquals(List.of("21"),twentyOne.migrations.stream().map(m->m.version).toList());
        flyway("21").validate();
        assertEquals(0,flyway("21").migrate().migrationsExecuted);
        try(var c=DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());var s=c.createStatement()) {
            s.execute("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (1,0,'published')");
            s.execute("INSERT INTO challenge_rounds(id,round_no,starts_on,ends_on,target_tic_id,description,status) VALUES (1,1,current_date,current_date+7,1,'test','planned')");
            s.execute("CREATE ROLE stats_test_login LOGIN");
            s.execute("GRANT planetory_stats_job TO stats_test_login");
            s.execute("CREATE ROLE app_test_login LOGIN");
            s.execute("GRANT planetory_app TO app_test_login");
            s.execute("SET SESSION AUTHORIZATION stats_test_login");
            s.execute("REFRESH MATERIALIZED VIEW global_stats");
            s.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY global_stats");
            s.execute("INSERT INTO stats_snapshots(snapshot_date,scope,metrics) VALUES (current_date,'global','{}')");
            var duplicate=assertThrows(java.sql.SQLException.class,()->s.execute("INSERT INTO stats_snapshots(snapshot_date,scope,metrics) VALUES (current_date,'global','{}')"));
            assertEquals("23505",duplicate.getSQLState());
            s.execute("INSERT INTO stats_snapshots(snapshot_date,scope,round_id,metrics) VALUES (current_date,'round',1,'{}')");
            assertEquals("23505",assertThrows(java.sql.SQLException.class,()->s.execute("INSERT INTO stats_snapshots(snapshot_date,scope,round_id,metrics) VALUES (current_date,'round',1,'{}')")).getSQLState());
            assertEquals("42501",assertThrows(java.sql.SQLException.class,()->s.execute("DELETE FROM stats_snapshots")).getSQLState());
            s.execute("RESET SESSION AUTHORIZATION");
            s.execute("SET SESSION AUTHORIZATION app_test_login");
            s.executeQuery("SELECT * FROM global_stats").close();
            s.executeQuery("SELECT * FROM stats_snapshots").close();
            assertEquals("42501",assertThrows(java.sql.SQLException.class,()->s.execute("REFRESH MATERIALIZED VIEW global_stats")).getSQLState());
            assertEquals("42501",assertThrows(java.sql.SQLException.class,()->s.execute("UPDATE stats_snapshots SET metrics='{}'")).getSQLState());
            assertEquals("42501",assertThrows(java.sql.SQLException.class,()->s.execute("SELECT nextval('stats_snapshots_id_seq')")).getSQLState());
        }
    }
}
