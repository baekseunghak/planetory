package com.planetory.backend.domain.exploration;

import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.UUID;
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
import tools.jackson.databind.ObjectMapper;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService;
import com.planetory.backend.domain.exploration.service.InitialExplorationService;
import com.planetory.backend.domain.exploration.service.QuestService;
import com.planetory.backend.domain.exploration.service.QuestViews.Challenge;
import com.planetory.backend.domain.exploration.service.QuestViews.Quests;
import com.planetory.backend.domain.exploration.service.QuestViews.Reopened;
import com.planetory.backend.domain.exploration.service.QuestViews.TutorialItem;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews.Marker;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyStar;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.TutorialProgressService;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 퀘스트 패널 계약 [S15P21C206-139].
 *
 * <p>탐사 API 4.3절과 AT-57·61·89를 따른다. 실행마다 별도 스키마를 쓴다.
 */
@ActiveProfiles("local")
@SpringBootTest
class QuestPanelTest {

    private static final String SCHEMA =
            "quest_panel_" + UUID.randomUUID().toString().replace("-", "");

    private static final long[] TUTORIAL = {0, 9001, 9002, 9003, 9004, 9005};
    private static final String[] INTENTS = {null, "deep_confirmed", "shallow_confirmed", "fp", "deep_fp", "multi_fp"};
    private static final long CHALLENGE = 7001;

    /** Gold 판 manifest 필수 키(V3). 값은 이 테스트와 무관하다. */
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

