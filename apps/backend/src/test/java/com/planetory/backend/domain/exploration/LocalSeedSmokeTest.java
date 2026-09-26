package com.planetory.backend.domain.exploration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService;
import com.planetory.backend.domain.member.entity.Member;
import com.planetory.backend.domain.member.service.MemberService;

/**
 * 로컬 시드(experiments/distributed-pipeline/local-seed)가 실제 백엔드 경로로 동작하는지 본다 [S15P21C206-256].
 *
 * <p>Flyway가 만든 격리 스키마에 시드를 적재하고, 운영과 같은 가입 경로로 회원을 만든 뒤 튜토리얼 다섯 별의
 * 정답을 원본 곡선(curveStep=0)에서 제출해 챌린지 별이 열리는지까지 확인한다. 이어서 모든 공개 별의 원본 곡선
 * 조회와 실제 곡선 예제(TOI-270)의 정답 제출을 본다. 잔차 Worker 없이 되는 범위다.
 *
 * <p>uv가 필요해 기본 빌드에서는 돌지 않는다. {@code LOCAL_SEED_SMOKE=1}로 켠다.
 */
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
@EnabledIfEnvironmentVariable(named = "LOCAL_SEED_SMOKE", matches = "1")
class LocalSeedSmokeTest {

    private static final String SCHEMA = "local_seed_" + UUID.randomUUID().toString().replace("-", "");
    private static final Path SEED_DIR = Path.of("../../experiments/distributed-pipeline/local-seed")
            .toAbsolutePath().normalize();

    @DynamicPropertySource
    static void isolatedSchema(DynamicPropertyRegistry registry) {
        registry.add("spring.flyway.schemas", () -> SCHEMA);
        registry.add("spring.flyway.default-schema", () -> SCHEMA);
        registry.add("spring.datasource.hikari.schema", () -> SCHEMA);
    }

    /** 컨텍스트가 뜨며 Flyway가 스키마를 만든 뒤에 시드를 넣는다. */
    @BeforeAll
    static void seed(@Autowired Environment env) throws IOException, InterruptedException {
        URI jdbc = URI.create(env.getRequiredProperty("spring.datasource.url").substring("jdbc:".length()));
        // Windows에서 localhost는 ::1을 먼저 시도해 psycopg 접속이 늦어진다.
        String host = "localhost".equals(jdbc.getHost()) ? "127.0.0.1" : jdbc.getHost();
        String url = "postgresql://" + enc(env.getRequiredProperty("spring.datasource.username")) + ":"
                + enc(env.getProperty("spring.datasource.password", "")) + "@" + host + ":" + jdbc.getPort()
                + jdbc.getPath();
        Path log = Files.createTempFile("local-seed-", ".log");
        ProcessBuilder builder = new ProcessBuilder("uv", "run", "python", "-m", "local_seed", "seed",
                "--database-url", url, "--schema", SCHEMA)
                .directory(SEED_DIR.toFile()).redirectErrorStream(true).redirectOutput(log.toFile());
        // 파일로 돌린 출력은 OS 기본 인코딩(Windows cp949)이 되므로 UTF-8로 고정한다.
        builder.environment().put("PYTHONIOENCODING", "utf-8");
        Process process = builder.start();
        boolean finished = process.waitFor(10, TimeUnit.MINUTES);
        String output = Files.readString(log, StandardCharsets.UTF_8);
        System.out.println(output);
        assertTrue(finished && process.exitValue() == 0, "시드 적재 실패:\n" + output);
    }

