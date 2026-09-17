package com.planetory.backend.domain.exploration.command;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.context.WebApplicationContext;

import com.planetory.backend.PlanetoryApplication;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 챌린지 회차 별 일괄 발견 명령 [S15P21C206-139].
 *
 * <p>운영자가 실행하는 것과 같이 웹 서버 없는 컨텍스트에 명령 속성을 주고 띄운다. 발견 규칙 자체는
 * {@code TutorialProgressTest}가 검증하고, 여기서는 명령 모드 기동과 종료 코드만 본다.
 */
@ActiveProfiles("local")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = PlanetoryApplication.COMMAND_PROPERTY + "=" + ChallengeUnlockCommand.NAME)
class ChallengeUnlockCommandTest {

    private static final String SCHEMA =
            "challenge_command_" + UUID.randomUUID().toString().replace("-", "");

    private static final long CHALLENGE = 7001;

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired ChallengeUnlockCommand command;
    @Autowired ApplicationContext context;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void reset() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
    }

    /** 웹 보안 설정 없이 뜬다. 서버가 떠 있는 호스트에서 실행해도 포트를 잡지 않는다. */
    @Test
    void 명령은_웹_서버_없이_뜬다() {
        assertFalse(context instanceof WebApplicationContext);
        assertTrue(context.getBeansOfType(SecurityFilterChain.class).isEmpty());
    }

    /** 회차를 active로 바꾸지 않고 실행하면 아무것도 바꾸지 않고 2로 끝난다. */
    @Test
    void 진행_회차가_없으면_종료_코드_2다() throws Exception {
        seedMemberWithAllTutorials();
        jdbc.update("INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id, description, status)"
                + " VALUES (1, DATE '2026-09-14', DATE '2026-09-21', ?, '설명', 'planned')", CHALLENGE);

        command.run(null);

        assertEquals(ChallengeUnlockCommand.NO_ACTIVE_ROUND, command.getExitCode());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM star_unlocks", Integer.class));
    }

    @Test
    void 진행_회차가_있으면_자격_회원에게_열고_종료_코드_0이다() throws Exception {
        long member = seedMemberWithAllTutorials();
        jdbc.update("INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id, description, status)"
                + " VALUES (1, DATE '2026-09-14', DATE '2026-09-21', ?, '설명', 'active')", CHALLENGE);

        command.run(null);

        assertEquals(0, command.getExitCode());
        assertEquals("challenge", jdbc.queryForObject("SELECT unlock_reason FROM star_unlocks"
                + " WHERE user_id = ? AND tic_id = ?", String.class, member, CHALLENGE));
    }

    /** 튜토리얼 다섯 개를 완료한 회원. 자격 판정은 진행 단계만 보므로 발견 행은 넣지 않는다. */
    private long seedMemberWithAllTutorials() {
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", CHALLENGE);
        long member = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', 'command', 'command') RETURNING id", Long.class);
        for (int seq = 1; seq <= 5; seq++) {
            long tic = 9000 + seq;
            jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", tic);
            jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (?, ?, 'fp', true)", seq, tic);
            jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason, completed_at)"
                    + " VALUES (?, ?, 'completed', 'all_found', now())", member, tic);
        }
        return member;
    }
}