    @Autowired QuestService quests;
    @Autowired TutorialProgressService progress;
    @Autowired InitialExplorationService initial;
    @Autowired ExplorationSummaryService summary;
    @Autowired SkyService sky;
    @Autowired StarService stars;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    private long bundleId;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        // operation_settings는 비우지 않는다. V9가 넣은 rule-0을 제출이 참조한다.
        jdbc.execute("TRUNCATE users, stars CASCADE");
        for (int seq = 1; seq <= 5; seq++) {
            insertStar(TUTORIAL[seq]);
            jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (?, ?, ?, true)",
                    seq, TUTORIAL[seq], INTENTS[seq]);
        }
        insertStar(CHALLENGE);
        bundleId = jdbc.queryForObject("INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest,"
                + " fold_reference_time_btjd, base_days) VALUES (?, 'v-1', 'current', ?::jsonb, 1500.5, 27.4)"
                + " RETURNING id", Long.class, CHALLENGE, MANIFEST);
    }

    // ---------- 튜토리얼 ----------

    /** 신규 회원은 1번만 열려 있고 2~5번은 잠겨 별을 드러내지 않는다(AT-57). 회차가 없으면 빈 챌린지다. */
    @Test
    void 신규_회원은_1번만_열리고_나머지_칸은_별을_드러내지_않는다() {
        long member = signUp();

        Quests panel = quests.quests(member);

        assertEquals(0, panel.tutorial().completedCount());
        List<TutorialItem> items = panel.tutorial().items();
        assertEquals(new TutorialItem(1, "deep_confirmed", "unlocked", String.valueOf(TUTORIAL[1]), null), items.get(0));
        for (int seq = 2; seq <= 5; seq++) {
            assertEquals(new TutorialItem(seq, INTENTS[seq], "locked", null, null), items.get(seq - 1));
        }
        assertEquals(new Challenge(null, false, null, false, null, null), panel.challenge());
        assertEquals(List.of(), panel.reopened());
    }

    /** 칸 상태는 발견과 진행 단계를 따른다. 완료 사유는 완료 칸에만 준다. */
    @Test
    void 튜토리얼_칸은_진행_단계와_완료_사유를_보여준다() {
        long member = signUp();
        complete(member, 1, "skipped");
        complete(member, 2, "all_found");
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'in_progress' WHERE user_id = ? AND tic_id = ?",
                member, TUTORIAL[3]);

        List<TutorialItem> items = quests.quests(member).tutorial().items();

        assertEquals("completed", items.get(0).status());
        assertEquals("skipped", items.get(0).completionReason());
        assertEquals("all_found", items.get(1).completionReason());
        assertEquals(new TutorialItem(3, "fp", "in_progress", String.valueOf(TUTORIAL[3]), null), items.get(2));
        assertEquals("locked", items.get(3).status());
        assertEquals(2, quests.quests(member).tutorial().completedCount());
    }

    /** 완료 수와 GET /me의 tutorialCompleted는 같은 판정이다(탐사 API 11.1절). */
    @Test
    void 완료_수와_내_정보의_튜토리얼_완료는_같은_기준이다() {
        long member = signUp();
        for (int seq = 1; seq <= 4; seq++) {
            complete(member, seq, "all_found");
        }
        assertEquals(4, quests.quests(member).tutorial().completedCount());
        assertFalse(summary.overview(member).tutorialCompleted());

        complete(member, 5, "undiscoverable_only");

        assertEquals(5, quests.quests(member).tutorial().completedCount());
        assertTrue(summary.overview(member).tutorialCompleted());
    }

    /** 완료한 튜토리얼 별이 재개돼도 칸·완료 수·tutorialCompleted는 완료로 남고 별은 다시 열린 별에 나온다. */
    @Test
    void 재개된_튜토리얼_별도_튜토리얼_완료는_유지되고_다시_열린_별에_나온다() {
        long member = signUp();
        for (int seq = 1; seq <= 5; seq++) {
            complete(member, seq, "all_found");
        }
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'in_progress', reopen_pending = false,"
                + " reopened_at = now() WHERE user_id = ? AND tic_id = ?", member, TUTORIAL[2]);

        Quests panel = quests.quests(member);

        assertEquals(5, panel.tutorial().completedCount());
        assertEquals(new TutorialItem(2, "shallow_confirmed", "completed", String.valueOf(TUTORIAL[2]), "all_found"),
                panel.tutorial().items().get(1));
        assertEquals(List.of(String.valueOf(TUTORIAL[2])), panel.reopened().stream().map(Reopened::ticId).toList());
        assertTrue(summary.overview(member).tutorialCompleted());
    }

    // ---------- 챌린지 ----------

    /** 자격과 열림은 따로 보여준다. 미완료 회원에게는 대상 별을 주지 않는다. */
    @Test
    void 튜토리얼을_끝내지_않은_회원은_자격이_없고_대상_별을_받지_않는다() {
        long round = insertRound("active");
        long member = signUp();

        Challenge challenge = quests.quests(member).challenge();

        assertEquals("cr-" + round, challenge.round().roundId());
        assertEquals(3, challenge.round().roundNo());
        assertEquals(LocalDate.parse("2026-09-14"), challenge.round().startsOn());
        assertEquals(LocalDate.parse("2026-09-21"), challenge.round().endsOn());
        assertEquals("얕은 별에서 두 번째 신호 찾기", challenge.round().description());
        assertFalse(challenge.eligible());
        assertNull(challenge.ticId());
        assertFalse(challenge.unlocked());
        assertNull(challenge.progressStage());
        assertEquals(0, challenge.participantCount());
    }

    /** 회차 진행 중 다섯 번째를 끝낸 회원에게는 열린 별과 진행 단계가 보인다(AT-89). */
    @Test
    void 다섯_번째를_끝내면_열린_챌린지_별과_진행_단계가_보인다() {
        insertRound("active");
        long member = signUp();
        for (int seq = 1; seq <= 5; seq++) {
            complete(member, seq, "all_found");
        }

        Challenge opened = quests.quests(member).challenge();
        assertTrue(opened.eligible());
        assertTrue(opened.unlocked());
        assertEquals(String.valueOf(CHALLENGE), opened.ticId());
        assertEquals("unexplored", opened.progressStage());

        jdbc.update("UPDATE user_star_progress SET progress_stage = 'in_progress' WHERE user_id = ? AND tic_id = ?",
                member, CHALLENGE);
        assertEquals("in_progress", quests.quests(member).challenge().progressStage());
    }

    /** 자격이 있어도 조회가 별을 열지 않는다. 열기는 회차 전환 명령과 튜토리얼 완료만 한다(9.4절). */
    @Test
    void 조회는_자격이_있어도_챌린지_별을_열지_않는다() {
        long member = signUp();
        for (int seq = 1; seq <= 5; seq++) {
            complete(member, seq, "all_found");
        }
        insertRound("active");   // 회차 전환 명령을 아직 실행하지 않았다
        long revision = revision(member);

        Challenge challenge = quests.quests(member).challenge();

        assertTrue(challenge.eligible());
        assertFalse(challenge.unlocked());
        assertNull(challenge.ticId());
        assertEquals(5, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ?",
                Integer.class, member));
        assertEquals(revision, revision(member));
    }

    /** 진행 회차만 보여준다. 끝난 회차에서 연 별은 남지만 카드에는 나오지 않는다(AT-61). */
    @Test
    void 회차가_끝나면_카드는_비고_연_별은_남는다() {
        long round = insertRound("active");
        long member = signUp();
        for (int seq = 1; seq <= 5; seq++) {
            complete(member, seq, "all_found");
        }
        jdbc.update("UPDATE challenge_rounds SET status = 'closed' WHERE id = ?", round);

        assertNull(quests.quests(member).challenge().round());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ? AND tic_id = ?",
                Integer.class, member, CHALLENGE));
    }

    /**
     * 참여 수는 대상 별의 모든 공식 신호 스레드에서 유효 공개 분석을 가진 회원을 한 번씩 센다(D-13).
     * 본인 취소·개별 숨김·숨긴 스레드의 공개는 빠진다.
     */
    @Test
    void 참여_수는_유효_공개_분석_회원을_별_단위로_한_번씩_센다() {
        insertRound("active");
        long visibleThread = insertThread(insertCandidate(), "visible");
        long otherThread = insertThread(insertCandidate(), "visible");
        long hiddenThread = insertThread(insertCandidate(), "hidden");

        long twoSignals = insertMember();
        publish(visibleThread, twoSignals, null, null);
        publish(otherThread, twoSignals, null, null);
        long valid = insertMember();
        publish(otherThread, valid, null, null);
        long unpublished = insertMember();
        publish(visibleThread, unpublished, "now()", null);
        long hidden = insertMember();
        publish(visibleThread, hidden, null, "now()");
        long underHiddenThread = insertMember();
        publish(hiddenThread, underHiddenThread, null, null);

        assertEquals(2, quests.quests(insertMember()).challenge().participantCount());
    }

    /**
     * 챌린지 빨간 느낌표의 원천은 퀘스트 응답뿐이다. 지도·상세·목록의 marker에는 튜토리얼 번호만 싣고
     * 발견 경로는 unlockReason이 따로 알린다. 회차가 끝나면 느낌표 대상도 사라진다(4.1·4.3절).
     */
    @Test
    void 챌린지_느낌표는_퀘스트_응답으로만_나가고_지도_표식에는_튜토리얼_번호만_있다() {
        long round = insertRound("active");
        long member = signUp();
        for (int seq = 1; seq <= 5; seq++) {
            complete(member, seq, "all_found");
        }
        assertEquals(String.valueOf(CHALLENGE), quests.quests(member).challenge().ticId());

        var meta = sky.meta(member, false);
        var bounds = meta.bounds();
        var tile = sky.tiles(member, 2, bounds.minX() - 1, bounds.minY() - 1,
                bounds.maxX() - bounds.minX() + 2, bounds.maxY() - bounds.minY() + 2, meta.version(), null, null);
        var markers = new HashMap<String, Marker>();
        for (SkyStar star : tile.stars()) {
            markers.put(star.ticId(), star.marker());
        }
        assertEquals(6, markers.size());
        assertNull(markers.get(String.valueOf(CHALLENGE)), "지도 타일");
        assertEquals(new Marker("tutorial", 1), markers.get(String.valueOf(TUTORIAL[1])));
        assertNull(stars.detail(member, CHALLENGE).marker(), "별 상세");
        var listed = stars.list(member, member, "discovered", null, null, null).items().stream()
                .filter(item -> item.ticId().equals(String.valueOf(CHALLENGE))).findFirst().orElseThrow();
        assertNull(listed.marker(), "내 별 목록");
        assertEquals("challenge", listed.unlockReason());

        jdbc.update("UPDATE challenge_rounds SET status = 'closed' WHERE id = ?", round);
        assertNull(quests.quests(member).challenge().ticId(), "끝난 회차에는 느낌표 대상이 없다");
    }

    // ---------- 다시 열린 별 ----------

    /** 재개 뒤 새 제출이 생기면 빠진다. 새로 찾을 수 있는 신호 수는 재개 이벤트 저장 전까지 null이다. */
    @Test
    void 다시_열린_별은_새_제출이_생기면_빠지고_신호_수는_null이다() {
        long member = signUp();
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, world_x, world_y, depth_z,"
                + " layout_version, layout_ordinal, unlocked_at) VALUES (?, ?, 'challenge', 1, 1, 0, 'v', 9, now())",
                member, CHALLENGE);
        jdbc.update("INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completed_at, reopened_at)"
                + " VALUES (?, ?, 'in_progress', now() - interval '2 day', now() - interval '1 day')",
                member, CHALLENGE);
        jdbc.update("UPDATE user_star_progress SET progress_stage = 'in_progress', completed_at = now() - interval '5 day',"
                + " reopened_at = now() - interval '3 day' WHERE user_id = ? AND tic_id = ?", member, TUTORIAL[1]);
        submitAt(member, CHALLENGE, "now() - interval '3 day'");   // 재개 전 제출은 카드를 지우지 않는다

        var reopened = quests.quests(member).reopened();
        assertEquals(List.of(String.valueOf(CHALLENGE), String.valueOf(TUTORIAL[1])),
                reopened.stream().map(item -> item.ticId()).toList(), "최근에 다시 열린 순서");
        assertNull(reopened.get(0).newDiscoverableCount());

        submitAt(member, CHALLENGE, "now()");

        assertEquals(List.of(String.valueOf(TUTORIAL[1])),
                quests.quests(member).reopened().stream().map(item -> item.ticId()).toList());
    }

    /** 빈 값은 필드를 빼지 않고 null로 내려간다. 날짜는 날짜 문자열이다. */
    @Test
    void 응답_JSON은_빈_값을_null로_두고_날짜는_문자열이다() {
        long member = signUp();
        var empty = json.readTree(json.writeValueAsString(quests.quests(member)));
        var challenge = empty.get("challenge");
        for (String field : List.of("round", "ticId", "progressStage", "participantCount")) {
            assertTrue(challenge.has(field) && challenge.get(field).isNull(), field + ": " + challenge);
        }
        var locked = empty.get("tutorial").get("items").get(1);
        assertTrue(locked.has("ticId") && locked.get("ticId").isNull(), locked.toString());
        assertTrue(locked.has("completionReason") && locked.get("completionReason").isNull(), locked.toString());

        insertRound("active");
        var round = json.readTree(json.writeValueAsString(quests.quests(member))).get("challenge").get("round");
        assertEquals("\"2026-09-14\"", round.get("startsOn").toString());
        assertEquals("\"2026-09-21\"", round.get("endsOn").toString());
        assertEquals("\"cr-", round.get("roundId").toString().substring(0, 4));
    }

    // ---------- 도우미 ----------

    private long signUp() {
        long member = insertMember();
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> initial.initialize(member));
        return member;
    }

    /** 제출 저장(143)이 할 완료 처리를 대신하고 후처리 함수를 부른다. */
    private void complete(long member, int seq, String reason) {
        jdbc.update("""
                INSERT INTO user_star_progress(user_id, tic_id, progress_stage, completion_reason, completed_at)
                VALUES (?, ?, 'completed', ?, now())
                ON CONFLICT (user_id, tic_id) DO UPDATE
                   SET progress_stage = 'completed', completion_reason = EXCLUDED.completion_reason,
                       completed_at = EXCLUDED.completed_at
                """, member, TUTORIAL[seq], reason);
        new TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> progress.onTutorialCompleted(member, TUTORIAL[seq]));
    }

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private void insertStar(long tic) {
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (?, 0, 'published')", tic);
    }

    private long insertRound(String status) {
        return jdbc.queryForObject("INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id,"
                + " description, status) VALUES (3, DATE '2026-09-14', DATE '2026-09-21', ?,"
                + " '얕은 별에서 두 번째 신호 찾기', ?) RETURNING id", Long.class, CHALLENGE, status);
    }

    private long insertCandidate() {
        return jdbc.queryForObject("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step,"
                + " period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model, discoverable,"
                + " is_confirmed) VALUES (?, 'active', ?, 1, 3.5, 1501.0, 2.8, 400, 12.5, '{}'::jsonb, true, false)"
                + " RETURNING id", Long.class, CHALLENGE, bundleId);
    }

    private long insertThread(long candidate, String status) {
        return jdbc.queryForObject("INSERT INTO posts(kind, candidate_id, board, tic_id, title, body, status)"
                + " VALUES ('system_thread', ?, 'star', ?, '신호', '요약', ?) RETURNING id",
                Long.class, candidate, CHALLENGE, status);
    }

    /** 공개 분석 한 건. 취소·숨김 시각은 SQL 식으로 받는다. */
    private void publish(long thread, long member, String unpublishedAt, String hiddenAt) {
        long submission = submitAt(member, CHALLENGE, "now()");
        long history = jdbc.queryForObject("INSERT INTO analysis_histories(submission_id, user_id, tic_id,"
                + " snapshot_params, versions) VALUES (?, ?, ?, '{}'::jsonb, '{}'::jsonb) RETURNING id",
                Long.class, submission, member, CHALLENGE);
        long candidate = jdbc.queryForObject("SELECT candidate_id FROM posts WHERE id = ?", Long.class, thread);
        jdbc.update("INSERT INTO published_analyses(post_id, user_id, candidate_id, history_id, published_at,"
                + " unpublished_at, hidden_at) VALUES (?, ?, ?, ?, now(), " + (unpublishedAt == null ? "NULL" : unpublishedAt)
                + ", " + (hiddenAt == null ? "NULL" : hiddenAt) + ")", thread, member, candidate, history);
    }

    /** 매칭 없는 제출 한 건. 재개 카드와 공개 분석이 필요로 하는 최소 행이다. */
    private long submitAt(long member, long tic, String createdAt) {
        return jdbc.queryForObject("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                + " curve_step, removed_candidate_ids, fold_reference_time_btjd, evidence_checks, match_result,"
                + " achievement_result, residual_model_version, periodogram_config_version, rule_version, created_at)"
                + " VALUES (?, ?, ?, ?::uuid, 'no_candidate', 0, '{}', 1500.5, '[]'::jsonb, 'none_wrong', 'none',"
                + " 'rm-1', 'pg-1', 'rule-0', " + createdAt + ") RETURNING id",
                Long.class, member, tic, bundleId, UUID.randomUUID().toString());
    }

    private long revision(long member) {
        return jdbc.queryForObject("SELECT COALESCE((SELECT revision FROM member_sky_revisions WHERE user_id = ?), 0)",
                Long.class, member);
    }
}
