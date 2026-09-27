package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.stream.IntStream;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.AchievementService.AchievementType;
import com.planetory.backend.domain.exploration.service.AchievementService.Recognition;
import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementItem;
import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementList;
import com.planetory.backend.domain.exploration.service.GalaxyLayout.StarPosition;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService.DiscoveredStar;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService.Reason;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static com.planetory.backend.domain.exploration.service.AchievementService.AchievementType.CONFIRMED;
import static com.planetory.backend.domain.exploration.service.AchievementService.AchievementType.FP;
import static com.planetory.backend.domain.exploration.service.AchievementService.AchievementType.UNCONFIRMED;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 신호별 성과 인정·등급·새 별 발견과 성과 조회 [S15P21C206-144].
 *
 * <p>탐사 API 9.1·9.2절과 티켓 완료 조건을 따른다. 제출 저장(S15P21C206-143)과 공개 분석 등록이 아직
 * 없으므로 인정 근거 행은 직접 넣고 호출자 트랜잭션은 {@link TransactionTemplate}이 대신한다.
 * 실행마다 별도 스키마를 쓴다.
 */
@ActiveProfiles("local")
@SpringBootTest
class AchievementServiceTest {

    private static final String SCHEMA = "achievement_" + UUID.randomUUID().toString().replace("-", "");

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

    /** 성과를 내는 별 둘. 회원이 먼저 발견해 두므로 성과로는 열리지 않는다. */
    private static final long HOME = 5001;
    private static final long HOME_2 = 5002;
    private static final long[] ORDINARY = {6001, 6002, 6003, 6004, 6005};
    private static final long HIDDEN = 6100;
    private static final long TUTORIAL_ACTIVE = 6200;
    private static final long TUTORIAL_INACTIVE = 6250;
    private static final long CHALLENGE_ACTIVE = 6300;
    private static final long CHALLENGE_PLANNED = 6400;
    /** 공개됐지만 찾을 신호가 없는 별. 열어도 성과를 낼 수 없어 빠진다 [S15P21C206-282]. */
    private static final long UNDISCOVERABLE_ONLY = 6500;
    private static final long NO_SIGNAL = 6600;

    /** 성과로 열릴 수 있는 별. 운영을 멈춘 튜토리얼 별과 예정 회차 대상은 뺄 이유가 없다(OPS-08). */
    private static final Set<Long> ELIGIBLE = Set.of(6001L, 6002L, 6003L, 6004L, 6005L,
            TUTORIAL_INACTIVE, CHALLENGE_PLANNED);

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

