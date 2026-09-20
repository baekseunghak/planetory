package com.planetory.backend.domain.exploration;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
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

import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.StarViews.StarListItem;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 내 별·타인 별 목록 계약 [S15P21C206-138].
 *
 * <p>탐사 API 4.4절. 완료 조건의 핵심은 "같은 정렬에서 커서 페이지 경계에 중복·누락이 없다"와
 * "타인에게 개인 진행 상세가 우회 노출되지 않는다"다.
 */
@ActiveProfiles("local")
@SpringBootTest
class StarListTest {

    private static final String SCHEMA =
            "star_list_" + UUID.randomUUID().toString().replace("-", "");

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

    @Autowired StarService stars;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;

    private static final String MANIFEST = """
            {"segment_ids": [1], "array_checksums": {},
             "residual_model_version": "rm-1", "periodogram_config_version": "pg-1",
             "binning": {}, "period_grid": {}, "fine_tune": {}, "curve_steps": {}}
            """;

    private long memberId;
    private long otherMemberId;

    @BeforeEach
    void seed() {
        memberId = insertMember();
        otherMemberId = insertMember();
        // submissions.rule_version은 V9가 넣은 초기 규칙 rule-0을 쓴다. '{}' 같은 임의 값은 CHECK가 거절한다.
    }

    // ---------- 정렬·커서 ----------

    /**
     * 완료 조건 (5). 모든 별이 같은 시각이면 동률 규칙만으로 정렬된다. 페이지를 다 모았을 때
     * 중복도 누락도 없어야 한다.
     *
     * <p>시각에 <b>마이크로초를 채운다</b>. 운영 발견 시각은 {@code CURRENT_TIMESTAMP}라 그 자리까지
     * 있다. 처음에는 정각 초로만 넣어 밀리초 아래가 0이었고, 커서가 밀리초로 잘라 담아도 손실이
     * 없어 결함이 가려졌다. 마이크로초가 있으면 첫 4개 뒤 21개가 전부 빠졌다(!57 리뷰).
     */
    @Test
    void 같은_시각의_별들도_커서_경계에서_중복되거나_빠지지_않는다() {
        List<Long> seeded = new ArrayList<>();
        for (int i = 0; i < 25; i++) {
            seeded.add(unlockAt(memberId, i, "2026-09-10T02:30:00.123456Z"));
        }

        var collected = drainAll(memberId, "discovered", 4);

        assertEquals(25, collected.size(), "한 건도 빠지면 안 된다");
        assertEquals(25, new HashSet<>(collected).size(), "같은 별이 두 번 나오면 안 된다");
        assertEquals(seeded.stream().sorted().toList(), collected.stream().sorted().toList());
    }

    /** 정각 초에서도 같다. 마이크로초 경우만 보면 경계값 처리가 바뀌었을 때 놓칠 수 있다. */
    @Test
    void 정각_초_시각도_커서_경계에서_빠지지_않는다() {
        for (int i = 0; i < 9; i++) {
            unlockAt(memberId, i, "2026-09-10T02:30:00Z");
        }

        var collected = drainAll(memberId, "discovered", 4);

        assertEquals(9, collected.size());
        assertEquals(9, new HashSet<>(collected).size());
    }

    /** 1마이크로초 차이도 순서를 가른다. 커서가 그 차이를 뭉개면 순서가 무너진다. */
    @Test
    void 일_마이크로초_차이도_순서와_경계를_지킨다() {
        long newer = unlockAt(memberId, 0, "2026-09-10T02:30:00.000002Z");
        long older = unlockAt(memberId, 1, "2026-09-10T02:30:00.000001Z");

        var collected = drainAll(memberId, "discovered", 1);

        assertEquals(List.of(newer, older), collected, "1마이크로초 늦은 쪽이 먼저다");
    }

    /** 시각이 섞여 있어도 최근 순이고 동률은 ticId로 갈린다. */
    @Test
    void 최근_활동_순이고_동률은_ticId로_갈린다() {
        long older = unlockAt(memberId, 0, "2026-09-01T00:00:00Z");
        long tieA = unlockAt(memberId, 1, "2026-09-10T00:00:00Z");
        long tieB = unlockAt(memberId, 2, "2026-09-10T00:00:00Z");
        long newest = unlockAt(memberId, 3, "2026-09-15T00:00:00Z");

        var items = stars.list(memberId, memberId, "discovered", null, 10, null).items();
        var order = items.stream().map(StarListItem::ticId).toList();

        assertEquals(String.valueOf(newest), order.get(0));
        assertEquals(String.valueOf(older), order.get(3), "가장 오래된 것이 마지막이다");
        assertEquals(List.of(String.valueOf(Math.min(tieA, tieB)), String.valueOf(Math.max(tieA, tieB))),
                order.subList(1, 3), "동률은 ticId 오름차순이다");
    }

