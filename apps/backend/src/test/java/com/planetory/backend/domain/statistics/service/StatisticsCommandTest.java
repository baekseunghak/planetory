package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.statistics.command.StatisticsCommand;
import java.sql.DriverManager;
import java.time.LocalDate;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.context.WebApplicationContext;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import static org.junit.jupiter.api.Assertions.*;

@Testcontainers
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.NONE,properties={
        "planetory.command=statistics","planetory.statistics.mode=snapshot","spring.flyway.enabled=false"})
class StatisticsCommandTest {
    @Container static final PostgreSQLContainer<?> DB=new PostgreSQLContainer<>("postgres:18.6-alpine");
    @DynamicPropertySource static void database(DynamicPropertyRegistry r) throws Exception {
        Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword()).load().migrate();
        try(var c=DriverManager.getConnection(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword());var s=c.createStatement()) {
            s.execute("CREATE ROLE stats_command_test LOGIN PASSWORD 'synthetic-test'");
            s.execute("GRANT planetory_stats_job TO stats_command_test");
        }
        r.add("spring.datasource.url",DB::getJdbcUrl);
        r.add("spring.datasource.username",()->"stats_command_test");
        r.add("spring.datasource.password",()->"synthetic-test");
    }
    @Autowired StatisticsCommand command;
    @Autowired StatisticsAggregationService aggregation;
    @Autowired StatisticsSnapshotService snapshots;
    @Autowired ApplicationContext context;

    @Test void 전용잡계정으로웹없이기동하고명령결과종료코드를구분한다() {
        assertFalse(context instanceof WebApplicationContext);
        assertEquals(0,command.getExitCode());
        assertEquals(0,snapshots.latest().cohortMemberCount());
        command.run(null); assertEquals(0,command.getExitCode());
        var env=new MockEnvironment().withProperty("planetory.statistics.mode","refresh");
        var refresh=new StatisticsCommand(aggregation,env); refresh.run(null); assertEquals(0,refresh.getExitCode());
        env.setProperty("planetory.statistics.mode","snapshot");
        env.setProperty("planetory.statistics.cutoff",LocalDate.now(com.planetory.backend.domain.statistics.dto.StatisticsDtos.ZONE).minusDays(1).toString());
        refresh.run(null); assertEquals(3,refresh.getExitCode());
        env.setProperty("planetory.statistics.mode","invalid");
        assertThrows(IllegalArgumentException.class,()->refresh.run(null));
    }
}
