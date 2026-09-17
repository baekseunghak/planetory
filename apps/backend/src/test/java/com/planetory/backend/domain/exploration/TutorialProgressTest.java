package com.planetory.backend.domain.exploration;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.InitialExplorationService;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService.Reason;
import com.planetory.backend.domain.exploration.service.TutorialProgressService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 튜토리얼 순차 발견·챌린지 발견 [S15P21C206-139].
 *
 * <p>탐사 API 9.4절과 AT-61·88·89를 따른다. 완료 단계 변경은 제출 저장(S15P21C206-143)의 몫이라
 * 여기서는 진행 행을 직접 완료로 바꾼 뒤 후처리 함수를 부른다. 실행마다 별도 스키마를 쓴다.
 */
@ActiveProfiles("local")
@SpringBootTest
class TutorialProgressTest {

    private static final String SCHEMA =
            "tutorial_progress_" + UUID.randomUUID().toString().replace("-", "");

    /** 튜토리얼 1~5번 별. 순번과 헷갈리지 않게 떨어진 값을 쓴다. */
    private static final long[] TUTORIAL = {0, 9001, 9002, 9003, 9004, 9005};
    private static final long CHALLENGE = 7001;
    private static final long NEXT_CHALLENGE = 7002;
    private static final long ORDINARY = 8001;

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

