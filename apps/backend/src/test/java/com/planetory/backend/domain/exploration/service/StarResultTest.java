package com.planetory.backend.domain.exploration.service;

import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.when;

/**
 * 별 결과 페이지 (탐사 API 8.4절, RES-10, AT-74) [S15P21C206-146].
 *
 * <p>실제 제출을 만들어 조회한다. 외부 잔차 공급자만 대체하고 매칭·성과·진행은 실제로 돈다.
 *
 * <p>고정하려는 것 셋이다. (1) "탐색 완료 / 미게시 분석 있음"이 공존한다. (2) 신호 수와 제출 수가
 * 구분되고 마지막 오판과 재개가 함께 보인다. (3) 매칭하지 못한 후보는 어디에도 나오지 않는다.
 */
@Testcontainers
@ActiveProfiles("local")
@SpringBootTest
class StarResultTest {

    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>("postgres:18.6-alpine");

    @DynamicPropertySource static void database(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", DB::getJdbcUrl);
        r.add("spring.datasource.username", DB::getUsername);
        r.add("spring.datasource.password", DB::getPassword);
    }

    @Autowired StarResultService results;
    @Autowired SubmissionService submissions;
    @Autowired com.planetory.backend.domain.post.service.PublicAnalysisService publications;
    @Autowired com.planetory.backend.domain.post.service.PublicAnalysisBatchService batch;
    @Autowired ExplorationCompletionRepository completion;
    @Autowired JdbcTemplate jdbc;
    @Autowired GalaxyLayout layout;
    @MockitoBean ResidualResultReader residuals;

    long member, stranger, tic, bundle;
    /** graded = 채점형(확정), analysis = 미확정, hidden = 회원이 끝내 맞히지 못한 후보 */
    long graded, analysis, hidden;

