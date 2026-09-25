package com.planetory.backend.domain.exploration;

import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.member.service.MemberService;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 별·회원 경로 식별자의 HTTP 응답 [S15P21C206-246].
 *
 * <p>회원 API가 주는 {@code u-{id}}를 그대로 넣었을 때 500이 나던 문제(S15P21C206-138, MR !57)를
 * 실제 회원 ID와 실제 로그인 세션으로 확인한다. 조회 규칙 자체는 {@code StarListTest}·{@code StarDetailTest}가
 * 본다. 여기서는 경로 값 해석과 상태 코드만 본다.
 */
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class StarPathHttpTest {

    private static final String SCHEMA = "star_path_" + UUID.randomUUID().toString().replace("-", "");

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

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired GalaxyLayout layout;
    @Autowired MemberService members;
    @Autowired AuthSessionService sessions;

    private long viewer;
    private long openMember;
    private long privateMember;
    private long viewerTic;
    private long openTic;
    private MockHttpSession session;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        viewer = insertMember();
        openMember = insertMember();
        privateMember = insertMember();
        viewerTic = unlock(viewer, 0);
        openTic = unlock(openMember, 1);
        submit(openMember, openTic);
        unlock(privateMember, 2);
        jdbc.update("INSERT INTO user_settings(user_id, star_list_public) VALUES (?, false)", privateMember);
        session = loginSession(viewer);
    }

    /** 완료 조건: 회원 API가 준 값을 그대로 넣을 수 있다. */
    @Test
    void 회원_API가_준_u_형식으로_공개_목록을_읽는다() throws Exception {
        mvc.perform(get("/api/v1/members/u-" + openMember + "/stars").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].ticId").value(String.valueOf(openTic)))
                // 타인 조회는 미게시 신호 수를 주지 않는다(NFR-14).
                .andExpect(jsonPath("$.items[0].unpublishedSignalCount").doesNotExist());
    }

    @Test
    void 비공개_목록은_403_STAR_LIST_PRIVATE다() throws Exception {
        mvc.perform(get("/api/v1/members/u-" + privateMember + "/stars").session(session))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("STAR_LIST_PRIVATE"));
    }

    /** 숫자만 적은 값은 같은 회원을 가리키는 다른 문자열이라 받지 않는다. 500이 아니라 400이다. */
    @Test
    void 계약_밖_회원_식별자는_400이다() throws Exception {
        for (String id : new String[] {String.valueOf(openMember), "abc", "u-0", "u-01", "u-", "u-1x", "u--1"}) {
            mvc.perform(get("/api/v1/members/" + id + "/stars").session(session))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        }
    }

    /** 형식이 다른 TIC은 없는 별을 숫자로 요청했을 때와 같은 응답이어야 별 존재가 드러나지 않는다. */
    @Test
    void 숫자가_아닌_TIC_경로는_없는_별과_같은_응답으로_덮는다() throws Exception {
        for (String tic : new String[] {"abc", "0", "01", "999999999"}) {
            mvc.perform(get("/api/v1/me/stars/" + tic).session(session))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("STAR_LOCKED"));
            mvc.perform(get("/api/v1/stars/" + tic).session(session))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.code").value("STAR_NOT_PUBLISHED"));
        }
    }

    @Test
    void 정상_TIC_경로는_그대로_동작한다() throws Exception {
        mvc.perform(get("/api/v1/me/stars/" + viewerTic).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ticId").value(String.valueOf(viewerTic)));
        mvc.perform(get("/api/v1/stars/" + openTic).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ticId").value(String.valueOf(openTic)));
    }

    @Test
    void 별_설명_묶음은_로그인과_별_열림을_요구한다() throws Exception {
        String own = "/api/v1/me/stars/" + viewerTic + "/planet-explanations";
        mvc.perform(get(own)).andExpect(status().isUnauthorized());
        mvc.perform(get(own).session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ticId").value(String.valueOf(viewerTic)))
                .andExpect(jsonPath("$.items.length()").value(0));
        mvc.perform(get("/api/v1/me/stars/" + openTic + "/planet-explanations").session(session))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("STAR_LOCKED"));
        mvc.perform(post(own).session(session).contentType("application/json")
                        .content("{\"candidateId\":\"c-1\"}"))
                .andExpect(status().isForbidden());
        mvc.perform(post(own).session(session).with(csrf()).contentType("application/json")
                        .content("{\"candidateId\":\"c-1\"}"))
                .andExpect(status().isNotFound());
    }

    /** size도 숫자 타입으로 받으면 같은 이유로 500이 된다. */
    @Test
    void 계약_밖_size는_400이다() throws Exception {
        for (String size : new String[] {"abc", "0", "101", "1.5", ""}) {
            mvc.perform(get("/api/v1/me/stars?size=" + size).session(session))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        }
        mvc.perform(get("/api/v1/me/stars?scope=discovered&size=20").session(session))
                .andExpect(status().isOk());
    }

    /**
     * 없는 회원의 목록은 지금 공개 기본값을 타 200 빈 목록이다. 프로필 조회(404)와 다르고, 비공개
     * 회원(403)과도 갈려 회원 존재가 드러난다. 계약이 정해지면 함께 고친다(MR !57 후속 논의).
     */
    @Test
    void 없는_회원의_목록은_현재_빈_목록_200이다() throws Exception {
        mvc.perform(get("/api/v1/members/u-999999999/stars").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(0));
    }

    // ---------- 픽스처 ----------

    /** 운영과 같은 로그인 경로로 세션을 만든다. 세션 없이 보낸 인증은 필터가 만료로 보고 401을 준다. */
    private MockHttpSession loginSession(long memberId) {
        var request = new MockHttpServletRequest();
        var response = new MockHttpServletResponse();
        sessions.login(members.requireActive(memberId), request, response);
        SecurityContextHolder.clearContext();
        return (MockHttpSession) request.getSession(false);
    }

    private long insertMember() {
        String unique = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
    }

    private long unlock(long member, int ordinal) {
        long ticId = 700_000_000L + ordinal;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", ticId);
        var position = layout.place(ordinal);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z, unlocked_at,"
                        + " world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                member, ticId, position.depthZ(), position.worldX(), position.worldY(),
                position.layoutVersion(), ordinal);
        return ticId;
    }

    /** 기본 목록(scope=submitted)에 보이려면 제출 이력이 있어야 한다. */
    private void submit(long member, long ticId) {
        long bundleId = jdbc.queryForObject("INSERT INTO publication_bundles"
                        + "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        + " VALUES (?, ?, 'current', ?::jsonb, 1500.5, 27.4) RETURNING id",
                Long.class, ticId, "v-" + UUID.randomUUID(), MANIFEST);
        jdbc.update("INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind,"
                        + " curve_step, removed_candidate_ids, fold_reference_time_btjd, evidence_checks,"
                        + " match_result, achievement_result, residual_model_version,"
                        + " periodogram_config_version, rule_version)"
                        + " VALUES (?, ?, ?, ?::uuid, 'no_candidate', 0, '{}', 1500.5, '[]'::jsonb,"
                        + " 'not_matched', 'none', 'rm-1', 'pg-1', 'rule-0')",
                member, ticId, bundleId, UUID.randomUUID().toString());
    }
}