    @AfterAll
    static void dropOnlyThisTestSchema(@Autowired DataSource dataSource) {
        new JdbcTemplate(dataSource).execute("DROP SCHEMA " + SCHEMA + " CASCADE");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired MemberService members;
    @Autowired AuthSessionService sessions;
    @Autowired StarDiscoveryService discovery;
    @Autowired PlatformTransactionManager transactions;

    @Test
    void 가입하면_튜토리얼_1번이_열리고_다섯_튜토리얼을_정답으로_끝내면_챌린지_별이_열린다() throws Exception {
        Member member = members.login("google", "local-seed-smoke-" + UUID.randomUUID());
        long first = jdbc.queryForObject("SELECT tic_id FROM tutorial_stars WHERE seq = 1", Long.class);
        assertEquals(List.of(first), jdbc.queryForList(
                "SELECT tic_id FROM star_unlocks WHERE user_id = ?", Long.class, member.getId()));
        MockHttpSession session = loginSession(member);

        for (int seq = 1; seq <= 5; seq++) {
            long tic = jdbc.queryForObject("SELECT tic_id FROM tutorial_stars WHERE seq = ?", Long.class, seq);
            assertTrue(unlocked(member, tic), "튜토리얼 " + seq + " 별이 열려 있어야 한다");
            solve(member, session, tic);
        }

        long challenge = jdbc.queryForObject("SELECT target_tic_id FROM challenge_rounds WHERE status = 'active'",
                Long.class);
        assertTrue(unlocked(member, challenge), "튜토리얼 다섯 개를 끝내면 챌린지 별이 열려야 한다");
        mvc.perform(get("/api/v1/challenges/current").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.eligible").value(true));

        // 성과로 열리지 않은 별까지 발견 경로로 모두 열어 원본 곡선 조회를 본다(테스트에서만 연다).
        // 봉우리는 정답표와 대조할 수 있게 남긴다. 실제 곡선 예제(TOI-270)는 정답 제출까지 해 본다.
        for (long tic : jdbc.queryForList("SELECT tic_id FROM stars WHERE service_status = 'published' ORDER BY tic_id",
                Long.class)) {
            new TransactionTemplate(transactions).executeWithoutResult(
                    tx -> discovery.discover(member.getId(), tic, StarDiscoveryService.Reason.CHALLENGE));
            System.out.println("봉우리 " + tic + ": " + readAnalysis(session, tic));
        }
        solve(member, session, jdbc.queryForObject(
                "SELECT tic_id FROM publication_bundles WHERE manifest->'local_seed'->>'label' = 'TOI-270'", Long.class));
    }

    /**
     * 실제 모양의 Gold(시드 manifest의 {@code period_*} 키, {@code pg-log5000-v1})로 잔차 1단계가 실제 Worker에서
     * 계산되는지 본다 [S15P21C206-88]. {@code DERIVED_COMPUTE_URL}에 Worker가 떠 있어야 하며 없으면 건너뛴다.
     *
     * <p>봉우리 제출은 V4 제약으로 막혀 있어(S15P21C206-262 인계) 원본 곡선의 후보 제출로 매칭을 만든다.
     */
    @Test
    void 매칭한_후보를_빼면_실제_Worker가_잔차_곡선과_주기도를_계산한다() throws Exception {
        assumeTrue(System.getenv("DERIVED_COMPUTE_URL") != null, "DERIVED_COMPUTE_URL이 없어 건너뜁니다");
        Member member = members.login("google", "residual-worker-smoke-" + UUID.randomUUID());
        MockHttpSession session = loginSession(member);
        long tic = jdbc.queryForObject(
                "SELECT tic_id FROM publication_bundles WHERE manifest->'local_seed'->>'label' = 'TOI-270'", Long.class);
        new TransactionTemplate(transactions).executeWithoutResult(
                tx -> discovery.discover(member.getId(), tic, StarDiscoveryService.Reason.CHALLENGE));
        solve(member, session, tic);

        Map<String, Object> bundle = currentBundle(tic);
        long removed = jdbc.queryForObject("SELECT id FROM candidates WHERE tic_id = ? AND status = 'active'"
                + " AND discoverable ORDER BY removal_step, id LIMIT 1", Long.class, tic);
        String target = """
                {"target": {"bundleId": "b-%s", "removedCandidateIds": ["c-%d"],
                            "residualModelVersion": "%s", "periodogramConfigVersion": "%s"}}
                """.formatted(bundle.get("id"), removed, bundle.get("rm"), bundle.get("pg"));
        String accepted = mvc.perform(post("/api/v1/stars/" + tic + "/residual-jobs").session(session)
                        .with(csrf()).contentType(MediaType.APPLICATION_JSON).content(target))
                .andExpect(status().isAccepted()).andReturn().getResponse().getContentAsString();
        String jobId = com.jayway.jsonpath.JsonPath.read(accepted, "$.jobId");

        String job = null;
        for (long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(150); System.nanoTime() < deadline; ) {
            job = mvc.perform(get("/api/v1/residual-jobs/" + jobId).session(session))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
            String state = com.jayway.jsonpath.JsonPath.read(job, "$.status");
            if ("COMPLETED".equals(state) || "FAILED".equals(state)) {
                break;
            }
            Thread.sleep(500);
        }
        System.out.println("잔차 작업 " + jobId + ": " + job);
        assertEquals("COMPLETED", com.jayway.jsonpath.JsonPath.read(job, "$.status"), job);

        String step = "bundleId=b-" + bundle.get("id") + "&curveStep=1&removed=c-" + removed
                + "&residualModelVersion=" + bundle.get("rm") + "&periodogramConfigVersion=" + bundle.get("pg");
        mvc.perform(get("/api/v1/stars/" + tic + "/curves?" + step).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.residual.status").value("COMPLETED"))
                .andExpect(jsonPath("$.segments.length()").isNumber());
        mvc.perform(get("/api/v1/stars/" + tic + "/periodogram?" + step).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nPeriods").value(5000))
                .andExpect(jsonPath("$.power.length()").value(5000));
        String peaks = mvc.perform(get("/api/v1/stars/" + tic + "/candidate-peaks?" + step).session(session))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        System.out.println("잔차 봉우리 " + tic + ": " + peaks);
    }

    /** 원본 곡선(curveStep=0)의 분석 진입·곡선·주기도·봉우리를 읽고 봉우리 응답을 돌려준다. */
    private String readAnalysis(MockHttpSession session, long tic) throws Exception {
        String context = contextQuery(currentBundle(tic));
        mvc.perform(get("/api/v1/stars/" + tic + "/analysis-context").session(session))
                .andExpect(status().isOk());
        mvc.perform(get("/api/v1/stars/" + tic + "/curves?" + context).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.segments.length()").isNumber());
        mvc.perform(get("/api/v1/stars/" + tic + "/periodogram?" + context).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nPeriods").value(5000));
        return mvc.perform(get("/api/v1/stars/" + tic + "/candidate-peaks?" + context).session(session))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
    }

    /** 발견 가능한 신호마다 정답을 원본 곡선에서 제출하고 별이 완료되는지 본다. */
    private void solve(Member member, MockHttpSession session, long tic) throws Exception {
        readAnalysis(session, tic);
        Map<String, Object> bundle = currentBundle(tic);
        List<Map<String, Object>> answers = jdbc.queryForList("""
                SELECT c.period_days::float8 AS period, c.epoch_btjd::float8 AS epoch,
                       c.duration_hours::float8 AS duration, d.planet_truth
                  FROM candidates c JOIN candidate_dispositions d ON d.candidate_id = c.id
                 WHERE c.tic_id = ? AND c.status = 'active' AND c.discoverable ORDER BY c.removal_step
                """, tic);
        for (Map<String, Object> answer : answers) {
            String judgment = "planet".equals(answer.get("planet_truth")) ? "LIKELY_PLANET" : "UNLIKELY_PLANET";
            String body = submission("b-" + bundle.get("id"), (String) bundle.get("rm"), (String) bundle.get("pg"),
                    (double) bundle.get("fold_reference_time_btjd"), (double) answer.get("period"),
                    (double) answer.get("epoch"), (double) answer.get("duration"), judgment);
            mvc.perform(post("/api/v1/stars/" + tic + "/submissions").session(session)
                            .with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isCreated())
                    .andExpect(jsonPath("$.match.status").value("matched"));
        }
        assertEquals("completed", jdbc.queryForObject(
                "SELECT progress_stage FROM user_star_progress WHERE user_id = ? AND tic_id = ?", String.class,
                member.getId(), tic));
    }

    private Map<String, Object> currentBundle(long tic) {
        return jdbc.queryForMap("SELECT id, fold_reference_time_btjd, manifest->>'residual_model_version' AS rm,"
                + " manifest->>'periodogram_config_version' AS pg"
                + " FROM publication_bundles WHERE tic_id = ? AND status = 'current'", tic);
    }

    private static String contextQuery(Map<String, Object> bundle) {
        return "bundleId=b-" + bundle.get("id") + "&curveStep=0&residualModelVersion=" + bundle.get("rm")
                + "&periodogramConfigVersion=" + bundle.get("pg");
    }

    /** 첫 통과를 가운데 둔 위상 창. 폭은 지속시간의 1.2배다. */
    private static String submission(String bundleId, String residualModel, String periodogramConfig,
                                     double reference, double period, double epoch, double durationHours,
                                     String judgment) {
        double center = (((epoch - reference) / period) % 1 + 1) % 1;
        double half = 0.6 * durationHours / 24 / period;
        double start = center - half < 0 ? center - half + 1 : center - half;
        return """
                {"requestId": "%s", "submissionKind": "candidate",
                 "curveContext": {"bundleId": "%s", "curveStep": 0, "removedCandidateIds": [],
                                  "residualModelVersion": "%s", "periodogramConfigVersion": "%s"},
                 "selection": {"periodDays": %s, "phaseStart": %s, "phaseEnd": %s},
                 "userJudgment": "%s", "evidenceChecks": []}
                """.formatted(UUID.randomUUID(), bundleId, residualModel, periodogramConfig, period, start,
                start + 2 * half, judgment);
    }

    private boolean unlocked(Member member, long tic) {
        return jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM star_unlocks WHERE user_id = ? AND tic_id = ?)",
                Boolean.class, member.getId(), tic);
    }

    /** 운영과 같은 로그인 경로로 세션을 만든다(StarPathHttpTest와 같은 방식). */
    private MockHttpSession loginSession(Member member) {
        var request = new MockHttpServletRequest();
        var response = new MockHttpServletResponse();
        sessions.login(member, request, response);
        SecurityContextHolder.clearContext();
        return (MockHttpSession) request.getSession(false);
    }

    private static String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