    @Autowired TutorialProgressService progress;
    @Autowired StarDiscoveryService discovery;
    @Autowired InitialExplorationService initial;
    @Autowired MemberService members;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        String[] intents = {null, "deep_confirmed", "shallow_confirmed", "fp", "deep_fp", "multi_fp"};
        for (int seq = 1; seq <= 5; seq++) {
            insertStar(TUTORIAL[seq]);
            jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (?, ?, ?, true)",
                    seq, TUTORIAL[seq], intents[seq]);
        }
        insertStar(CHALLENGE);
        insertStar(NEXT_CHALLENGE);
        insertStar(ORDINARY);
    }

    // ---------- 공통 발견 함수 ----------

    /** 순번은 회원 안에서 이어지고 좌표는 배치 함수의 값이다(9.2절 5단계). */
    @Test
    void 발견은_회원별_순번을_이어_쓰고_배치_함수의_좌표를_저장한다() {
        long member = insertMember();
        long other = insertMember();

        inTx(() -> discovery.discover(member, TUTORIAL[1], Reason.TUTORIAL));
        inTx(() -> discovery.discover(other, TUTORIAL[1], Reason.TUTORIAL));
        var second = inTx(() -> discovery.discover(member, ORDINARY, Reason.CHALLENGE)).orElseThrow();

        assertEquals(1, second.layoutOrdinal(), "다른 회원의 발견은 내 순번을 밀지 않는다");
        assertEquals(layout.place(1), second.position());
        Map<String, Object> row = jdbc.queryForMap("SELECT unlock_reason, layout_ordinal, world_x::float8 AS x,"
                + " world_y::float8 AS y, depth_z::float8 AS z, layout_version FROM star_unlocks"
                + " WHERE user_id = ? AND tic_id = ?", member, ORDINARY);
        assertEquals("challenge", row.get("unlock_reason"));
        // NUMERIC 열을 거치므로 비트 단위 비교 대신 허용 오차로 본다.
        assertEquals(layout.place(1).worldX(), (double) row.get("x"), 1e-9);
        assertEquals(layout.place(1).worldY(), (double) row.get("y"), 1e-9);
        assertEquals(layout.place(1).depthZ(), (double) row.get("z"), 1e-9);
        assertEquals(layout.place(1).layoutVersion(), row.get("layout_version"));
        assertEquals("u-" + member + ":2", second.skyVersion());
    }

    /** 이미 열린 별은 순번을 쓰지 않고 지도 버전도 올리지 않는다. 바뀐 것이 없는데 지도를 다시 받게 된다. */
    @Test
    void 이미_열린_별은_순번도_지도_버전도_바꾸지_않는다() {
        long member = insertMember();
        inTx(() -> discovery.discover(member, TUTORIAL[1], Reason.TUTORIAL));

        var again = inTx(() -> discovery.discover(member, TUTORIAL[1], Reason.CHALLENGE));

        assertTrue(again.isEmpty());
        assertEquals(1, unlockCount(member));
        assertEquals(1, revision(member));
        assertEquals("tutorial", reasonOf(member, TUTORIAL[1]), "처음 연 이유를 덮어쓰지 않는다");
    }

    // ---------- 회원 생성 ----------

    /** 서로 다른 회원이 동시에 가입해도 각자 튜토리얼 1번을 순번 0에 받는다. */
    @Test
    void 동시에_가입한_회원은_각자_튜토리얼_1번을_순번_0에_받는다() throws Exception {
        int signups = 6;
        var start = new CountDownLatch(1);
        List<Long> ids = new ArrayList<>();
        try (var executor = Executors.newFixedThreadPool(signups)) {
            List<Future<Long>> results = new ArrayList<>();
            for (int i = 0; i < signups; i++) {
                String subject = "signup-" + i;
                results.add(executor.submit(() -> {
                    assertTrue(start.await(10, TimeUnit.SECONDS));
                    return members.login("google", subject).getId();
                }));
            }
            start.countDown();
            for (var result : results) {
                ids.add(result.get(30, TimeUnit.SECONDS));
            }
        }

        for (long id : ids) {
            assertEquals(List.of(Map.of("tic_id", TUTORIAL[1], "unlock_reason", "tutorial", "layout_ordinal", 0)),
                    jdbc.queryForList("SELECT tic_id, unlock_reason, layout_ordinal FROM star_unlocks"
                            + " WHERE user_id = ?", id));
            assertEquals(1, revision(id));
        }
    }

    // ---------- 튜토리얼 n 완료 ----------

    /** 완료 사유와 관계없이 다음 순번이 열린다. 건너뛰기로 끝나도 성과는 없다(SUB-12, AT-88). */
    @Test
    void 튜토리얼을_끝내면_사유와_관계없이_다음_순번이_열리고_성과는_없다() {
        for (String reason : List.of("all_found", "undiscoverable_only", "skipped")) {
            long member = signUp();

            var opened = completeTutorial(member, 1, reason);

            assertEquals(TUTORIAL[2], opened.orElseThrow().ticId(), reason);
            assertEquals("tutorial", reasonOf(member, TUTORIAL[2]), reason);
            assertEquals(1, opened.get().layoutOrdinal(), reason);
            assertEquals(2, revision(member), reason);
            assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements WHERE user_id = ?",
                    Integer.class, member), reason);
            assertEquals(0, jdbc.queryForObject("SELECT COALESCE(sum(achievement_count), 0) FROM user_star_progress"
                    + " WHERE user_id = ?", Integer.class, member), reason);
        }
    }

    /** 같은 완료 사건을 다시 처리해도 한 번만 열린다. */
    @Test
    void 같은_완료_사건을_다시_처리해도_한_번만_열린다() {
        long member = signUp();
        completeTutorial(member, 1, "all_found");

        var again = inTx(() -> progress.onTutorialCompleted(member, TUTORIAL[1]));

        assertTrue(again.isEmpty());
        assertEquals(2, unlockCount(member));
        assertEquals(2, revision(member));
    }

    /** 완료가 아니면 다음 순번을 열지 않는다. 튜토리얼이 아닌 별은 아무것도 하지 않는다. */
    @Test
    void 완료가_아니거나_튜토리얼이_아니면_아무것도_열지_않는다() {
        long member = signUp();
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'in_progress' WHERE user_id = ? AND tic_id = ?",
                member, TUTORIAL[1]);
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason, completed_at)"
                + " VALUES (?, ?, 'completed', 'all_found', now())", member, ORDINARY);

        assertTrue(inTx(() -> progress.onTutorialCompleted(member, TUTORIAL[1])).isEmpty());
        assertTrue(inTx(() -> progress.onTutorialCompleted(member, ORDINARY)).isEmpty());
        assertEquals(1, unlockCount(member));
        assertEquals(1, revision(member));
    }

    /** 다음 순번이 설정되지 않았으면 가입과 같이 503으로 멈추고 아무것도 남기지 않는다. */
    @Test
    void 다음_순번이_설정되지_않았으면_503으로_멈추고_되돌린다() {
        long member = signUp();
        completeTutorial(member, 1, "all_found");
        jdbc.update("UPDATE tutorial_stars SET active = false WHERE seq = 3");
        markCompleted(member, TUTORIAL[2], "all_found");

        var thrown = assertThrows(BusinessException.class,
                () -> inTx(() -> progress.onTutorialCompleted(member, TUTORIAL[2])));

        assertEquals(ErrorCode.DEPENDENCY_UNAVAILABLE, thrown.getErrorCode());
        assertEquals(2, unlockCount(member));
        assertEquals(2, revision(member));
    }

    // ---------- 다섯 번째 완료 ----------

    /** 회차 진행 중에 다섯 번째를 끝내면 그 자리에서 챌린지 별이 열린다(AT-89, F17-Q2). */
    @Test
    void 회차_진행_중에_다섯_번째를_끝내면_챌린지_별이_바로_열린다() {
        insertRound(1, "active", CHALLENGE);
        long member = signUp();
        for (int seq = 1; seq <= 4; seq++) {
            completeTutorial(member, seq, "all_found");
        }

        var opened = completeTutorial(member, 5, "skipped");

        assertEquals(CHALLENGE, opened.orElseThrow().ticId());
        assertEquals("challenge", reasonOf(member, CHALLENGE));
        assertEquals(5, opened.get().layoutOrdinal());
    }

    @Test
    void 진행_회차가_없으면_다섯_번째를_끝내도_아무것도_열지_않는다() {
        insertRound(1, "planned", CHALLENGE);
        insertRound(2, "closed", NEXT_CHALLENGE);
        long member = completeAllTutorials();

        assertEquals(5, unlockCount(member));
        assertFalse(unlocked(member, CHALLENGE));
    }

    // ---------- 새 회차 active 전환 ----------

    /** 튜토리얼을 끝낸 활동 회원에게만 연다. 미완료·탈퇴 회원은 받지 않는다(HOME-02, POL-24). */
    @Test
    void 회차_전환은_튜토리얼을_끝낸_활동_회원에게만_연다() {
        long done1 = completeAllTutorials();
        long done2 = completeAllTutorials();
        long unfinished = signUp();
        completeTutorial(unfinished, 1, "all_found");
        long withdrawn = completeAllTutorials();
        jdbc.update("UPDATE users SET status = 'withdrawn', withdrawn_at = now() WHERE id = ?", withdrawn);
        insertRound(1, "active", CHALLENGE);

        var result = progress.unlockActiveChallenge().orElseThrow();

        assertEquals(2, result.opened());
        assertEquals(0, result.skipped());
        assertEquals(1, result.round().roundNo());
        assertTrue(unlocked(done1, CHALLENGE));
        assertTrue(unlocked(done2, CHALLENGE));
        assertFalse(unlocked(unfinished, CHALLENGE));
        assertFalse(unlocked(withdrawn, CHALLENGE));
        assertEquals("challenge", reasonOf(done1, CHALLENGE));
        assertEquals(6, revision(done1));
    }

    /** 두 번 실행해도 한 번만 열리고, 두 번째 실행은 지도 버전을 올리지 않는다. */
    @Test
    void 회차_전환을_두_번_실행해도_한_번만_열린다() {
        long member = completeAllTutorials();
        insertRound(1, "active", CHALLENGE);

        assertEquals(1, progress.unlockActiveChallenge().orElseThrow().opened());
        var second = progress.unlockActiveChallenge().orElseThrow();

        assertEquals(0, second.opened());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE tic_id = ?",
                Integer.class, CHALLENGE));
        assertEquals(6, revision(member));
    }

    @Test
    void 진행_회차가_없으면_회차_전환은_빈_결과다() {
        completeAllTutorials();
        insertRound(1, "planned", CHALLENGE);

        assertTrue(progress.unlockActiveChallenge().isEmpty());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE tic_id = ?",
                Integer.class, CHALLENGE));
    }

    /** 회차가 끝나도 연 별은 닫히지 않는다. 다음 회차 별은 따로 열린다(AT-61, CHL-03). */
    @Test
    void 회차가_끝나도_연_챌린지_별은_남고_다음_회차_별이_더해진다() {
        long member = completeAllTutorials();
        long first = insertRound(1, "active", CHALLENGE);
        progress.unlockActiveChallenge();

        jdbc.update("UPDATE challenge_rounds SET status = 'closed' WHERE id = ?", first);
        insertRound(2, "active", NEXT_CHALLENGE);
        progress.unlockActiveChallenge();

        assertTrue(unlocked(member, CHALLENGE));
        assertTrue(unlocked(member, NEXT_CHALLENGE));
    }

    /** 처리 도중 회차가 진행 상태에서 벗어나면 멈춘다. 앞서 처리한 회원의 발견은 남는다. */
    @Test
    void 처리_도중_회차가_끝나면_남은_회원에게는_열지_않고_멈춘다() {
        long first = completeAllTutorials();
        long second = completeAllTutorials();
        insertRound(1, "active", CHALLENGE);
        // 첫 회원의 챌린지 발견과 같은 트랜잭션에서 회차를 닫아 "도중 종료"를 재현한다.
        jdbc.execute("""
                CREATE FUNCTION close_round_on_challenge_unlock() RETURNS trigger AS $$
                BEGIN
                    UPDATE challenge_rounds SET status = 'closed' WHERE status = 'active';
                    RETURN NEW;
                END $$ LANGUAGE plpgsql
                """);
        jdbc.execute("CREATE TRIGGER close_round AFTER INSERT ON star_unlocks FOR EACH ROW"
                + " WHEN (NEW.unlock_reason = 'challenge') EXECUTE FUNCTION close_round_on_challenge_unlock()");
        try {
            assertThrows(IllegalStateException.class, () -> progress.unlockActiveChallenge());
        } finally {
            jdbc.execute("DROP TRIGGER close_round ON star_unlocks");
            jdbc.execute("DROP FUNCTION close_round_on_challenge_unlock()");
        }

        assertTrue(unlocked(first, CHALLENGE));
        assertFalse(unlocked(second, CHALLENGE));
    }

    /**
     * 완료한 튜토리얼 별이 새 판에서 재개돼도 튜토리얼 완료는 유지된다. 진행 단계만 보면 다음 회차
     * 자격을 잃는데, 이미 받은 챌린지 별은 닫히지 않아 서로 어긋난다(9.3절 completed_at 유지).
     */
    @Test
    void 재개된_튜토리얼_별이_있어도_다음_회차_별을_받는다() {
        long member = completeAllTutorials();
        reopen(member, TUTORIAL[3]);
        insertRound(1, "active", CHALLENGE);

        assertEquals(1, progress.unlockActiveChallenge().orElseThrow().opened());
        assertTrue(unlocked(member, CHALLENGE));
    }

    @Test
    void 앞_순번이_재개된_채로_다섯_번째를_끝내도_챌린지_별이_열린다() {
        insertRound(1, "active", CHALLENGE);
        long member = signUp();
        for (int seq = 1; seq <= 4; seq++) {
            completeTutorial(member, seq, "all_found");
        }
        reopen(member, TUTORIAL[1]);

        assertEquals(CHALLENGE, completeTutorial(member, 5, "all_found").orElseThrow().ticId());
    }

    /**
     * 다섯 번째 완료와 회차 전환이 동시에 와도 한 번만 열린다. 두 경로가 같은 회원 잠금과
     * 발견 함수를 쓰기 때문이다.
     */
    @Test
    void 다섯_번째_완료와_회차_전환이_동시에_와도_한_번만_열린다() throws Exception {
        insertRound(1, "active", CHALLENGE);
        for (int attempt = 0; attempt < 5; attempt++) {
            long member = signUp();
            for (int seq = 1; seq <= 4; seq++) {
                completeTutorial(member, seq, "all_found");
            }
            // 제출이 완료를 커밋했고 후처리 직전이다. 회차 전환 명령도 이 회원을 대상으로 본다.
            markCompleted(member, TUTORIAL[5], "all_found");
            long before = revision(member);

            var start = new CountDownLatch(1);
            try (var executor = Executors.newFixedThreadPool(3)) {
                List<Future<?>> tasks = List.of(
                        executor.submit(() -> {
                            start.await(10, TimeUnit.SECONDS);
                            return inTx(() -> progress.onTutorialCompleted(member, TUTORIAL[5]));
                        }),
                        executor.submit(() -> {
                            start.await(10, TimeUnit.SECONDS);
                            return progress.unlockActiveChallenge();
                        }),
                        executor.submit(() -> {
                            start.await(10, TimeUnit.SECONDS);
                            return progress.unlockActiveChallenge();
                        }));
                start.countDown();
                for (var task : tasks) {
                    task.get(30, TimeUnit.SECONDS);
                }
            }

            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ? AND tic_id = ?",
                    Integer.class, member, CHALLENGE), "attempt " + attempt);
            assertEquals(before + 1, revision(member), "attempt " + attempt);
            assertEquals(6, jdbc.queryForObject("SELECT count(DISTINCT layout_ordinal) FROM star_unlocks"
                    + " WHERE user_id = ?", Integer.class, member), "attempt " + attempt);
        }
    }

    // ---------- 도우미 ----------

    private <T> T inTx(Supplier<T> work) {
        return new TransactionTemplate(transactionManager).execute(status -> work.get());
    }

    private long signUp() {
        long member = insertMember();
        inTx(() -> {
            initial.initialize(member);
            return null;
        });
        return member;
    }

    private java.util.Optional<StarDiscoveryService.DiscoveredStar> completeTutorial(long member, int seq,
                                                                                    String reason) {
        markCompleted(member, TUTORIAL[seq], reason);
        return inTx(() -> progress.onTutorialCompleted(member, TUTORIAL[seq]));
    }

    private long completeAllTutorials() {
        long member = signUp();
        for (int seq = 1; seq <= 5; seq++) {
            completeTutorial(member, seq, "all_found");
        }
        return member;
    }

    /** 제출 저장(143)이 할 진행 단계 변경을 대신한다. */
    private void markCompleted(long member, long tic, String reason) {
        jdbc.update("""
                INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason, completed_at)
                VALUES (?, ?, 'completed', ?, now())
                ON CONFLICT (user_id, tic_id) DO UPDATE
                   SET progress_stage = 'completed', completion_reason = EXCLUDED.completion_reason,
                       completed_at = EXCLUDED.completed_at
                """, member, tic, reason);
    }

    /** 새 판 전환 후처리(150)가 할 재개를 대신한다. 완료 시각과 사유는 남긴다(9.3절). */
    private void reopen(long member, long tic) {
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'in_progress', reopen_pending = false,"
                + " reopened_at = now() WHERE user_id = ? AND tic_id = ?", member, tic);
    }

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private void insertStar(long tic) {
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", tic);
    }

    private long insertRound(int roundNo, String status, long target) {
        return jdbc.queryForObject("INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id,"
                + " description, status) VALUES (?, DATE '2026-09-14', DATE '2026-09-21', ?, '두 번째 신호 찾기', ?)"
                + " RETURNING id", Long.class, roundNo, target, status);
    }

    private int unlockCount(long member) {
        return jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ?", Integer.class, member);
    }

    private boolean unlocked(long member, long tic) {
        return jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM star_unlocks WHERE user_id = ? AND tic_id = ?)",
                Boolean.class, member, tic);
    }

    private String reasonOf(long member, long tic) {
        return jdbc.queryForObject("SELECT unlock_reason FROM star_unlocks WHERE user_id = ? AND tic_id = ?",
                String.class, member, tic);
    }

    private long revision(long member) {
        return jdbc.queryForObject("SELECT COALESCE((SELECT revision FROM member_sky_revisions WHERE user_id = ?), 0)",
                Long.class, member);
    }
}