    /** 제출이 발견보다 늦으면 제출 시각이 정렬 키가 된다. */
    @Test
    void 최근_제출이_있으면_그_시각으로_정렬된다() {
        long early = unlockAt(memberId, 0, "2026-09-01T00:00:00Z");
        long late = unlockAt(memberId, 1, "2026-09-05T00:00:00Z");
        submitAt(memberId, early, "2026-09-20T00:00:00Z");

        var order = stars.list(memberId, memberId, "discovered", null, 10, null).items()
                .stream().map(StarListItem::ticId).toList();

        assertEquals(String.valueOf(early), order.get(0), "늦게 제출한 별이 앞선다");
        assertEquals(String.valueOf(late), order.get(1));
    }

    /** 다른 조건의 커서로는 이어읽을 수 없다. */
    @Test
    void 조건이_다른_커서는_거절된다() {
        for (int i = 0; i < 5; i++) {
            unlockAt(memberId, i, "2026-09-10T02:30:00Z");
        }
        String cursor = stars.list(memberId, memberId, "discovered", null, 2, null).nextCursor();
        assertNotNull(cursor);

        assertThrows(BusinessException.class,
                () -> stars.list(memberId, memberId, "discovered", null, 3, cursor),
                "size가 다르면 이어읽을 수 없다");
        assertThrows(BusinessException.class,
                () -> stars.list(otherMemberId, otherMemberId, "discovered", null, 2, cursor),
                "다른 회원의 커서는 쓸 수 없다");
        assertThrows(BusinessException.class,
                () -> stars.list(memberId, memberId, "discovered", null, 2, "!!!망가진커서!!!"));
    }

    /** 마지막 페이지에는 다음 커서가 없다. */
    @Test
    void 마지막_페이지는_다음_커서가_없다() {
        unlockAt(memberId, 0, "2026-09-10T02:30:00Z");

        var page = stars.list(memberId, memberId, "discovered", null, 10, null);

        assertNull(page.nextCursor());
        assertFalse(page.hasNext());
        assertEquals(1, page.items().size());
    }

    // ---------- scope ----------

    /** 기본은 제출 이력이 있는 별만이다(MY-02). */
    @Test
    void 기본_범위는_제출한_별만_담는다() {
        long submitted = unlockAt(memberId, 0, "2026-09-10T00:00:00Z");
        unlockAt(memberId, 1, "2026-09-11T00:00:00Z");   // 발견만 하고 제출 없음
        submitAt(memberId, submitted, "2026-09-12T00:00:00Z");

        var defaultScope = stars.list(memberId, memberId, null, null, 10, null).items();
        var discovered = stars.list(memberId, memberId, "discovered", null, 10, null).items();

        assertEquals(1, defaultScope.size());
        assertEquals(String.valueOf(submitted), defaultScope.get(0).ticId());
        assertEquals(2, discovered.size(), "발견만 한 별도 포함한다");
    }

    /** 성과로 막 발견해 아직 제출하지 않은 별도 골라 분석에 들어갈 수 있어야 한다(지웅 리뷰 6). */
    @Test
    void 미제출_발견_별도_discovered에_담긴다() {
        long justDiscovered = unlockAt(memberId, 0, "2026-09-10T00:00:00Z");

        var items = stars.list(memberId, memberId, "discovered", null, 10, null).items();

        assertEquals(1, items.size());
        assertEquals(String.valueOf(justDiscovered), items.get(0).ticId());
        assertEquals("unexplored", items.get(0).progressStage());
    }

    /** 잘못된 scope·sort·size는 거절한다. */
    @Test
    void 계약_밖_요청은_거절된다() {
        assertThrows(BusinessException.class,
                () -> stars.list(memberId, memberId, "everything", null, 10, null));
        assertThrows(BusinessException.class,
                () -> stars.list(memberId, memberId, null, "oldest", 10, null));
        assertThrows(BusinessException.class,
                () -> stars.list(memberId, memberId, null, null, 0, null));
        assertThrows(BusinessException.class,
                () -> stars.list(memberId, memberId, null, null,
                        StarService.MAX_LIST_SIZE + 1, null));
    }