    @Autowired AchievementService achievements;
    @Autowired StarDiscoveryService discovery;
    @Autowired StarService stars;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    private long member;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        for (long tic : new long[] {HOME, HOME_2, TUTORIAL_ACTIVE, TUTORIAL_INACTIVE, CHALLENGE_ACTIVE,
                CHALLENGE_PLANNED}) {
            insertStar(tic, "published");
        }
        for (long tic : ORDINARY) {
            insertStar(tic, "published");
        }
        insertStar(HIDDEN, "hidden");
        insertStar(UNDISCOVERABLE_ONLY, "published");
        insertStar(NO_SIGNAL, "published");
        // 제외 규칙마다 따로 보이도록 찾을 신호는 모든 별에 두고, 신호 없는 두 별만 뺀다.
        for (long tic : new long[] {TUTORIAL_ACTIVE, TUTORIAL_INACTIVE, CHALLENGE_ACTIVE, CHALLENGE_PLANNED,
                HIDDEN, UNDISCOVERABLE_ONLY, NO_SIGNAL}) {
            insertBundle(tic);
        }
        for (long tic : ORDINARY) {
            insertBundle(tic);
            candidate(tic);
        }
        for (long tic : new long[] {TUTORIAL_ACTIVE, TUTORIAL_INACTIVE, CHALLENGE_ACTIVE, CHALLENGE_PLANNED,
                HIDDEN, UNDISCOVERABLE_ONLY}) {
            candidate(tic);
        }
        jdbc.update("UPDATE candidates SET discoverable = false WHERE tic_id = ?", UNDISCOVERABLE_ONLY);
        jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (1, ?, 'deep_confirmed', true)",
                TUTORIAL_ACTIVE);
        jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (2, ?, 'shallow_confirmed', false)",
                TUTORIAL_INACTIVE);
        insertRound(1, "active", CHALLENGE_ACTIVE);
        insertRound(2, "planned", CHALLENGE_PLANNED);
        insertBundle(HOME);
        insertBundle(HOME_2);
        useStarsPerAchievement(1);

        member = insertMember();
        open(member, HOME);
        open(member, HOME_2);
    }

    // ---------- 9.2 성과 인정·별 열림 ----------

    @Test
    void 처음_인정한_신호는_성과_행과_별의_성과_수를_남기고_못_찾은_별_하나를_성과_경로로_연다() {
        long candidate = candidate(HOME);
        long before = revision(member);

        Recognition result = recognize(member, candidate, CONFIRMED);

        assertTrue(result.newlyRecognized());
        assertEquals(HOME, result.ticId());
        assertEquals(1, result.ticAchievementCount());
        assertEquals("A", result.grade());
        assertEquals(new StarViews.AchievementByType(1, 0, 0), result.star().byType());
        assertEquals(0, result.unlockShortfall());
        assertEquals(1, result.unlockedStars().size());
        DiscoveredStar star = result.unlockedStars().getFirst();
        assertTrue(ELIGIBLE.contains(star.ticId()), "성과로 열 수 없는 별을 열었다: " + star.ticId());

        Map<String, Object> row = unlockRow(member, star.ticId());
        assertEquals("achievement", row.get("unlock_reason"));
        assertEquals(HOME, ((Number) row.get("trigger_tic_id")).longValue());
        assertEquals(result.achievementId(), ((Number) row.get("trigger_achievement_id")).longValue());
        assertEquals(0, ((Number) row.get("seq")).intValue());
        assertEquals(2, star.layoutOrdinal(), "먼저 연 두 별 뒤에 이어 쓴다");
        assertEquals(1, achievementCount(member, HOME));
        assertFalse(fpSuccess(member, HOME));
        assertEquals(before + 1, revision(member));
        assertEquals("u-" + member + ":" + revision(member), result.skyVersion());
    }

    /** 응답을 잃고 다시 불러도 성과·별·지도 버전이 그대로다(SUB-06, AT-12). */
    @Test
    void 이미_인정한_신호를_다시_인정하면_아무것도_바꾸지_않는다() {
        long candidate = candidate(HOME);
        Recognition first = recognize(member, candidate, CONFIRMED);
        long unlocks = unlockCount(member);
        long revision = revision(member);

        Recognition again = recognize(member, candidate, CONFIRMED);

        assertFalse(again.newlyRecognized());
        assertEquals(first.achievementId(), again.achievementId());
        assertEquals(List.of(), again.unlockedStars());
        assertEquals(0, again.unlockShortfall());
        assertEquals(1, again.ticAchievementCount());
        assertEquals(unlocks, unlockCount(member));
        assertEquals(revision, revision(member));
        assertEquals("u-" + member + ":" + revision, again.skyVersion());
        assertEquals(1, achievementCount(member, HOME));
    }

    /** 등급은 성과 수에서 만들고 성과마다 발견 수는 같다. 유형은 등급을 가르지 않는다(GRD-01). */
    @Test
    void 등급은_별의_성과_수_1_2_3_4개_이상에서_A_S_SS_SSS이고_성과마다_별을_하나씩_연다() {
        List<String> grades = new ArrayList<>();
        AchievementType[] types = {CONFIRMED, FP, CONFIRMED, FP, CONFIRMED};
        for (AchievementType type : types) {
            Recognition result = recognize(member, candidate(HOME), type);
            grades.add(result.grade());
            assertEquals(1, result.unlockedStars().size(), "성과당 발견 수");
        }

        assertEquals(List.of("A", "S", "SS", "SSS", "SSS"), grades);
        assertEquals(5, achievementCount(member, HOME));
        assertEquals(2 + 5, unlockCount(member));
    }

    @Test
    void FP_성과는_fp_success를_켜고_이후_다른_유형의_성과가_와도_끄지_않는다() {
        recognize(member, candidate(HOME), FP);
        assertTrue(fpSuccess(member, HOME));

        recognize(member, candidate(HOME), CONFIRMED);

        assertTrue(fpSuccess(member, HOME));
        assertFalse(fpSuccess(member, HOME_2), "다른 별의 이력은 건드리지 않는다");
    }

    /**
     * OPS-08 제외 규칙과 찾을 신호가 없는 별(탐색 불가 후보만 있거나 후보가 없는 별, S15P21C206-282).
     * 발견 수를 크게 잡아 후보 전체를 한 번에 열어 본다.
     */
    @Test
    void 후보는_공개된_못_찾은_별이고_운영_중인_튜토리얼_별과_진행_중인_회차_대상과_찾을_신호_없는_별은_빠진다() {
        useStarsPerAchievement(100);

        Recognition result = recognize(member, candidate(HOME), CONFIRMED);

        assertEquals(ELIGIBLE, Set.copyOf(tics(result.unlockedStars())));
        assertEquals(100 - ELIGIBLE.size(), result.unlockShortfall(), "있는 만큼만 연다(D-11)");
        assertEquals(IntStream.range(0, ELIGIBLE.size()).boxed().toList(),
                jdbc.queryForList("SELECT seq FROM star_unlocks WHERE trigger_achievement_id = ? ORDER BY seq",
                        Integer.class, result.achievementId()),
                "성과 순번은 0부터 빈틈없이 쓴다");
    }

    /** 완료 조건 (5): 미발견 별이 없으면 성과는 인정되고 발견은 0건이며 부족 수가 사유다. */
    @Test
    void 못_찾은_별이_모두_소진되면_성과만_인정하고_발견은_0건이며_부족_수를_돌려준다() {
        useStarsPerAchievement(100);
        recognize(member, candidate(HOME), CONFIRMED);
        useStarsPerAchievement(2);
        long revision = revision(member);

        Recognition result = recognize(member, candidate(HOME), CONFIRMED);

        assertTrue(result.newlyRecognized());
        assertEquals(List.of(), result.unlockedStars());
        assertEquals(2, result.unlockShortfall());
        assertEquals(2, result.ticAchievementCount());
        assertEquals(revision, revision(member), "연 별이 없으면 지도 버전을 올리지 않는다");
    }

    @Test
    void 못_찾은_별이_발견_수보다_적으면_있는_만큼만_연다() {
        useStarsPerAchievement(ELIGIBLE.size() - 1);
        recognize(member, candidate(HOME), CONFIRMED);
        useStarsPerAchievement(3);

        Recognition result = recognize(member, candidate(HOME), CONFIRMED);

        assertEquals(1, result.unlockedStars().size());
        assertEquals(2, result.unlockShortfall());
    }

    @Test
    void 발견_수가_0이면_별을_열지_않으며_부족도_아니다() {
        useStarsPerAchievement(0);

        Recognition result = recognize(member, candidate(HOME), CONFIRMED);

        assertTrue(result.newlyRecognized());
        assertEquals(List.of(), result.unlockedStars());
        assertEquals(0, result.unlockShortfall());
    }

    /**
     * 좌표는 배치 함수의 값을 그대로 저장한다. double로 넘기면 float8→NUMERIC 변환이 유효숫자 15자리로
     * 반올림한다. 순번 0~5는 정수 고정 좌표라 반올림이 드러나지 않으므로 순번 6 이상까지 연다.
     */
    @Test
    void 성과로_연_별은_회원_순번을_이어_쓰고_배치_함수의_좌표를_비트_단위로_그대로_저장한다() {
        useStarsPerAchievement(ELIGIBLE.size());

        Recognition result = recognize(member, candidate(HOME), CONFIRMED);

        assertEquals(IntStream.rangeClosed(2, 1 + ELIGIBLE.size()).boxed().toList(),
                result.unlockedStars().stream().map(DiscoveredStar::layoutOrdinal).toList());
        assertTrue(result.unlockedStars().stream().map(DiscoveredStar::position)
                        .anyMatch(p -> new BigDecimal(Double.toString(p.worldX())).precision() > 15),
                "15자리를 넘는 좌표가 있어야 반올림 여부를 가를 수 있다");
        for (DiscoveredStar star : result.unlockedStars()) {
            StarPosition expected = layout.place(star.layoutOrdinal());
            assertEquals(expected, star.position());
            Map<String, Object> row = unlockRow(member, star.ticId());
            assertEquals(expected.worldX(), (double) row.get("x"));
            assertEquals(expected.worldY(), (double) row.get("y"));
            assertEquals(expected.depthZ(), (double) row.get("z"));
            assertEquals(expected.layoutVersion(), row.get("layout_version"));
        }
    }

    /** 시드 정책 hash-user-achievement-seq-v1. 고정 벡터는 표준 SHA-256으로 따로 계산한 값이다. */
    @Test
    void 시드는_회원_성과_순번_문자열의_SHA_256_앞_8바이트를_부호_없이_읽은_값이다() {
        assertEquals(new BigInteger("3175712800357220236"), AchievementService.seed(7, 31, 0));
        assertEquals(new BigInteger("12844924516582377546"), AchievementService.seed(7, 31, 1),
                "long 범위를 넘는 값도 음수가 되지 않는다");
    }

    /** 고정 seed 재현: 후보를 TIC 오름차순으로 세우고 seed mod 후보 수번째를 고른다. */
    @Test
    void 고른_별은_회원_성과_순번의_시드와_후보_순서로_재현된다() {
        useStarsPerAchievement(2);

        Recognition result = recognize(member, candidate(HOME), CONFIRMED);

        List<Long> pool = new ArrayList<>(ELIGIBLE.stream().sorted().toList());
        List<Long> expected = new ArrayList<>();
        for (int seq = 0; seq < 2; seq++) {
            BigInteger seed = AchievementService.seed(member, result.achievementId(), seq);
            expected.add(pool.remove(seed.mod(BigInteger.valueOf(pool.size())).intValue()));
        }
        assertEquals(expected, tics(result.unlockedStars()));
    }

    /** 별 저장이 실패하면 호출자 트랜잭션이 통째로 되돌아가 성과만 남는 일이 없다. */
    @Test
    void 별_저장이_실패하면_성과와_별의_성과_수도_남지_않는다() {
        long candidate = candidate(HOME);
        long submission = submit(member, candidate);
        long unlocks = unlockCount(member);
        long revision = revision(member);
        jdbc.execute("""
                CREATE FUNCTION fail_achievement_unlock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.unlock_reason = 'achievement' THEN
                        RAISE EXCEPTION 'injected unlock failure';
                    END IF;
                    RETURN NEW;
                END $$""");
        jdbc.execute("CREATE TRIGGER trg_fail_achievement_unlock BEFORE INSERT ON star_unlocks"
                + " FOR EACH ROW EXECUTE FUNCTION fail_achievement_unlock()");
        try {
            assertThrows(DataAccessException.class, () -> inTx(
                    () -> achievements.recognize(member, candidate, CONFIRMED, submission, null)));
        } finally {
            jdbc.execute("DROP TRIGGER trg_fail_achievement_unlock ON star_unlocks");
            jdbc.execute("DROP FUNCTION fail_achievement_unlock()");
        }

        assertEquals(0, achievementRows(member));
        assertEquals(0, achievementCount(member, HOME));
        assertEquals(unlocks, unlockCount(member));
        assertEquals(revision, revision(member));

        Recognition retried = inTx(() -> achievements.recognize(member, candidate, CONFIRMED, submission, null));
        assertTrue(retried.newlyRecognized(), "실패한 인정은 흔적이 없어 다시 인정된다");
    }

    @Test
    void 같은_신호를_동시에_인정해도_성과와_별은_한_번씩만_생긴다() throws Exception {
        for (int attempt = 0; attempt < 5; attempt++) {
            long someone = insertMember();
            open(someone, HOME);
            long candidate = candidate(HOME);
            long submission = submit(someone, candidate);

            List<Recognition> results = concurrently(3,
                    () -> inTx(() -> achievements.recognize(someone, candidate, CONFIRMED, submission, null)));

            assertEquals(1, results.stream().filter(Recognition::newlyRecognized).count(), "attempt " + attempt);
            assertEquals(1, results.stream().map(Recognition::achievementId).distinct().count(), "attempt " + attempt);
            assertEquals(1, achievementRows(someone), "attempt " + attempt);
            assertEquals(1, achievementCount(someone, HOME), "attempt " + attempt);
            assertEquals(2, unlockCount(someone), "attempt " + attempt);
        }
    }

    /** 완료 조건 (4): 확정 성과(제출)와 미확정 성과(공개)가 동시에 와도 회원 잠금으로 줄을 서고 교착이 없다. */
    @Test
    void 같은_회원의_확정_성과와_미확정_성과가_동시에_와도_교착_없이_모두_인정된다() throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            long someone = insertMember();
            open(someone, HOME);
            long confirmed = candidate(HOME);
            long confirmedSubmission = submit(someone, confirmed);
            long unconfirmed = candidate(HOME);
            long unconfirmedSubmission = submit(someone, unconfirmed);
            long analysis = publish(someone, unconfirmed, unconfirmedSubmission);

            List<Supplier<Recognition>> calls = List.of(
                    () -> inTx(() -> achievements.recognize(someone, confirmed, CONFIRMED, confirmedSubmission, null)),
                    () -> inTx(() -> achievements.recognize(someone, unconfirmed, UNCONFIRMED, unconfirmedSubmission,
                            analysis)));
            List<Recognition> results = concurrently(calls);

            assertTrue(results.stream().allMatch(Recognition::newlyRecognized), "attempt " + attempt);
            assertEquals(2, achievementCount(someone, HOME), "attempt " + attempt);
            assertEquals(3, distinctOrdinals(someone), "attempt " + attempt);
        }
    }

    /** 다른 발견 경로(튜토리얼·챌린지)와 동시에 와도 회원별 순번이 겹치지 않는다(9.4절). */
    @Test
    void 성과_발견과_다른_발견_경로가_동시에_와도_순번이_겹치지_않는다() throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            long someone = insertMember();
            open(someone, HOME);
            long candidate = candidate(HOME);
            long submission = submit(someone, candidate);

            List<Supplier<Object>> calls = List.of(
                    () -> inTx(() -> achievements.recognize(someone, candidate, CONFIRMED, submission, null)),
                    () -> inTx(() -> discovery.discover(someone, TUTORIAL_ACTIVE, Reason.TUTORIAL)));
            concurrently(calls);

            assertEquals(3, unlockCount(someone), "attempt " + attempt);
            assertEquals(3, distinctOrdinals(someone), "attempt " + attempt);
        }
    }

    /**
     * 실제 호출자는 근거 기록을 같은 트랜잭션에서 저장한 뒤 인정한다(MR !99 리뷰). 회원 행을 먼저 잠그면
     * 제출 경로(제출 저장 → 확정 인정)와 공개 경로(공개 기록 저장 → 미확정 인정)가 동시에 와도 교착이 없다.
     */
    @Test
    void 호출자가_회원_행을_먼저_잠그고_근거를_저장하면_동시_제출과_공개가_교착_없이_인정된다() throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            long someone = insertMember();
            open(someone, HOME);
            long confirmed = candidate(HOME);
            long unconfirmed = candidate(HOME);
            // 공개할 히스토리의 제출은 앞서 저장돼 있다.
            long published = submit(someone, unconfirmed);

            List<Supplier<Recognition>> calls = List.of(
                    () -> inTx(() -> {
                        lockMember(someone);
                        long submission = submit(someone, confirmed);
                        return achievements.recognize(someone, confirmed, CONFIRMED, submission, null);
                    }),
                    () -> inTx(() -> {
                        lockMember(someone);
                        long analysis = publish(someone, unconfirmed, published);
                        return achievements.recognize(someone, unconfirmed, UNCONFIRMED, published, analysis);
                    }));
            List<Recognition> results = concurrently(calls);

            assertTrue(results.stream().allMatch(Recognition::newlyRecognized), "attempt " + attempt);
            assertEquals(2, achievementCount(someone, HOME), "attempt " + attempt);
            assertEquals(3, distinctOrdinals(someone), "attempt " + attempt);
        }
    }

    /**
     * 선잠금이 필요한 이유를 고정한다. 회원을 참조하는 행을 먼저 쓰면 외래 키 검사의 KEY SHARE 잠금이 남는다.
     * 같은 회원의 두 트랜잭션이 인정 함수의 {@code FOR UPDATE}에서 서로를 기다려 한쪽이 교착(40P01)으로 끝난다.
     * 회원 잠금 방식을 바꿔 이 교착이 사라지면 이 테스트와 9.2절 설명을 함께 고친다.
     */
    @Test
    void 회원_행을_잠그기_전에_근거를_저장하면_같은_회원의_동시_인정_한쪽이_교착으로_끝난다() throws Exception {
        long first = candidate(HOME);
        long second = candidate(HOME);
        var bothSaved = new CyclicBarrier(2);
        List<Supplier<Recognition>> calls = List.of(first, second).stream()
                .<Supplier<Recognition>>map(signal -> () -> inTx(() -> {
                    long submission = submit(member, signal);
                    await(bothSaved);
                    return achievements.recognize(member, signal, CONFIRMED, submission, null);
                }))
                .toList();

        List<Outcome<Recognition>> outcomes = outcomes(calls);

        List<Throwable> failures = outcomes.stream().map(Outcome::error).filter(e -> e != null).toList();
        assertEquals(1, failures.size(), "한쪽만 교착으로 끝나고 다른 쪽은 이어서 인정된다");
        assertEquals("40P01", sqlState(failures.getFirst()), String.valueOf(failures.getFirst()));
        assertEquals(1, achievementRows(member), "교착으로 끝난 쪽은 제출까지 통째로 되돌아간다");
    }

    /** 성과 행은 앱이 지울 수 없으므로 근거가 어긋난 호출은 아무것도 남기지 않고 막는다. */
    @Test
    void 인정_근거가_회원과_신호에_맞지_않으면_아무것도_남기지_않고_거절한다() {
        long candidate = candidate(HOME);
        long other = candidate(HOME);
        long submission = submit(member, candidate);
        long someone = insertMember();
        open(someone, HOME);
        long othersSubmission = submit(someone, candidate);
        long analysis = publish(member, candidate, submission);
        long otherSubmission = submit(member, other);
        long otherAnalysis = publish(member, other, otherSubmission);

        assertThrows(IllegalArgumentException.class, () -> inTx(
                () -> achievements.recognize(member, candidate, CONFIRMED, othersSubmission, null)), "남의 제출");
        assertThrows(IllegalArgumentException.class, () -> inTx(
                () -> achievements.recognize(member, other, CONFIRMED, submission, null)), "다른 신호를 매칭한 제출");
        assertThrows(IllegalArgumentException.class, () -> inTx(
                () -> achievements.recognize(member, candidate, UNCONFIRMED, submission, null)), "공개 근거 없는 미확정");
        assertThrows(IllegalArgumentException.class, () -> inTx(
                () -> achievements.recognize(member, candidate, CONFIRMED, submission, analysis)), "공개 근거 있는 확정");
        assertThrows(IllegalArgumentException.class, () -> inTx(
                () -> achievements.recognize(member, candidate, UNCONFIRMED, submission, otherAnalysis)),
                "다른 신호의 공개");

        long far = ORDINARY[0];
        long farCandidate = candidate(far);
        long farSubmission = submit(member, farCandidate);
        assertThrows(IllegalStateException.class, () -> inTx(
                () -> achievements.recognize(member, farCandidate, CONFIRMED, farSubmission, null)), "발견하지 않은 별");

        assertEquals(0, achievementRows(member));
        assertEquals(2, unlockCount(member));
    }

    /** 앱 계정은 소유자가 아니다. 실제 권한(V5·V6·V11)만으로 인정 경로가 끝까지 도는지 본다. */
    @Test
    void 앱_역할_권한만으로_성과를_인정하고_별을_열_수_있다() {
        long candidate = candidate(HOME);
        long submission = submit(member, candidate);

        Recognition result = inTx(() -> {
            jdbc.execute("SET LOCAL ROLE planetory_app");
            return achievements.recognize(member, candidate, CONFIRMED, submission, null);
        });

        assertTrue(result.newlyRecognized());
        assertEquals(1, result.unlockedStars().size());
    }

    @Test
    void 호출자_트랜잭션_밖에서는_부를_수_없다() {
        long candidate = candidate(HOME);
        long submission = submit(member, candidate);

        assertThrows(IllegalTransactionStateException.class,
                () -> achievements.recognize(member, candidate, CONFIRMED, submission, null));
    }

    // ---------- 9.1 성과 조회 ----------

    @Test
    void 요약은_회원_전체_값이고_ticId_필터는_목록에만_적용한다() {
        recognize(member, candidate(HOME), CONFIRMED);
        recognize(member, candidate(HOME), FP);
        recognize(member, candidate(HOME_2), UNCONFIRMED);
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'completed', completion_reason = 'all_found',"
                + " completed_at = now() WHERE user_id = ? AND tic_id = ?", member, HOME);

        AchievementList list = achievements.list(member, String.valueOf(HOME_2), null, null);

        assertEquals(List.of(String.valueOf(HOME_2)), list.items().stream().map(AchievementItem::ticId).toList());
        var summary = list.summary();
        assertEquals(2 + 3, summary.discoveredStarCount());
        assertEquals(2, summary.startedStarCount());
        assertEquals(stars.list(member, member, "submitted", null, 100, null).items().size(),
                summary.startedStarCount(), "4.4절 제출한 별 목록의 길이와 같다");
        assertEquals(1, summary.completedStarCount());
        assertEquals(3, summary.recognizedTotal());
        assertEquals(Map.of("confirmed", 1L, "unconfirmed", 1L, "fp", 1L), summary.byType());
        assertEquals(Map.of("A", 1L, "S", 1L, "SS", 0L, "SSS", 0L), summary.gradeDistribution());
    }

    @Test
    void 성과_항목은_접두_식별자와_인정_근거_열린_별과_라벨_갱신_표식을_싣는다() {
        long candidate = candidate(HOME_2);
        long submission = submit(member, candidate);
        long analysis = publish(member, candidate, submission);
        useStarsPerAchievement(2);
        Recognition result = inTx(() -> achievements.recognize(member, candidate, UNCONFIRMED, submission, analysis));
        long confirmed = candidate(HOME);
        recognize(member, confirmed, CONFIRMED);
        jdbc.update("UPDATE user_candidate_achievements SET relabeled_at = now(), relabel_disposition = 'pc'"
                + " WHERE id = ?", result.achievementId());

        AchievementItem item = achievements.list(member, String.valueOf(HOME_2), null, null).items().getFirst();

        assertEquals("ach-" + result.achievementId(), item.achievementId());
        assertEquals("c-" + candidate, item.candidateId());
        assertEquals("unconfirmed", item.type());
        assertEquals("sub-" + submission, item.recognizedSubmissionId());
        assertEquals("pa-" + analysis, item.recognizedAnalysisId());
        assertEquals(tics(result.unlockedStars()).stream().map(String::valueOf).toList(),
                item.unlockedStars().stream().map(AchievementViews.UnlockedStar::ticId).toList(), "성과 순번 순서");
        assertEquals("UNCONFIRMED", item.relabel().newDisposition());
        assertNotNull(item.relabel().relabeledAt());

        AchievementItem plain = achievements.list(member, String.valueOf(HOME), null, null).items().getFirst();
        assertNull(plain.recognizedAnalysisId());
        assertNull(plain.relabel());
    }

    /** 한 트랜잭션에서 인정된 성과는 시각이 같다. 커서가 id까지 담아야 경계에서 빠지거나 겹치지 않는다. */
    @Test
    void 목록은_인정_시각_내림차순이고_동률은_id로_가르며_커서로_빠짐없이_이어_읽는다() {
        List<Long> candidates = List.of(candidate(HOME), candidate(HOME), candidate(HOME));
        List<Long> submissions = candidates.stream().map(c -> submit(member, c)).toList();
        List<Long> ids = inTx(() -> IntStream.range(0, 3)
                .mapToObj(i -> achievements.recognize(member, candidates.get(i), CONFIRMED, submissions.get(i), null)
                        .achievementId())
                .toList());

        AchievementList first = achievements.list(member, null, "2", null);
        AchievementList second = achievements.list(member, null, "2", first.nextCursor());

        assertTrue(first.hasNext());
        assertFalse(second.hasNext());
        assertNull(second.nextCursor());
        List<String> read = new ArrayList<>(first.items().stream().map(AchievementItem::achievementId).toList());
        read.addAll(second.items().stream().map(AchievementItem::achievementId).toList());
        assertEquals(ids.stream().sorted((a, b) -> Long.compare(b, a)).map(id -> "ach-" + id).toList(), read);
    }

    @Test
    void 계약_밖_size_ticId와_다른_조건의_커서는_400이다() {
        for (int i = 0; i < 3; i++) {
            recognize(member, candidate(HOME), CONFIRMED);
        }
        String cursor = achievements.list(member, null, "2", null).nextCursor();
        String filtered = achievements.list(member, String.valueOf(HOME), "2", null).nextCursor();
        long someone = insertMember();

        for (String size : new String[] {"0", "101", "abc", ""}) {
            assertValidationFailed(() -> achievements.list(member, null, size, null), "size=" + size);
        }
        for (String tic : new String[] {"0123", "abc", "-1", ""}) {
            assertValidationFailed(() -> achievements.list(member, tic, null, null), "ticId=" + tic);
        }
        assertValidationFailed(() -> achievements.list(member, null, "3", cursor), "다른 size");
        assertValidationFailed(() -> achievements.list(member, null, "2", filtered), "다른 ticId 필터");
        assertValidationFailed(() -> achievements.list(someone, null, "2", cursor), "다른 회원");
        assertValidationFailed(() -> achievements.list(member, null, "2", "not-a-cursor"), "깨진 커서");
        assertEquals(1, achievements.list(member, null, "2", cursor).items().size());
    }

    @Test
    void 성과가_없는_회원도_빈_목록과_0으로_채운_요약을_받는다() {
        AchievementList list = achievements.list(member, null, null, null);

        assertEquals(List.of(), list.items());
        assertFalse(list.hasNext());
        assertEquals(0, list.summary().recognizedTotal());
        assertEquals(Map.of("A", 0L, "S", 0L, "SS", 0L, "SSS", 0L), list.summary().gradeDistribution());
        assertEquals(2, list.summary().discoveredStarCount());
        assertEquals(0, list.summary().startedStarCount());
    }

    // ---------- 도우미 ----------

    private Recognition recognize(long someone, long candidate, AchievementType type) {
        long submission = submit(someone, candidate);
        Long analysis = type == UNCONFIRMED ? publish(someone, candidate, submission) : null;
        return inTx(() -> achievements.recognize(someone, candidate, type, submission, analysis));
    }

    private <T> T inTx(Supplier<T> work) {
        return new TransactionTemplate(transactionManager).execute(status -> work.get());
    }

    private <T> List<T> concurrently(int threads, Supplier<T> work) throws Exception {
        return concurrently(IntStream.range(0, threads).<Supplier<T>>mapToObj(i -> work).toList());
    }

    private <T> List<T> concurrently(List<Supplier<T>> calls) throws Exception {
        List<T> values = new ArrayList<>();
        for (Outcome<T> outcome : outcomes(calls)) {
            if (outcome.error() != null) {
                throw new AssertionError("동시 호출이 실패했다", outcome.error());
            }
            values.add(outcome.value());
        }
        return values;
    }

    /** 동시 호출 하나의 결과. 실패했으면 {@code error}가 있다. */
    private record Outcome<T>(T value, Throwable error) {
    }

    /** 모든 호출을 한꺼번에 출발시키고 성공·실패를 함께 모은다. */
    private <T> List<Outcome<T>> outcomes(List<Supplier<T>> calls) throws Exception {
        var start = new CountDownLatch(1);
        List<Outcome<T>> results = new ArrayList<>();
        try (var executor = Executors.newFixedThreadPool(calls.size())) {
            List<Future<T>> tasks = new ArrayList<>();
            for (Supplier<T> call : calls) {
                tasks.add(executor.submit(() -> {
                    start.await(10, TimeUnit.SECONDS);
                    return call.get();
                }));
            }
            start.countDown();
            for (Future<T> task : tasks) {
                try {
                    results.add(new Outcome<>(task.get(30, TimeUnit.SECONDS), null));
                } catch (ExecutionException failed) {
                    results.add(new Outcome<>(null, failed.getCause()));
                }
            }
        }
        return results;
    }

    /** 실제 호출자가 근거 기록을 저장하기 전에 하는 회원 잠금(9.2절). */
    private void lockMember(long someone) {
        jdbc.queryForObject("SELECT id FROM users WHERE id = ? FOR UPDATE", Long.class, someone);
    }

    private static void await(CyclicBarrier barrier) {
        try {
            barrier.await(10, TimeUnit.SECONDS);
        } catch (Exception e) {
            throw new IllegalStateException("다른 트랜잭션을 기다리지 못했다", e);
        }
    }

    private static String sqlState(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SQLException sql) {
                return sql.getSQLState();
            }
        }
        return null;
    }

    private static void assertValidationFailed(Runnable call, String message) {
        BusinessException e = assertThrows(BusinessException.class, call::run, message);
        assertEquals(ErrorCode.VALIDATION_FAILED, e.getErrorCode(), message);
    }

    /** 경로는 이 테스트와 무관하다. 성과를 낼 별을 먼저 열어 둘 뿐이다. */
    private void open(long someone, long tic) {
        inTx(() -> discovery.discover(someone, tic, Reason.TUTORIAL));
    }

    /** 발견 수만 바꾼 새 규칙 버전을 지금 적용한다. 규칙 행은 지울 수 없어 버전을 쌓는다(V9). */
    private void useStarsPerAchievement(int count) {
        jdbc.update("""
                INSERT INTO operation_settings(rule_version, "values", applied_at, note)
                SELECT ?, jsonb_set("values", '{discovery,stars_per_achievement}', to_jsonb(?::int)), now(), 'test'
                  FROM operation_settings WHERE rule_version = 'rule-0'
                """, "rule-test-" + UUID.randomUUID(), count);
    }

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private void insertStar(long tic, String status) {
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, ?)", tic, status);
    }

    private void insertRound(int roundNo, String status, long target) {
        jdbc.update("INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id, description, status)"
                + " VALUES (?, DATE '2026-09-14', DATE '2026-09-21', ?, '두 번째 신호 찾기', ?)", roundNo, target, status);
    }

    private void insertBundle(long tic) {
        jdbc.update("INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest,"
                        + " fold_reference_time_btjd, base_days) VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4)",
                tic, "v-" + UUID.randomUUID(), MANIFEST);
    }

    private long candidate(long tic) {
        return jdbc.queryForObject("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step,"
                        + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,"
                        + " discoverable, is_confirmed)"
                        + " SELECT ?, 'active', id, 1, 3.0, 1501.0, 2.4, 900, 12.5, '{}'::jsonb, true, true"
                        + "   FROM publication_bundles WHERE tic_id = ? AND status = 'current' RETURNING id",
                Long.class, tic, tic);
    }

    /** 신호를 매칭한 제출. 인정 근거로 쓴다. */
    private long submit(long someone, long candidate) {
        return jdbc.queryForObject("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " SELECT ?, c.tic_id, c.updated_bundle_id, ?::uuid, 'candidate', 0, '{}', 3.0, 0.1, 0.2,"
                        + "        1500.5, 'LIKELY_PLANET', '[]'::jsonb, 'matched', c.id, 'recognized',"
                        + "        'rm-1', 'pg-1', 'rule-0'"
                        + "   FROM candidates c WHERE c.id = ? RETURNING id",
                Long.class, someone, UUID.randomUUID().toString(), candidate);
    }

    /** 신호의 공식 스레드에 제출의 히스토리를 공개한다. 미확정 성과의 인정 근거다. */
    private long publish(long someone, long candidate, long submission) {
        long post = jdbc.queryForObject("INSERT INTO posts(kind, candidate_id, board, tic_id, title, body, status)"
                        + " SELECT 'system_thread', c.id, 'star', c.tic_id, 'thread', 'thread', 'visible'"
                        + "   FROM candidates c WHERE c.id = ? RETURNING id",
                Long.class, candidate);
        long history = jdbc.queryForObject("INSERT INTO analysis_histories(submission_id, user_id, tic_id,"
                        + " snapshot_params, versions) SELECT id, user_id, tic_id, '{}'::jsonb, '{}'::jsonb"
                        + "   FROM submissions WHERE id = ? RETURNING id",
                Long.class, submission);
        return jdbc.queryForObject("INSERT INTO published_analyses(post_id, user_id, candidate_id, history_id,"
                + " published_at) VALUES (?, ?, ?, ?, now()) RETURNING id", Long.class, post, someone, candidate, history);
    }

    private static List<Long> tics(List<DiscoveredStar> unlocked) {
        return unlocked.stream().map(DiscoveredStar::ticId).toList();
    }

    private Map<String, Object> unlockRow(long someone, long tic) {
        return jdbc.queryForMap("SELECT unlock_reason, trigger_tic_id, trigger_achievement_id, seq,"
                + " world_x::float8 AS x, world_y::float8 AS y, depth_z::float8 AS z, layout_version"
                + " FROM star_unlocks WHERE user_id = ? AND tic_id = ?", someone, tic);
    }

    private long unlockCount(long someone) {
        return jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ?", Long.class, someone);
    }

    private long distinctOrdinals(long someone) {
        return jdbc.queryForObject("SELECT count(DISTINCT layout_ordinal) FROM star_unlocks WHERE user_id = ?",
                Long.class, someone);
    }

    private long achievementRows(long someone) {
        return jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements WHERE user_id = ?",
                Long.class, someone);
    }

    private int achievementCount(long someone, long tic) {
        return jdbc.queryForObject("SELECT achievement_count FROM user_star_progress WHERE user_id = ? AND tic_id = ?",
                Integer.class, someone, tic);
    }

    private boolean fpSuccess(long someone, long tic) {
        return jdbc.queryForObject("SELECT fp_success FROM user_star_progress WHERE user_id = ? AND tic_id = ?",
                Boolean.class, someone, tic);
    }

    private long revision(long someone) {
        return jdbc.queryForObject("SELECT COALESCE((SELECT revision FROM member_sky_revisions WHERE user_id = ?), 0)",
                Long.class, someone);
    }
}