    @BeforeEach
    void seed() {
        when(residuals.lookup(anyLong(), any())).thenReturn(ResidualResultReader.Lookup.none());
        member = member();
        stranger = member();
        tic = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000) + 1;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status) VALUES (?,1,'published')", tic);
        unlock(member);

        Float[] flux = new Float[4320];
        Arrays.fill(flux, 1f);
        long segment = jdbc.queryForObject("INSERT INTO light_curve_segments(tic_id,sector,binning_revision,"
                        + "start_btjd,bin_minutes,n_points,flux,gaps) VALUES (?,1,'10m-v1',100,10,?,?,'[]')"
                        + " RETURNING id", Long.class, tic, flux.length, flux);
        String manifest = """
                {"segment_ids":[%d],"array_checksums":{},"residual_model_version":"rm-1",
                "periodogram_config_version":"pg-1","binning":{"minutes":10},"period_grid":{"spacing":"log"},
                "fine_tune":{"half_width_cells":3},"curve_steps":{}}
                """.formatted(segment);
        bundle = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,"
                        + "fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,100,30) RETURNING id",
                Long.class, tic, "result-" + UUID.randomUUID(), manifest);
        jdbc.update("INSERT INTO periodograms(bundle_id,period_min_days,period_max_days,n_periods,power)"
                + " VALUES (?,0.5,20,3,?)", bundle, new Float[] {1f, 2f, 1f});

        graded = candidate(3, "confirmed", "graded", "planet");
        analysis = candidate(5, "pc", "analysis", null);
        hidden = candidate(11, "pc", "analysis", null);
    }

    // ---------- 완료 조건 (3) 미매칭 후보 비노출 ----------

    /**
     * 회원이 맞히지 못한 후보는 <b>어떤 필드에도</b> 나오지 않는다(DEC-28). 신호 목록만 거르고
     * 스레드 목록이나 제거 후보에 남으면, 세어 보는 것만으로 남은 후보 수가 드러난다.
     */
    @Test
    void 매칭하지_못한_후보는_어디에도_나오지_않는다() {
        submit(3, "LIKELY_PLANET");
        submit(9, "UNSURE"); // 어느 후보와도 맞지 않는다
        thread(hidden);      // 맞히지 못한 신호에도 공식 스레드는 있을 수 있다
        thread(graded);

        var result = results.result(member, tic);

        String forbidden = ExplorationIds.candidate(hidden);
        assertTrue(result.signals().stream().noneMatch(s -> s.candidateId().equals(forbidden)));
        assertFalse(result.progress().matchedCandidateIds().contains(forbidden));
        assertFalse(result.curveSteps().stream().anyMatch(s -> s.removedCandidateIds().contains(forbidden)));
        assertEquals(List.of("st-" + threadId(graded)), result.links().threadIds(),
                "맞힌 신호의 스레드만 준다. 별의 스레드를 다 담으면 못 맞힌 후보가 드러난다");
        // 미매칭 제출은 남지만 무엇을 놓쳤는지는 말하지 않는다.
        assertEquals(1, result.unmatchedSubmissions().size());
        assertEquals("not_matched", result.unmatchedSubmissions().getFirst().matchResult());
    }

    /** 남은 탐색 가능 수는 세어 주되 <b>어떤 신호인지는</b> 주지 않는다. */
    @Test
    void 남은_탐색_가능_수는_완료_판정과_같은_집계다() {
        submit(3, "LIKELY_PLANET");

        var result = results.result(member, tic);

        assertEquals(completion.countCandidates(member, tic).discoverableUnmatched(),
                result.progress().remainingDiscoverableCount(),
                "따로 세면 「완료인데 남은 신호가 있다」처럼 화면이 자기 모순에 빠진다");
        assertEquals(2, result.progress().remainingDiscoverableCount(), "analysis·hidden 둘이 남았다");
    }

    // ---------- 완료 조건 (1) 완료와 미게시의 공존 ----------

    /** 탐색을 끝내도 공개하지 않은 신호는 남을 수 있다. 둘은 서로를 지우지 않는다(RES-10). */
    @Test
    void 탐색_완료와_미게시_분석이_함께_선다() {
        submit(3, "LIKELY_PLANET");
        submit(5, "LIKELY_PLANET"); // 미확정 신호. 공개해야 성과가 된다
        complete();

        var result = results.result(member, tic);

        assertEquals("completed", result.progress().stage());
        assertEquals("all_found", result.progress().completionReason());
        assertEquals(2, result.unpublishedSignalCount(), "완료여도 공개하지 않은 신호는 그대로 센다");
        assertEquals(List.of("PUBLISH_ALL", "LATER", "RETRY"), result.nextActions(),
                "끝난 뒤에만 [모두 게시]를 권한다(RES-08)");
    }

    /** 진행 중에는 [모두 게시]를 권하지 않는다. 개별 [분석 공개]가 그 일을 한다(RES-08). */
    @Test
    void 진행_중에는_모두_게시를_권하지_않는다() {
        submit(5, "LIKELY_PLANET");

        var result = results.result(member, tic);

        assertEquals("in_progress", result.progress().stage());
        assertTrue(result.unpublishedSignalCount() > 0);
        assertEquals(List.of("RETRY"), result.nextActions());
    }

    // ---------- 완료 조건 (2) 신호 수 ≠ 제출 수, 마지막 오판과 재개 ----------

    /**
     * 같은 신호를 두 번 제출하면 <b>신호는 하나, 제출은 둘</b>이다. 제출 수로 신호를 세면 화면이
     * 찾은 신호 수를 부풀린다.
     */
    @Test
    void 같은_신호를_다시_제출해도_신호는_하나다() {
        String first = submit(3, "LIKELY_PLANET");
        String second = submit(3, "UNLIKELY_PLANET");

        var result = results.result(member, tic);

        assertEquals(1, result.signals().size(), "신호 하나");
        var signal = result.signals().getFirst();
        assertEquals(List.of(first, second), signal.submissionIds(), "제출 둘. 오래된 것부터다");
        assertEquals(second, signal.latestSubmissionId());
        assertEquals(1, result.achievement().count());
        assertEquals("A", result.achievement().grade());
    }

    /**
     * 마지막 제출이 오판이어도 이미 인정된 성과는 그대로다(GRD-06). 둘이 한 화면에 같이 보여야
     * 한다 — 성과만 보여 주면 방금 틀린 것이 사라지고, 오판만 보여 주면 등급이 사라진다.
     */
    @Test
    void 마지막_오판과_재개가_성과와_함께_보인다() {
        submit(3, "LIKELY_PLANET");   // 맞고 인정
        submit(3, "UNLIKELY_PLANET"); // 다시 풀어 틀림
        complete();
        jdbc.update("UPDATE user_star_progress SET reopen_pending=true WHERE user_id=? AND tic_id=?", member, tic);

        var result = results.result(member, tic);
        var signal = result.signals().getFirst();

        assertEquals("DISAGREES", signal.judgmentEvaluation(), "마지막 제출의 당시 판정이다");
        assertNotNull(signal.achievement().recognizedAt(), "성과는 회수하지 않는다");
        assertEquals(1, result.achievement().count());
        assertTrue(result.progress().reopenPending(), "재개 대기도 같은 응답에 있다");
        assertEquals("completed", result.progress().stage());
    }

    // ---------- 응답의 나머지 계약 ----------

    /** 조회는 아무것도 바꾸지 않는다. 상세 열람도 진행도 잔차 작업도 만들지 않는다(D-14). */
    @Test
    void 조회는_아무것도_바꾸지_않는다() {
        submit(3, "LIKELY_PLANET");
        String before = state();

        results.result(member, tic);
        results.result(member, tic);

        assertEquals(before, state(), "결과를 보는 것만으로 건너뛰기 조건이 채워지면 안 된다");
    }

    /** 곡선 단계는 회원이 실제로 제출한 단계다. 원본은 DB 행이 곧 결과라 늘 완료다. */
    @Test
    void 곡선_단계는_제출한_단계이고_원본은_완료다() {
        submit(3, "LIKELY_PLANET");

        var steps = results.result(member, tic).curveSteps();

        assertEquals(1, steps.size());
        assertEquals(0, steps.getFirst().curveStep());
        assertEquals(List.of(), steps.getFirst().removedCandidateIds(),
                "제거가 없어도 키를 빼지 않는다. 빠지면 「제거 없음」과 「필드 누락」을 구분할 수 없다");
        assertEquals("COMPLETED", steps.getFirst().residual().status());
    }

    /** 미확정 신호의 통계는 공개 분포, 채점형은 첫 매칭 일치율이다. 한 카드에 섞지 않는다(8.4절). */
    @Test
    void 신호마다_현재_판정에_맞는_통계_하나만_준다() {
        submit(3, "LIKELY_PLANET");
        submit(5, "LIKELY_PLANET");

        var result = results.result(member, tic);
        var byId = result.signals().stream().collect(java.util.stream.Collectors.toMap(
                StarResultViews.Signal::candidateId, s -> (java.util.Map<?, ?>) s.judgmentStatistics()));

        var gradedStats = byId.get(ExplorationIds.candidate(graded));
        assertEquals("graded", gradedStats.get("kind"));
        assertFalse(gradedStats.containsKey("participantCount"), "두 통계를 섞지 않는다");

        var analysisStats = byId.get(ExplorationIds.candidate(analysis));
        assertEquals("public_analyses", analysisStats.get("kind"));
        assertEquals(0L, analysisStats.get("participantCount"), "아직 공개한 사람이 없다");
        assertNull(analysisStats.get("percentages"), "0명은 0%가 아니다");
    }

    /** 제출한 적 없는 별과 없는 별은 같은 404다. 가르면 TIC 존재 여부가 드러난다. */
    @Test
    void 제출_이력이_없으면_404다() {
        submit(3, "LIKELY_PLANET");

        assertEquals(ErrorCode.RESOURCE_NOT_FOUND, assertThrows(BusinessException.class,
                () -> results.result(stranger, tic)).getErrorCode(), "남의 제출로 열리지 않는다");
        assertEquals(ErrorCode.RESOURCE_NOT_FOUND, assertThrows(BusinessException.class,
                () -> results.result(member, 999_999_999L)).getErrorCode());
    }

    // ---------- !157 리뷰: 유효 공개 조건·일괄 공개 후보·은퇴 대상 ----------

    /**
     * 공개 기록의 취소·숨김만 보면 부모 스레드가 숨겨진 뒤 <b>한 응답이 두 말을 한다.</b> 신호
     * 카드는 {@code HIDDEN}인데 미게시 수는 0이 된다.
     */
    @Test
    void 부모_스레드가_숨겨지면_다시_미게시로_센다() {
        var published = publications.publish(member, historyOf(submitBody(5, "LIKELY_PLANET")));
        assertEquals(0, results.result(member, tic).unpublishedSignalCount(),
                "유효하게 공개된 신호는 세지 않는다");

        // 운영이 부모 스레드를 숨기면 그 공개는 더 이상 유효 공개가 아니다.
        jdbc.update("UPDATE posts SET status='hidden' WHERE id=?",
                Long.parseLong(published.threadId().substring(3)));

        var result = results.result(member, tic);
        assertEquals("HIDDEN", result.signals().getFirst().publication().state());
        assertEquals(1, result.unpublishedSignalCount(),
                "카드가 HIDDEN인데 수가 0이면 같은 응답이 서로 다른 말을 한다");
    }

    /**
     * 미게시 <b>신호</b> 수와 <b>일괄 공개 후보</b>는 다른 값이다. 같은 신호의 첫 기록을 공개한 뒤 새
     * 적격 기록을 제출하면 신호 수는 0이지만 공개할 기록은 남아 있다.
     */
    @Test
    void 공개한_신호에_새_기록이_있으면_모두_게시를_권한다() {
        publications.publish(member, historyOf(submitBody(5, "LIKELY_PLANET")));
        submit(5, "UNSURE"); // 같은 신호의 새 적격 기록
        complete();

        var result = results.result(member, tic);

        assertEquals(0, result.unpublishedSignalCount(), "신호 기준으로는 이미 공개했다");
        assertTrue(result.nextActions().contains("PUBLISH_ALL"), "그래도 공개할 기록이 남아 있다");
        // 버튼과 목록이 다른 말을 하지 않도록 166 후보 목록과 함께 묶는다.
        MultiValueMap<String, String> params = new LinkedMultiValueMap<>();
        params.add("ticId", String.valueOf(tic));
        assertEquals(1, batch.candidates(member, params).items().size());
    }

    /** 누르면 409 `CANDIDATE_RETIRED`가 될 행동을 힌트로 주지 않는다(6.8절). */
    @Test
    void 은퇴한_후보는_다시_풀기를_권하지_않는다() {
        submit(3, "LIKELY_PLANET");
        assertTrue(results.result(member, tic).nextActions().contains("RETRY"));

        jdbc.update("UPDATE candidates SET status='retired' WHERE id=?", graded);

        assertFalse(results.result(member, tic).nextActions().contains("RETRY"),
                "다시 풀기 초안이 거절할 대상인데 계속 권하면 화면이 막다른 길로 안내한다");
    }

    // ---------- 도구 ----------

    private static String historyOf(tools.jackson.databind.JsonNode body) {
        return body.path("historyId").asText();
    }

    private String state() {
        return jdbc.queryForObject("SELECT (SELECT count(*) FILTER (WHERE answer_viewed) FROM submissions"
                        + " WHERE user_id=? AND tic_id=?)::text"
                        + " || (SELECT row_to_json(p)::text FROM user_star_progress p"
                        + " WHERE p.user_id=? AND p.tic_id=?)",
                String.class, member, tic, member, tic);
    }

    /** 완료 판정을 실제 규칙으로 돌린다. 임의로 열을 바꾸면 완료 사유가 규칙과 어긋난다. */
    private void complete() {
        jdbc.update("UPDATE candidates SET discoverable=false WHERE id=?", hidden);
        jdbc.update("UPDATE user_star_progress SET progress_stage='completed',completion_reason='all_found',"
                + "completed_at=now() WHERE user_id=? AND tic_id=?", member, tic);
    }

    private long threadId(long candidateId) {
        return jdbc.queryForObject("SELECT id FROM posts WHERE candidate_id=? AND kind='system_thread'",
                Long.class, candidateId);
    }

    private void thread(long candidateId) {
        jdbc.update("INSERT INTO posts(kind,candidate_id,board,tic_id,title,body,status,created_at,updated_at)"
                        + " VALUES ('system_thread',?,'star',?,'신호 스레드','요약','visible',now(),now())",
                candidateId, tic);
    }

    private long candidate(double period, String disposition, String answerClass, String truth) {
        long id = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,"
                        + "period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,"
                        + "is_confirmed) VALUES (?,'active',?,1,?,100.3,2.4,1000,10,'{}',true,?) RETURNING id",
                Long.class, tic, bundle, period, "confirmed".equals(disposition));
        jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,answer_class,planet_truth,"
                        + "rule_version,applied_at,source_refs) VALUES (?,?,?,?,'rule-0',now(),'[]')",
                id, disposition, answerClass, truth);
        return id;
    }

    private String submit(double period, String judgment) {
        return submitBody(period, judgment).path("submissionId").asText();
    }

    private tools.jackson.databind.JsonNode submitBody(double period, String judgment) {
        var request = new SubmissionRequest(UUID.randomUUID().toString(), "candidate",
                new SubmissionRequest.Context("b-" + bundle, 0, List.of(), "rm-1", "pg-1"),
                new SubmissionRequest.Selection(period, null, .25 / period, .35 / period), judgment,
                List.of("ushape"), "결과 메모",
                new SubmissionRequest.ViewState(new SubmissionRequest.Viewport(1.0, 10.0), 2.0), null);
        return submissions.submit(member, tic, request).body();
    }

    private long member() {
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname) VALUES ('test',?,?)"
                + " RETURNING id", Long.class, UUID.randomUUID().toString(), UUID.randomUUID().toString());
    }

    private void unlock(long id) {
        var p = layout.place(0);
        jdbc.update("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,world_x,world_y,"
                        + "layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,0)",
                id, tic, p.depthZ(), p.worldX(), p.worldY(), p.layoutVersion());
    }
}