    // ---------- 타인 조회 ----------

    /** 목록을 비공개한 회원은 403이다. */
    @Test
    void 비공개_회원의_목록은_거절된다() {
        unlockAt(otherMemberId, 0, "2026-09-10T00:00:00Z");
        jdbc.update("INSERT INTO user_settings(user_id, star_list_public) VALUES (?, false)"
                + " ON CONFLICT (user_id) DO UPDATE SET star_list_public = false", otherMemberId);

        var thrown = assertThrows(BusinessException.class,
                () -> stars.list(memberId, otherMemberId, null, null, 10, null));

        assertEquals(ErrorCode.STAR_LIST_PRIVATE, thrown.getErrorCode());
    }

    @Test
    void 공개_목록의_커서도_비공개_전환_뒤에는_우회하지_못한다() {
        long first = unlockAt(otherMemberId, 0, "2026-09-10T00:00:00Z");
        long second = unlockAt(otherMemberId, 1, "2026-09-11T00:00:00Z");
        submitAt(otherMemberId, first, "2026-09-12T00:00:00Z");
        submitAt(otherMemberId, second, "2026-09-13T00:00:00Z");
        String cursor = stars.list(memberId, otherMemberId, null, null, 1, null).nextCursor();
        jdbc.update("INSERT INTO user_settings(user_id, star_list_public) VALUES (?, false)"
                + " ON CONFLICT (user_id) DO UPDATE SET star_list_public = false", otherMemberId);

        var thrown = assertThrows(BusinessException.class,
                () -> stars.list(memberId, otherMemberId, null, null, 1, cursor));

        assertEquals(ErrorCode.STAR_LIST_PRIVATE, thrown.getErrorCode());
    }

    /** 비공개여도 본인은 본다. */
    @Test
    void 비공개여도_본인은_자기_목록을_본다() {
        unlockAt(memberId, 0, "2026-09-10T00:00:00Z");
        jdbc.update("INSERT INTO user_settings(user_id, star_list_public) VALUES (?, false)"
                + " ON CONFLICT (user_id) DO UPDATE SET star_list_public = false", memberId);

        assertEquals(1, stars.list(memberId, memberId, "discovered", null, 10, null).items().size());
    }

    /** 설정 행이 없으면 기본값 공개다. */
    @Test
    void 설정이_없으면_공개로_본다() {
        long tic = unlockAt(otherMemberId, 0, "2026-09-10T00:00:00Z");
        submitAt(otherMemberId, tic, "2026-09-11T00:00:00Z");

        assertEquals(1, stars.list(memberId, otherMemberId, null, null, 10, null).items().size());
    }

    /** 미게시 수는 본인만 본다. 0이 아니라 없음이다(NFR-14). */
    @Test
    void 미게시_수는_타인에게_주지_않는다() {
        long tic = unlockAt(otherMemberId, 0, "2026-09-10T00:00:00Z");
        long candidate = insertCandidate(tic);
        submitMatched(otherMemberId, tic, candidate, "2026-09-11T00:00:00Z");

        var mine = stars.list(otherMemberId, otherMemberId, null, null, 10, null).items().get(0);
        var theirs = stars.list(memberId, otherMemberId, null, null, 10, null).items().get(0);

        assertEquals(1, mine.unpublishedSignalCount(), "본인은 미게시 1건을 본다");
        assertNull(theirs.unpublishedSignalCount(), "타인에게는 0이 아니라 없음이다");
    }

    /** 타인 조회에서 discovered를 쓰면 미제출 발견까지 드러난다. 거절한다. */
    @Test
    void 타인에게는_discovered를_허용하지_않는다() {
        unlockAt(otherMemberId, 0, "2026-09-10T00:00:00Z");

        assertThrows(BusinessException.class,
                () -> stars.list(memberId, otherMemberId, "discovered", null, 10, null));
    }

    // ---------- 항목 값 ----------

    /** 등급은 성과 수에서 만든다(GRD-01). 상세와 같은 규칙이다. */
    @Test
    void 등급과_성과_수가_상세와_같은_규칙이다() {
        long tic = unlockAt(memberId, 0, "2026-09-10T00:00:00Z");
        long candidate = insertCandidate(tic);
        submitMatched(memberId, tic, candidate, "2026-09-11T00:00:00Z");
        recognize(memberId, candidate);

        var item = stars.list(memberId, memberId, null, null, 10, null).items().get(0);

        assertEquals(1, item.achievementCount());
        assertEquals("A", item.grade());
        assertEquals("achievement".equals(item.unlockReason()) ? "achievement" : "tutorial",
                item.unlockReason());
    }

