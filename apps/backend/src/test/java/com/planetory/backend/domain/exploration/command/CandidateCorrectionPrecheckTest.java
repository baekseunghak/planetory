package com.planetory.backend.domain.exploration.command;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.PlanetoryApplication;
import com.planetory.backend.domain.exploration.command.CorrectionViews.CandidateImpact;
import com.planetory.backend.domain.exploration.command.CorrectionViews.Kind;
import com.planetory.backend.domain.exploration.command.CorrectionViews.Precheck;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 후보 정정 영향 사전검사 [S15P21C206-154].
 *
 * <p>계약(docs/architecture/candidate-correction-contract.md) 3.4의 사전 거절과 5.2의 건수를
 * 고정 fixture로 검증한다. 적용·복구 경로는 계약 4장이 승인되기 전까지 만들지 않으므로 여기 없다.
 */
@ActiveProfiles("local")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = PlanetoryApplication.COMMAND_PROPERTY + "="
                + CandidateCorrectionPrecheckCommand.NAME)
class CandidateCorrectionPrecheckTest {

    private static final String SCHEMA =
            "correction_precheck_" + UUID.randomUUID().toString().replace("-", "");

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

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

    @Autowired CandidateCorrectionPrecheck precheck;
    @Autowired CandidateCorrectionPrecheckCommand command;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    private long ticId;
    private long bundleId;