    /** 성과가 없으면 등급이 null이다. */
    @Test
    void 성과가_없으면_등급이_없다() {
        unlockAt(memberId, 0, "2026-09-10T00:00:00Z");

        assertNull(stars.list(memberId, memberId, "discovered", null, 10, null)
                .items().get(0).grade());
    }

    // ---------- 픽스처 ----------

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    /** 별을 만들고 그 시각에 발견한 것으로 둔다. */
    private long unlockAt(long member, int ordinal, String unlockedAt) {
        long ticId = Math.abs(UUID.randomUUID().getMostSignificantBits() % 900_000_000L) + 1;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", ticId);
        var position = layout.place(ordinal);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, ?::timestamptz, ?, ?, ?, ?)",
                member, ticId, position.depthZ(), unlockedAt, position.worldX(),
                position.worldY(), position.layoutVersion(), ordinal);
        return ticId;
    }

    private long insertCandidate(long ticId) {
        long bundleId = jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, "v-" + UUID.randomUUID(), MANIFEST);
        return jdbc.queryForObject("INSERT INTO candidates"
                + "(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,"
                + " duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                + " VALUES (?, 'active', ?, 1, 3.0, 1501.0, 2.8, 900, 12.5, '{}'::jsonb, true, true)"
                + " RETURNING id", Long.class, ticId, bundleId);
    }

    private void submitAt(long member, long ticId, String createdAt) {
        insertSubmission(member, ticId, createdAt, null, "not_matched", "none");
    }

    private void submitMatched(long member, long ticId, long candidateId, String createdAt) {
        insertSubmission(member, ticId, createdAt, candidateId, "matched", "recognized");
    }

    private void insertSubmission(long member, long ticId, String createdAt, Long candidateId,
                                  String matchResult, String achievementResult) {
        long bundleId = existingBundle(ticId).orElseGet(() -> insertBundle(ticId));
        boolean candidateKind = candidateId != null;
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, submitted_period, phase_start, phase_end,"
                        + " fold_reference_time_btjd, user_judgment, evidence_checks, match_result,"
                        + " matched_candidate_id, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version, created_at)"
                        + " VALUES (?, ?, ?, ?::uuid, ?, 0, '{}', ?, ?, ?, 1500.5, ?, '[]'::jsonb,"
                        + " ?, ?, ?, 'rm-1', 'pg-1', 'rule-0', ?::timestamptz)",
                member, ticId, bundleId, UUID.randomUUID().toString(),
                candidateKind ? "candidate" : "no_candidate",
                candidateKind ? 3.0 : null, candidateKind ? 0.1 : null, candidateKind ? 0.2 : null,
                candidateKind ? "LIKELY_PLANET" : null,
                matchResult, candidateId, achievementResult, createdAt);
    }

    /** 제출은 판을 참조한다. 이미 있으면 그것을 쓰고 없으면 만든다. */
    private java.util.Optional<Long> existingBundle(long ticId) {
        return jdbc.queryForList("SELECT id FROM publication_bundles WHERE tic_id = ?"
                        + " ORDER BY id LIMIT 1", Long.class, ticId)
                .stream().findFirst();
    }

    private long insertBundle(long ticId) {
        return jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, "v-" + UUID.randomUUID(), MANIFEST);
    }

    private void recognize(long member, long candidateId) {
        long submissionId = jdbc.queryForObject(
                "SELECT id FROM submissions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
                Long.class, member);
        jdbc.update("INSERT INTO user_candidate_achievements(user_id, candidate_id,"
                        + " achievement_type, recognized_submission_id, recognized_at)"
                        + " VALUES (?, ?, 'confirmed', ?, now())", member, candidateId, submissionId);
    }

    /** 페이지를 끝까지 따라가며 모은 ticId. 프론트가 목록을 완성하는 방식과 같다. */
    private List<Long> drainAll(long member, String scope, int size) {
        List<Long> collected = new ArrayList<>();
        Set<String> guard = new HashSet<>();
        String cursor = null;
        do {
            var page = stars.list(member, member, scope, null, size, cursor);
            page.items().forEach(item -> collected.add(Long.parseLong(item.ticId())));
            cursor = page.nextCursor();
            assertTrue(cursor == null || guard.add(cursor), "같은 커서가 반복되면 무한히 돈다");
        } while (cursor != null);
        return collected;
    }
}