    @BeforeEach
    void reset() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        ticId = star();
        bundleId = bundle(ticId);
    }

    // ---------- 5.2 건수 ----------

    /** 계약 5.2절이 세라고 한 것을 후보마다 하나씩 만들어 전부 세는지 본다. */
    @Test
    void 계약_5_2의_건수를_후보마다_센다() {
        long kept = candidate();
        long merged = candidate();
        long member = member();

        long achievement = recognize(member, kept, submit(member, kept));
        unlockBy(member, achievement, 0);
        // 스레드를 먼저 만든다. 공개는 그 스레드에 붙는다(후보당 스레드 하나, 계약 S2).
        thread(kept);
        publish(member, kept, submit(member, kept));
        submit(member, merged);

        Precheck result = precheck.check(Kind.MERGE, List.of(kept, merged), kept);

        CandidateImpact keptImpact = impact(result, kept);
        assertEquals(1, keptImpact.achievements());
        assertEquals(1, keptImpact.unlockedStars(), "그 성과가 연 별");
        assertEquals(1, keptImpact.publishedAnalyses());
        assertEquals(1, keptImpact.activePublishedAnalyses());
        assertEquals(1, keptImpact.officialThreads());
        assertEquals(2, keptImpact.submissions(), "성과 제출과 공개용 제출");
        assertEquals(ticId, keptImpact.ticId());
        assertEquals("active", keptImpact.status());

        CandidateImpact mergedImpact = impact(result, merged);
        assertEquals(0, mergedImpact.achievements());
        assertEquals(1, mergedImpact.submissions());
        assertFalse(mergedImpact.touchesMembers(), "제출만 있으면 회원 쪽 승인 대상이 아니다");
    }

    /** 취소·숨김된 공개는 전체 건수에는 들어가고 유효 건수에서는 빠진다. */
    @Test
    void 공개_분석은_유효한_것과_전체를_따로_센다() {
        long candidate = candidate();
        long member = member();
        long visible = publish(member, candidate, submit(member, candidate));
        long cancelled = publish(member(), candidate, submit(member(), candidate));
        jdbc.update("UPDATE published_analyses SET unpublished_at = now() WHERE id = ?", cancelled);
        assertNotEquals(visible, cancelled);

        CandidateImpact impact = impact(precheck.check(Kind.SPLIT, List.of(candidate), null), candidate);

        assertEquals(2, impact.publishedAnalyses());
        assertEquals(1, impact.activePublishedAnalyses());
    }

    // ---------- S2·S3: 합칠 수 없는 것 ----------

    /** 계약 S3. 양쪽에 성과가 있는 회원은 어떤 결정을 해도 한 후보로 모을 수 없다. */
    @Test
    void 양쪽에_성과를_가진_회원을_세고_S3을_알린다() {
        long kept = candidate();
        long merged = candidate();
        long both = member();
        recognize(both, kept, submit(both, kept));
        recognize(both, merged, submit(both, merged));
        long onlyOne = member();
        recognize(onlyOne, kept, submit(onlyOne, kept));

        Precheck result = precheck.check(Kind.MERGE, List.of(kept, merged), kept);

        assertEquals(1, result.conflictingMembers(), "양쪽에 성과가 있는 회원만 센다");
        assertTrue(result.approvals().stream().anyMatch(reason -> reason.contains("S3")), result.approvals().toString());
        assertFalse(result.rejected(), "병합 자체는 거절하지 않는다. Gold 쪽은 보존으로 진행할 수 있다");
    }

    /** 계약 S2. 후보당 공식 스레드가 하나라 두 스레드를 한 후보로 모을 수 없다. */
    @Test
    void 스레드가_둘이면_합칠_수_없다고_알린다() {
        long kept = candidate();
        long merged = candidate();
        thread(kept);
        thread(merged);

        Precheck result = precheck.check(Kind.MERGE, List.of(kept, merged), kept);

        assertTrue(result.approvals().stream().anyMatch(reason -> reason.contains("S2")), result.approvals().toString());
        assertTrue(result.needsMemberApproval());
    }

    // ---------- 3.4 분리의 사전 거절 ----------

    /** 계약 3.4. 성과가 있으면 어느 산물로 옮겨도 임의 결정이므로 막는다. */
    @Test
    void 분리는_회원_데이터가_걸려_있으면_사전_거절한다() {
        long withAchievement = candidate();
        long member = member();
        recognize(member, withAchievement, submit(member, withAchievement));

        Precheck result = precheck.check(Kind.SPLIT, List.of(withAchievement), null);

        assertTrue(result.rejected());
        assertTrue(result.rejections().getFirst().contains("3.4"), result.rejections().toString());
        assertEquals(REJECTED, exitCodeOf("split", String.valueOf(withAchievement), null));
    }

    /** 공개 분석만 있어도, 공식 스레드만 있어도 막는다. 셋 중 하나면 충분하다. */
    @Test
    void 공개_분석이나_스레드만_있어도_분리를_거절한다() {
        long onlyPublished = candidate();
        long member = member();
        publish(member, onlyPublished, submit(member, onlyPublished));
        assertTrue(precheck.check(Kind.SPLIT, List.of(onlyPublished), null).rejected(), "공개 분석");

        long onlyThread = candidate();
        thread(onlyThread);
        assertTrue(precheck.check(Kind.SPLIT, List.of(onlyThread), null).rejected(), "공식 스레드");
    }

    /** 참조가 없으면 분리는 정정이 아니라 새 판 적재의 일반 경로다(계약 3.4). */
    @Test
    void 참조가_없는_분리는_통과한다() {
        long free = candidate();

        Precheck result = precheck.check(Kind.SPLIT, List.of(free), null);

        assertFalse(result.rejected(), result.rejections().toString());
        assertFalse(result.needsMemberApproval(), result.approvals().toString());
        assertEquals(0, exitCodeOf("split", String.valueOf(free), null));
    }

    /** 제출만 남은 후보는 분리할 수 있다. 제출은 어떤 정정에서도 옮기지 않기 때문이다(계약 3.1). */
    @Test
    void 제출만_있는_후보는_분리를_막지_않는다() {
        long candidate = candidate();
        submit(member(), candidate);

        Precheck result = precheck.check(Kind.SPLIT, List.of(candidate), null);

        assertFalse(result.rejected(), result.rejections().toString());
        assertEquals(1, impact(result, candidate).submissions());
    }

    // ---------- 잘못 고른 대상 ----------

    @Test
    void 없는_후보와_다른_별의_후보는_거절한다() {
        long here = candidate();
        long elsewhere = candidateOn(star());

        Precheck missing = precheck.check(Kind.MERGE, List.of(here, 9_999_999L), here);
        assertTrue(missing.rejections().stream().anyMatch(r -> r.contains("없는 후보")), missing.rejections().toString());

        Precheck crossStar = precheck.check(Kind.MERGE, List.of(here, elsewhere), here);
        assertTrue(crossStar.rejections().stream().anyMatch(r -> r.contains("다른 별")), crossStar.rejections().toString());
    }

    @Test
    void 병합은_대상_둘과_대표_지정을_요구한다() {
        long one = candidate();
        long two = candidate();

        assertTrue(precheck.check(Kind.MERGE, List.of(one), one).rejections()
                .stream().anyMatch(r -> r.contains("둘 이상")));
        assertTrue(precheck.check(Kind.MERGE, List.of(one, two), null).rejections()
                .stream().anyMatch(r -> r.contains("대표로 남길")));
        assertTrue(precheck.check(Kind.MERGE, List.of(one, two), 9_999_999L).rejections()
                .stream().anyMatch(r -> r.contains("병합 대상에 없습니다")));
    }

    // ---------- 명령 인자와 종료 코드 ----------

    @Test
    void 인자를_읽을_수_없으면_64로_끝난다() {
        long candidate = candidate();
        assertEquals(INVALID, run("--planetory.correction.candidates=" + candidate), "종류 없음");
        assertEquals(INVALID, run("--planetory.correction.kind=rename",
                "--planetory.correction.candidates=" + candidate), "없는 종류");
        assertEquals(INVALID, run("--planetory.correction.kind=merge"), "대상 없음");
        assertEquals(INVALID, run("--planetory.correction.kind=merge",
                "--planetory.correction.candidates=abc"), "숫자가 아님");
        assertEquals(INVALID, run("--planetory.correction.kind=merge",
                "--planetory.correction.candidates=1,1"), "중복 id");
        assertEquals(INVALID, run("--planetory.correction.kind=merge",
                "--planetory.correction.kind=split",
                "--planetory.correction.candidates=" + candidate), "같은 인자를 두 번");
    }

    /** 목록의 빈 항목은 조용히 보정하지 않는다. 준 것과 센 것이 달라지기 때문이다 [154 리뷰]. */
    @Test
    void 후보_목록의_빈_항목은_64로_거절한다() {
        long one = candidate();
        long two = candidate();
        for (String candidates : List.of(one + ",," + two, "," + one, one + ",", ",", "")) {
            assertEquals(INVALID, run("--planetory.correction.kind=merge",
                    "--planetory.correction.candidates=" + candidates), "'" + candidates + "'");
        }
        // 정상 입력은 그대로 통과한다. 공백만 있는 구분은 허용한다.
        assertEquals(0, run("--planetory.correction.kind=merge",
                "--planetory.correction.candidates=" + one + ", " + two,
                "--planetory.correction.keep=" + one));
    }

    /**
     * 제출만 있는 후보는 <b>0</b>이다. 계약 3.1이 제출을 어떤 정정에서도 옮기지 않는다고 정했고
     * (HIS-06·SUB-05), 5.2의 승인 문턱은 그래서 나머지 다섯이다 [154 리뷰].
     */
    @Test
    void 제출만_있는_후보는_승인_문턱이_아니다() {
        long kept = candidate();
        long merged = candidate();
        submit(member(), merged);

        Precheck result = precheck.check(Kind.MERGE, List.of(kept, merged), kept);

        assertEquals(1, impact(result, merged).submissions());
        assertFalse(result.needsMemberApproval(), result.approvals().toString());
        assertEquals(0, exitCodeOf("merge", kept + "," + merged, kept));
    }

    /** 회원 데이터가 걸려 있으면 3, 없으면 0이다. 자동화가 이 값으로 다음 단계를 가른다. */
    @Test
    void 회원_영향_여부로_종료_코드를_가른다() {
        long kept = candidate();
        long merged = candidate();
        assertEquals(0, exitCodeOf("merge", kept + "," + merged, kept), "걸린 것이 없다");

        recognize(member(), merged, submit(member(), merged));
        assertEquals(NEEDS_APPROVAL, exitCodeOf("merge", kept + "," + merged, kept));
    }

    /** 대표 후보는 정확히 하나다. 둘을 주면 앞의 것을 조용히 고르지 않는다 [154 리뷰]. */
    @Test
    void 대표_후보를_둘_주면_거절한다() {
        long kept = candidate();
        long merged = candidate();

        assertEquals(INVALID, run("--planetory.correction.kind=merge",
                "--planetory.correction.candidates=" + kept + "," + merged,
                "--planetory.correction.keep=" + kept + "," + merged));
        assertEquals(INVALID, run("--planetory.correction.kind=merge",
                "--planetory.correction.candidates=" + kept + "," + merged,
                "--planetory.correction.keep="), "빈 값도 거절한다");
    }

    /** 은퇴한 후보를 대표로 삼으면 병합 결과가 처음부터 은퇴 상태가 된다 [154 리뷰]. */
    @Test
    void 은퇴한_후보는_병합_대표가_될_수_없다() {
        long kept = candidate();
        long merged = candidate();
        jdbc.update("UPDATE candidates SET status = 'retired' WHERE id = ?", kept);

        Precheck asKeep = precheck.check(Kind.MERGE, List.of(kept, merged), kept);
        assertTrue(asKeep.rejected());
        assertTrue(asKeep.rejections().stream().anyMatch(r -> r.contains("retired")), asKeep.rejections().toString());

        // 은퇴한 쪽이 대표가 아니면 조회는 그대로 된다. 영향 집계까지 막지는 않는다.
        Precheck asMerged = precheck.check(Kind.MERGE, List.of(kept, merged), merged);
        assertFalse(asMerged.rejected(), asMerged.rejections().toString());
        assertEquals("retired", impact(asMerged, kept).status());
    }

    /**
     * 사전검사가 자기 트랜잭션에 <b>REPEATABLE_READ를 선언하는지</b>. 이것이 없으면 아래 두
     * 대조 검사가 보여주는 차이가 실제 실행에 그대로 나타난다 [154 리뷰].
     *
     * <p>아래 두 검사는 바깥 트랜잭션을 직접 만들어 격리 수준의 효과를 보여준다. 사전검사는
     * {@code REQUIRED}라 바깥 트랜잭션에 참여하고, 참여할 때 스프링은 메서드의 격리 수준 속성을
     * 무시한다. 그래서 선언 자체는 이 검사가 따로 지킨다.
     */
    @Test
    void 사전검사는_한_스냅샷_격리를_선언한다() throws Exception {
        Transactional declared = CandidateCorrectionPrecheck.class
                .getMethod("check", Kind.class, List.class, Long.class)
                .getAnnotation(Transactional.class);

        assertNotNull(declared, "트랜잭션 밖이면 질의마다 스냅샷이 달라진다");
        assertTrue(declared.readOnly());
        assertEquals(Isolation.REPEATABLE_READ, declared.isolation());
    }

    /** 선언한 격리 수준에서 조회 사이의 커밋이 보이지 않는다. 위 선언이 무엇을 사는지 보여준다. */
    @Test
    void 조회_사이에_성과가_등록돼도_같은_스냅샷을_본다() {
        long kept = candidate();
        long merged = candidate();

        Precheck[] seen = snapshotAround(TransactionDefinition.ISOLATION_REPEATABLE_READ, kept, merged);

        assertEquals(seen[0], seen[1], "한 실행 안에서 건수가 달라지면 앞뒤가 안 맞는 보고가 나간다");
        assertEquals(0, seen[1].conflictingMembers());
        assertEquals(0, impact(seen[1], kept).achievements());
    }

    /** 대조군. 기본 격리 수준이면 같은 자리에서 값이 달라진다 — 그래서 격리 수준을 올려야 한다. */
    @Test
    void 기본_격리_수준이면_같은_자리에서_값이_달라진다() {
        long kept = candidate();
        long merged = candidate();

        Precheck[] seen = snapshotAround(TransactionDefinition.ISOLATION_READ_COMMITTED, kept, merged);

        assertNotEquals(seen[0], seen[1], "이 차이가 REPEATABLE_READ를 거는 이유다");
    }

    /**
     * 주어진 격리 수준의 트랜잭션 안에서 사전검사를 두 번 부르고, 그 사이에 <b>다른 연결</b>이
     * 성과를 커밋한다. 같은 연결에서 넣으면 자기 변경이라 격리 수준과 무관하게 보인다.
     */
    private Precheck[] snapshotAround(int isolation, long kept, long merged) {
        TransactionTemplate outer = new TransactionTemplate(transactionManager);
        outer.setIsolationLevel(isolation);
        outer.setReadOnly(true);
        return outer.execute(status -> {
            Precheck before = precheck.check(Kind.MERGE, List.of(kept, merged), kept);
            commitFromAnotherConnection(kept, merged);
            return new Precheck[] {before, precheck.check(Kind.MERGE, List.of(kept, merged), kept)};
        });
    }

    /** 별도 스레드 = 별도 연결 = 별도 트랜잭션. 끝날 때까지 기다린 뒤 두 번째 조회로 넘어간다. */
    private void commitFromAnotherConnection(long kept, long merged) {
        Thread writer = new Thread(() -> {
            long member = member();
            recognize(member, kept, submit(member, kept));
            recognize(member, merged, submit(member, merged));
        });
        writer.start();
        try {
            writer.join(30_000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
        assertFalse(writer.isAlive(), "다른 연결의 커밋이 끝나야 두 번째 조회가 의미 있다");
    }

    // ---------- 완료 조건: 재실행과 무변경 ----------

    /** 같은 정정을 다시 검사해도 결과가 같다. 읽기만 하므로 순서나 횟수에 기대지 않는다. */
    @Test
    void 재실행해도_같은_결과다() {
        long kept = candidate();
        long merged = candidate();
        long member = member();
        recognize(member, kept, submit(member, kept));
        thread(merged);

        Precheck first = precheck.check(Kind.MERGE, List.of(kept, merged), kept);
        Precheck second = precheck.check(Kind.MERGE, List.of(kept, merged), kept);

        assertEquals(first, second);
        assertEquals(NEEDS_APPROVAL, exitCodeOf("merge", kept + "," + merged, kept));
        assertEquals(NEEDS_APPROVAL, exitCodeOf("merge", kept + "," + merged, kept));
    }

    /**
     * 사전검사는 <b>아무것도 바꾸지 않는다.</b> 계약 6장이 "할 수 없는 것"으로 적은 회원 데이터
     * 변경과 후보 행 삭제가 실수로도 일어나지 않는지, 관련 테이블 전체 행 수로 확인한다.
     */
    @Test
    void 사전검사는_아무것도_바꾸지_않는다() {
        long kept = candidate();
        long merged = candidate();
        long member = member();
        long achievement = recognize(member, kept, submit(member, kept));
        unlockBy(member, achievement, 0);
        thread(kept);
        publish(member, kept, submit(member, kept));
        thread(merged);

        Map<String, Integer> before = rowCounts();
        precheck.check(Kind.MERGE, List.of(kept, merged), kept);
        exitCodeOf("merge", kept + "," + merged, kept);
        exitCodeOf("split", String.valueOf(kept), null);

        assertEquals(before, rowCounts());
        assertEquals("active", jdbc.queryForObject(
                "SELECT status FROM candidates WHERE id = ?", String.class, merged),
                "은퇴 전환도 사전검사가 하지 않는다");
    }

    private Map<String, Integer> rowCounts() {
        return List.of("candidates", "candidate_status_history", "user_candidate_achievements",
                        "star_unlocks", "published_analyses", "posts", "submissions", "analysis_histories")
                .stream()
                .collect(java.util.stream.Collectors.toMap(table -> table,
                        table -> jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class)));
    }

    // ---------- fixture ----------

    private static final int REJECTED = CandidateCorrectionPrecheckCommand.REJECTED;
    private static final int NEEDS_APPROVAL = CandidateCorrectionPrecheckCommand.NEEDS_MEMBER_APPROVAL;
    private static final int INVALID = CandidateCorrectionPrecheckCommand.INVALID_ARGUMENTS;

    private int exitCodeOf(String kind, String candidates, Long keep) {
        return keep == null
                ? run("--planetory.correction.kind=" + kind, "--planetory.correction.candidates=" + candidates)
                : run("--planetory.correction.kind=" + kind, "--planetory.correction.candidates=" + candidates,
                        "--planetory.correction.keep=" + keep);
    }

    private int run(String... args) {
        command.run(new DefaultApplicationArguments(args));
        return command.getExitCode();
    }

    private static CandidateImpact impact(Precheck result, long candidateId) {
        return result.impacts().stream().filter(i -> i.candidateId() == candidateId).findFirst().orElseThrow();
    }

    private long star() {
        long tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", tic);
        return tic;
    }

    private long bundle(long tic) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, tic, "v-" + UUID.randomUUID(), MANIFEST);
    }

    private long candidate() {
        return insertCandidate(ticId, bundleId);
    }

    private long candidateOn(long otherTic) {
        return insertCandidate(otherTic, bundle(otherTic));
    }

    private long insertCandidate(long tic, long bundle) {
        return jdbc.queryForObject("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, 3.0, 1501.0, 2.8, 900, 12.5, '{}'::jsonb, true, true)"
                + " RETURNING id", Long.class, tic, bundle);
    }

    private long member() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long submit(long member, long candidateId) {
        long tic = jdbc.queryForObject("SELECT tic_id FROM candidates WHERE id = ?", Long.class, candidateId);
        long bundle = jdbc.queryForObject("SELECT id FROM publication_bundles WHERE tic_id = ?"
                + " ORDER BY id LIMIT 1", Long.class, tic);
        return jdbc.queryForObject("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id,"
                        + " submission_kind, curve_step, removed_candidate_ids, submitted_period, phase_start,"
                        + " phase_end, fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version, created_at)"
                        + " VALUES (?, ?, ?, ?::uuid, 'candidate', 0, '{}', 3.0, 0.1, 0.2, 1500.5,"
                        + " 'LIKELY_PLANET', '[]'::jsonb, 'matched', ?, 'recognized', 'rm-1', 'pg-1',"
                        + " 'rule-0', now()) RETURNING id",
                Long.class, member, tic, bundle, UUID.randomUUID().toString(), candidateId);
    }

    private long recognize(long member, long candidateId, long submissionId) {
        return jdbc.queryForObject("INSERT INTO user_candidate_achievements(user_id, candidate_id,"
                        + " achievement_type, recognized_submission_id, recognized_at)"
                        + " VALUES (?, ?, 'confirmed', ?, now()) RETURNING id",
                Long.class, member, candidateId, submissionId);
    }

    /** 성과가 연 별. 계약 S4가 이 행을 지우지 못하게 막는다. */
    private void unlockBy(long member, long achievementId, int ordinal) {
        long opened = star();
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, trigger_achievement_id,"
                        + " seq, generation, angle_deg, radius_jitter, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'achievement', ?, 0, 1, 0, 0, 0, now(), 1, 1, 'test-1', ?)",
                member, opened, achievementId, ordinal);
    }

    private long thread(long candidateId) {
        long tic = jdbc.queryForObject("SELECT tic_id FROM candidates WHERE id = ?", Long.class, candidateId);
        return jdbc.queryForObject("INSERT INTO posts(kind, candidate_id, board, tic_id, title, body, status)"
                        + " VALUES ('system_thread', ?, 'star', ?, '신호 요약', '본문', 'visible') RETURNING id",
                Long.class, candidateId, tic);
    }

    private long publish(long member, long candidateId, long submissionId) {
        long tic = jdbc.queryForObject("SELECT tic_id FROM candidates WHERE id = ?", Long.class, candidateId);
        Long existing = jdbc.query("SELECT id FROM posts WHERE candidate_id = ? AND kind = 'system_thread'",
                rs -> rs.next() ? rs.getLong(1) : null, candidateId);
        long postId = existing != null ? existing : thread(candidateId);
        long historyId = jdbc.queryForObject("INSERT INTO analysis_histories(submission_id, user_id, tic_id,"
                        + " snapshot_params, versions) VALUES (?, ?, ?, '{}'::jsonb, '{}'::jsonb) RETURNING id",
                Long.class, submissionId, member, tic);
        return jdbc.queryForObject("INSERT INTO published_analyses(post_id, user_id, candidate_id,"
                        + " history_id, published_at) VALUES (?, ?, ?, ?, now()) RETURNING id",
                Long.class, postId, member, candidateId, historyId);
    }
}
