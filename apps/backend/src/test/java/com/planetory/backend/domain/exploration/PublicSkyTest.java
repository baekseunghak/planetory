package com.planetory.backend.domain.exploration;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.PublicSkyRepository;
import com.planetory.backend.domain.exploration.service.PublicSkyService;
import com.planetory.backend.domain.exploration.service.PublicSkyViews;
import com.planetory.backend.domain.exploration.service.SkyProperties;
import com.planetory.backend.domain.exploration.service.SkyRepository;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews;
import com.planetory.backend.domain.exploration.service.StarRepository;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.hamcrest.Matchers.containsString;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 공개 은하의 실제 PostgreSQL·HTTP 계약 [S15P21C206-251]. */
@ActiveProfiles("local")
@SpringBootTest
@AutoConfigureMockMvc
class PublicSkyTest {
    private static final String SCHEMA = "public_sky_" + UUID.randomUUID().toString().replace("-", "");
    private static final long FIRST_TIC = 710_000_000L;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final double X = -16384, Y = -16384, W = 32768, H = 32768;
    private static final String MANIFEST = """
            {"segment_ids":[1],"array_checksums":{},"residual_model_version":"rm-1",
             "periodogram_config_version":"pg-1","binning":{},"period_grid":{},"fine_tune":{},"curve_steps":{}}
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

    @Autowired PublicSkyService publicSky;
    @Autowired SkyService sky;
    @Autowired GalaxyLayout layout;
    @Autowired SkyProperties skyProperties;
    @Autowired JdbcTemplate jdbc;
    @Autowired DataSource dataSource;
    @Autowired MockMvc mvc;
    @Autowired AuthSessionService sessions;
    @Autowired MemberService members;
    @Autowired PlatformTransactionManager transactions;
    @MockitoSpyBean PublicSkyRepository publicStars;
    @MockitoSpyBean SkyRepository positions;
    @MockitoSpyBean StarRepository stars;
    private long owner, viewer, otherOwner;
    private MockHttpSession session;

    @BeforeEach
    void seed() {
        assertEquals(SCHEMA, jdbc.queryForObject("SELECT current_schema()", String.class));
        jdbc.execute("TRUNCATE users, stars CASCADE");
        owner = member();
        viewer = member();
        otherOwner = member();
        session = session(viewer);
    }

    @ParameterizedTest
    @ValueSource(ints = {0, 1000, 5000})
    void 전체_보유별은_미제출도_빠짐없이_저장좌표로_페이지를_완성한다(int count) {
        unlock(owner, count);
        unlock(otherOwner, 7);
        var meta = publicSky.meta(owner);
        assertEquals(count, meta.starCount());
        assertEquals(sky.meta(owner, false).bounds(), meta.bounds());
        assertEquals("u-" + owner, meta.owner().memberId());
        assertEquals("all-owned", meta.scope());
        assertEquals("PUBLIC", meta.visibility());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM submissions", Integer.class));
        Map<String, SkyViews.SkyStar> personal = new java.util.HashMap<>();
        String privateCursor = null;
        do {
            var tile = sky.tiles(owner, 2, X, Y, W, H, sky.version(owner), 1000, privateCursor);
            tile.stars().forEach(star -> personal.put(star.ticId(), star));
            privateCursor = tile.nextCursor();
        } while (privateCursor != null);
        var saved = jdbc.queryForList("SELECT tic_id::text AS tic, world_x::float8 AS x, world_y::float8 AS y,"
                + " depth_z::float8 AS z, layout_ordinal FROM star_unlocks WHERE user_id=?", owner)
                .stream().collect(Collectors.toMap(row -> (String) row.get("tic"), row -> row));
        Set<String> seen = new HashSet<>();
        String cursor = null;
        int pages = 0;
        long started = System.nanoTime();
        do {
            var tile = page(viewer, owner, meta.version(), 1000, cursor);
            assertFalse(tile.versionChanged());
            assertEquals(count, tile.rangeStarCount());
            assertTrue(tile.stars().size() <= 1000);
            for (var star : tile.stars()) {
                assertTrue(seen.add(star.ticId()), "TIC 중복: " + star.ticId());
                var row = saved.get(star.ticId());
                var mine = personal.get(star.ticId());
                assertEquals(row.get("x"), star.x());
                assertEquals(row.get("y"), star.y());
                assertEquals(row.get("z"), star.depthZ());
                assertEquals(row.get("layout_ordinal"), star.layoutOrdinal());
                assertEquals(mine.x(), star.x());
                assertEquals(mine.y(), star.y());
                assertEquals(mine.depthZ(), star.depthZ());
                assertEquals(mine.layoutOrdinal(), star.layoutOrdinal());
                assertEquals(0, star.planetCount());
                assertEquals("unexplored", star.progressStage());
            }
            cursor = tile.nextCursor();
            assertTrue(++pages <= 5, "페이지가 끝나지 않는다");
        } while (cursor != null);
        if (count == 5000) System.out.printf("PUBLIC_SKY_5000 pages=%d elapsed_ms=%.3f%n",
                pages, (System.nanoTime() - started) / 1_000_000.0);
        assertEquals(count, seen.size());
        assertEquals(saved.keySet(), seen);
        if (count > 0) {
            var detail = publicSky.detail(owner, FIRST_TIC);
            assertEquals(meta.version(), detail.version());
            assertEquals(saved.get(String.valueOf(FIRST_TIC)).get("x"), detail.position().x());
            assertEquals(saved.get(String.valueOf(FIRST_TIC)).get("y"), detail.position().y());
            assertEquals(saved.get(String.valueOf(FIRST_TIC)).get("z"), detail.position().depthZ());
        }
    }

    @Test
    void 범위는_반개구간이며_빈범위와_잘못된_입력을_구분한다() {
        unlock(owner, 2);
        jdbc.update("UPDATE star_unlocks SET world_x=layout_ordinal*512,world_y=0 WHERE user_id=?", owner);
        String version = publicSky.meta(owner).version();
        var left = publicSky.tiles(viewer, owner, 2, 0, 0, 512, 512, version, 1000, null);
        var right = publicSky.tiles(viewer, owner, 2, 512, 0, 512, 512, version, 1000, null);
        assertEquals(1, left.rangeStarCount());
        assertEquals(1, right.rangeStarCount());
        assertEquals(String.valueOf(FIRST_TIC), left.stars().getFirst().ticId());
        assertEquals(String.valueOf(FIRST_TIC + 1), right.stars().getFirst().ticId());
        var empty = publicSky.tiles(viewer, owner, 2, 40000, 40000, 10, 10, version, null, null);
        assertEquals(0, empty.rangeStarCount());
        assertTrue(empty.stars().isEmpty());
        assertNull(empty.nextCursor());
        assertFalse(empty.versionChanged());
        invalid(() -> publicSky.tiles(viewer, owner, 99, X, Y, W, H, version, 1, null));
        invalid(() -> publicSky.tiles(viewer, owner, 2, Double.NaN, Y, W, H, version, 1, null));
        invalid(() -> publicSky.tiles(viewer, owner, 2, X, Y, 0, H, version, 1, null));
        invalid(() -> publicSky.tiles(viewer, owner, 2, X, Y, sky.maxBox() + 1, H, version, 1, null));
        invalid(() -> page(viewer, owner, version, 0, null));
        invalid(() -> page(viewer, owner, version, SkyService.MAX_LIMIT + 1, null));
    }

    @Test
    void 커서는_소유자_로그인회원_개인공개범위_배율_영역_limit에_묶인다() {
        unlock(owner, 3);
        unlock(otherOwner, 3);
        String version = publicSky.meta(owner).version();
        String cursor = page(viewer, owner, version, 1, null).nextCursor();
        assertNotNull(cursor);
        assertEquals(page(viewer, owner, version, 1, cursor).stars(),
                page(viewer, owner, version, 1, cursor).stars());
        invalid(() -> page(otherOwner, owner, version, 1, cursor));
        invalid(() -> page(viewer, otherOwner, publicSky.meta(otherOwner).version(), 1, cursor));
        invalid(() -> page(viewer, owner, version, 2, cursor));
        invalid(() -> publicSky.tiles(viewer, owner, 1, X, Y, W, H, version, 1, cursor));
        invalid(() -> publicSky.tiles(viewer, owner, 2, X + 1, Y, W, H, version, 1, cursor));
        invalid(() -> page(viewer, owner, version, 1, "broken"));
        String privateCursor = sky.tiles(owner, 2, X, Y, W, H, sky.version(owner), 1, null).nextCursor();
        invalid(() -> page(viewer, owner, version, 1, privateCursor));
        invalid(() -> sky.tiles(owner, 2, X, Y, W, H, sky.version(owner), 1, cursor));
        assertTrue(page(viewer, owner, sky.version(owner), 1, null).versionChanged());
    }

    @Test
    void 공개행성은_성과와_현재표시정책을_함께_만족하고_타일상세수가_같다() throws Exception {
        unlock(owner, 1);
        unlock(otherOwner, 1);
        long bundle = bundle(FIRST_TIC);
        long confirmed = candidate(bundle, true, null);
        long pending = candidate(bundle, false, "pc");
        long unearned = candidate(bundle, true, null);
        long fp = candidate(bundle, true, "fp");
        long changedJudgment = candidate(bundle, false, "pc");
        long otherOnly = candidate(bundle, true, null);
        long relabeledFp = candidate(bundle, true, "confirmed");
        recognize(owner, confirmed, "confirmed", submit(owner, bundle, confirmed, "UNLIKELY_PLANET"));
        recognize(owner, pending, "unconfirmed", submit(owner, bundle, pending, "LIKELY_PLANET"));
        submit(owner, bundle, unearned, "LIKELY_PLANET");
        recognize(owner, fp, "confirmed", submit(owner, bundle, fp, "LIKELY_PLANET"));
        recognize(owner, changedJudgment, "unconfirmed", submit(owner, bundle, changedJudgment, "LIKELY_PLANET"));
        submit(owner, bundle, changedJudgment, "UNLIKELY_PLANET");
        recognize(otherOwner, otherOnly, "confirmed", submit(otherOwner, bundle, otherOnly, "LIKELY_PLANET"));
        recognize(owner, relabeledFp, "fp", submit(owner, bundle, relabeledFp, "LIKELY_PLANET"));
        jdbc.update("INSERT INTO user_star_progress(user_id,tic_id,planet_count,progress_stage,reopen_pending)"
                + " VALUES (?,?,9,'completed',true)", owner, FIRST_TIC);
        var detail = publicSky.detail(owner, FIRST_TIC);
        List<String> expected = List.of("c-" + confirmed, "c-" + pending, "c-" + relabeledFp)
                .stream().sorted().toList();
        assertEquals(expected, detail.planets().items().stream().map(PublicSkyViews.Planet::candidateId).toList());
        assertEquals(3, detail.planets().count());
        assertEquals(3, new HashSet<>(detail.planets().items()).size());
        assertEquals(4, stars.findMyPlanets(owner, FIRST_TIC).size(), "개인 후보 표시 의미는 유지한다");
        var tile = page(viewer, owner, detail.version(), 1000, null);
        assertEquals(detail.planets().count(), tile.stars().getFirst().planetCount());
        assertEquals("completed", tile.stars().getFirst().progressStage());
        assertFalse(tile.stars().getFirst().completedWithoutPlanets());
        assertEquals(1, publicSky.detail(otherOwner, FIRST_TIC).planets().count());
        var contract = Map.of(
                "meta", response(mvc.perform(request(owner, "/sky").session(session))),
                "tile", response(mvc.perform(request(owner, "/sky/tiles").param("version", detail.version()).session(session))),
                "detail", response(mvc.perform(request(owner, "/stars/" + FIRST_TIC).session(session))));
        java.nio.file.Files.createDirectories(java.nio.file.Path.of("build"));
        java.nio.file.Files.writeString(java.nio.file.Path.of("build/public-sky-contract.json"), JSON.writeValueAsString(contract));
    }

    @Test
    void 공개완료표식은_현재공개행성기준이며_개인성과를_회수하지_않는다() {
        unlock(owner, 1);
        long bundle = bundle(FIRST_TIC);
        long candidate = candidate(bundle, true, "confirmed");
        long submission = submit(owner, bundle, candidate, "LIKELY_PLANET");
        jdbc.update("INSERT INTO user_star_progress(user_id,tic_id,planet_count,progress_stage)"
                + " VALUES (?,?,1,'completed')", owner, FIRST_TIC);
        var personal = sky.tiles(owner, 2, X, Y, W, H, sky.version(owner), 1000, null).stars().getFirst();
        assertEquals(1, personal.planetCount());
        assertFalse(personal.completedWithoutPlanets());
        String before = publicSky.meta(owner).version();
        assertTrue(page(viewer, owner, before, 1000, null).stars().getFirst().completedWithoutPlanets());
        assertEquals(0, publicSky.detail(owner, FIRST_TIC).planets().count());

        recognize(owner, candidate, "confirmed", submission);
        String recognized = publicSky.meta(owner).version();
        assertNotEquals(before, recognized);
        assertFalse(page(viewer, owner, recognized, 1000, null).stars().getFirst().completedWithoutPlanets());
        assertEquals(1, publicSky.detail(owner, FIRST_TIC).planets().count());

        jdbc.update("UPDATE candidate_dispositions SET disposition='fp' WHERE candidate_id=?", candidate);
        String relabeled = publicSky.meta(owner).version();
        assertNotEquals(recognized, relabeled);
        assertTrue(page(viewer, owner, relabeled, 1000, null).stars().getFirst().completedWithoutPlanets());
        assertEquals(0, publicSky.detail(owner, FIRST_TIC).planets().count());
        assertEquals(personal, sky.tiles(owner, 2, X, Y, W, H, sky.version(owner), 1000, null).stars().getFirst());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM user_candidate_achievements"
                + " WHERE user_id=? AND candidate_id=? AND achievement_type='confirmed'", Integer.class, owner, candidate));
    }

    @Test
    void 공개_projection_변경은_개인버전이_그대로여도_기존페이지를_무효화한다() {
        unlock(owner, 2);
        long bundle = bundle(FIRST_TIC);
        long candidate = candidate(bundle, false, "pc");
        long submission = submit(owner, bundle, candidate, "LIKELY_PLANET");
        String privateVersion = sky.version(owner);
        String before = publicSky.meta(owner).version();
        String cursor = page(viewer, owner, before, 1, null).nextCursor();
        recognize(owner, candidate, "unconfirmed", submission);
        String recognized = publicSky.meta(owner).version();
        assertNotEquals(before, recognized);
        assertEquals(privateVersion, sky.version(owner));
        var changed = page(viewer, owner, before, 1, cursor);
        assertTrue(changed.versionChanged());
        assertEquals(recognized, changed.version());
        assertTrue(changed.stars().isEmpty());
        assertNull(changed.nextCursor());
        invalid(() -> page(viewer, owner, recognized, 1, cursor));
        submit(owner, bundle, candidate, "UNLIKELY_PLANET");
        assertNotEquals(recognized, publicSky.meta(owner).version());
        assertEquals(0, publicSky.detail(owner, FIRST_TIC).planets().count());
        submit(owner, bundle, candidate, "LIKELY_PLANET");
        jdbc.update("UPDATE candidates SET period_days=4.125,depth_ppm=321.5,is_confirmed=true WHERE id=?", candidate);
        String physical = publicSky.meta(owner).version();
        assertNotEquals(recognized, physical);
        var planet = publicSky.detail(owner, FIRST_TIC).planets().items().getFirst();
        assertEquals("confirmed", planet.kind());
        assertEquals(4.125, planet.periodDays());
        assertEquals(321.5, planet.depthPpm());
        jdbc.update("UPDATE candidate_dispositions SET disposition='fp' WHERE candidate_id=?", candidate);
        assertNotEquals(physical, publicSky.meta(owner).version());
        assertEquals(0, publicSky.detail(owner, FIRST_TIC).planets().count());
        String fpVersion = publicSky.meta(owner).version();
        jdbc.update("INSERT INTO user_star_progress(user_id,tic_id,progress_stage) VALUES (?,?,'completed')", owner, FIRST_TIC);
        assertNotEquals(fpVersion, publicSky.meta(owner).version());
        assertTrue(page(viewer, owner, publicSky.meta(owner).version(), 1000, null)
                .stars().getFirst().completedWithoutPlanets());
        String progressVersion = publicSky.meta(owner).version();
        sky.bumpVersion(owner);
        assertNotEquals(progressVersion, publicSky.meta(owner).version());
    }

    @Test
    void 공개_HTTP는_허용필드만_보내고_null_수치를_0으로_바꾸지_않는다() throws Exception {
        unlock(owner, 1);
        String version = publicSky.meta(owner).version();
        JsonNode meta = response(mvc.perform(request(owner, "/sky").session(session)));
        keys(meta, "owner", "scope", "visibility", "representation", "version", "layoutVersion",
                "presentationVersion", "starCount", "bounds", "tileSize", "zoomLevels", "asOf");
        keys(meta.path("owner"), "memberId", "nickname");
        assertEquals("u-" + owner, meta.path("owner").path("memberId").asText());
        JsonNode tile = response(mvc.perform(request(owner, "/sky/tiles").param("version", version).session(session)));
        keys(tile, "representation", "version", "level", "versionChanged", "bounds", "rangeStarCount", "stars", "nextCursor", "asOf");
        keys(tile.path("stars").get(0), "ticId", "x", "y", "depthZ", "layoutOrdinal", "planetCount",
                "progressStage", "completedWithoutPlanets");
        // 원천 두 열은 NOT NULL이다. nullable 공개 계약의 직렬화는 저장 스키마를 바꾸지 않고 확인한다.
        doReturn(List.of(new PublicSkyViews.Planet("c-123", "confirmed", null, null)))
                .when(publicStars).findPlanets(owner, FIRST_TIC);
        JsonNode detail = response(mvc.perform(request(owner, "/stars/" + FIRST_TIC).session(session)));
        keys(detail, "memberId", "ticId", "version", "presentationVersion", "position", "planets");
        keys(detail.path("position"), "x", "y", "depthZ", "layoutOrdinal", "layoutVersion");
        keys(detail.path("planets"), "count", "items");
        JsonNode planet = detail.path("planets").path("items").get(0);
        keys(planet, "candidateId", "kind", "periodDays", "depthPpm");
        assertTrue(planet.path("periodDays").isNull());
        assertTrue(planet.path("depthPpm").isNull());
    }

    @Test
    void 인증과_소유자공개상태는_모든_HTTP와_기존커서에_적용된다() throws Exception {
        unlock(owner, 2);
        String version = publicSky.meta(owner).version();
        String cursor = page(viewer, owner, version, 1, null).nextCursor();
        List<String> paths = List.of("/sky", "/sky/tiles", "/stars/" + FIRST_TIC);
        for (String suffix : paths) {
            mvc.perform(request(owner, suffix)).andExpect(status().isUnauthorized())
                    .andExpect(header().string("Cache-Control", containsString("no-store")));
            response(mvc.perform(request(owner, suffix).param("version", version).session(session)));
        }
        for (String state : List.of("private", "withdrawn", "missing")) {
            jdbc.update("UPDATE users SET status='active' WHERE id=?", owner);
            setPublic(owner, !state.equals("private"));
            if (state.equals("withdrawn")) jdbc.update("UPDATE users SET status='withdrawn' WHERE id=?", owner);
            long target = state.equals("missing") ? 999_999_999L : owner;
            for (String suffix : paths) {
                mvc.perform(request(target, suffix).param("version", version).session(session)).andExpect(status().isNotFound())
                        .andExpect(jsonPath("$.code").value("PUBLIC_SKY_NOT_AVAILABLE"))
                        .andExpect(header().string("Cache-Control", containsString("no-store")));
            }
            mvc.perform(request(target, "/sky/tiles").param("version", version).param("limit", "1")
                            .param("cursor", cursor).session(session))
                    .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("PUBLIC_SKY_NOT_AVAILABLE"));
        }
        jdbc.update("UPDATE users SET status='active' WHERE id=?", owner);
        setPublic(owner, true);
        mvc.perform(request(owner, "/stars/999999999").session(session)).andExpect(status().isNotFound());
        mvc.perform(request(otherOwner, "/stars/" + FIRST_TIC).session(session)).andExpect(status().isNotFound());
    }

    @ParameterizedTest
    @ValueSource(strings = {"meta", "tiles", "detail"})
    void 조회_스냅샷_뒤_공개철회는_응답직전_새트랜잭션에서_차단한다(String endpoint) throws Exception {
        unlock(owner, 2);
        String version = publicSky.meta(owner).version();
        String cursor = page(viewer, owner, version, 1, null).nextCursor();
        if (endpoint.equals("meta")) {
            doAnswer(call -> {
                Object data = call.callRealMethod();
                revokeInNewTransaction();
                return data;
            }).when(positions).findBounds(owner);
        } else if (endpoint.equals("tiles")) {
            doAnswer(call -> {
                Object data = call.callRealMethod();
                revokeInNewTransaction();
                return data;
            }).when(publicStars).findStarsInRange(eq(owner), any(), any(), anyInt());
        } else {
            doAnswer(call -> {
                Object data = call.callRealMethod();
                revokeInNewTransaction();
                return data;
            }).when(publicStars).findPlanets(owner, FIRST_TIC);
        }
        String suffix = switch (endpoint) {
            case "meta" -> "/sky";
            case "tiles" -> "/sky/tiles";
            default -> "/stars/" + FIRST_TIC;
        };
        mvc.perform(request(owner, suffix).param("version", version).session(session))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("PUBLIC_SKY_NOT_AVAILABLE"))
                .andExpect(header().string("Cache-Control", containsString("no-store")));
        assertFalse(jdbc.queryForObject("SELECT star_list_public FROM user_settings WHERE user_id=?", Boolean.class, owner));
        mvc.perform(request(owner, "/sky/tiles").param("version", version).param("limit", "1")
                        .param("cursor", cursor).session(session))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("PUBLIC_SKY_NOT_AVAILABLE"));
    }

    @Test
    void 기존_앱역할만으로_공개조회_SQL을_실행한다() throws Exception {
        unlock(owner, 2);
        long bundle = bundle(FIRST_TIC);
        long candidate = candidate(bundle, true, null);
        recognize(owner, candidate, "confirmed", submit(owner, bundle, candidate, "LIKELY_PLANET"));
        try (var connection = dataSource.getConnection()) {
            try (var sql = connection.createStatement()) { sql.execute("SET ROLE planetory_app"); }
            try {
                var appData = new SingleConnectionDataSource(connection, true);
                var appJdbc = JdbcClient.create(appData);
                var appPositions = new SkyRepository(appJdbc);
                var appStars = new StarRepository(appJdbc);
                var appPublicStars = new PublicSkyRepository(appJdbc);
                var appSky = new SkyService(appPositions, appStars, appJdbc, Clock.systemUTC(), skyProperties);
                var appPublic = new PublicSkyService(appSky, appPositions, appStars, appPublicStars,
                        new DataSourceTransactionManager(appData), Clock.systemUTC());
                assertEquals(2, appPublic.meta(owner).starCount());
                var tile = appPublic.tiles(viewer, owner, 2, X, Y, W, H, appPublic.meta(owner).version(), 1000, null);
                assertEquals(2, tile.rangeStarCount());
                assertEquals(1, tile.stars().getFirst().planetCount());
                assertEquals(1, appPublic.detail(owner, FIRST_TIC).planets().count());
            } finally {
                try (var sql = connection.createStatement()) { sql.execute("RESET ROLE"); }
            }
        }
    }

    @Test
    void 별5000_성과행성1000의_전체페이지와_상세가_일치한다() {
        unlock(owner, 5000);
        long bundle = bundle(FIRST_TIC);
        jdbc.update("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,period_days,"
                + "epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed)"
                + " SELECT ?,'active',?,1,1+n*0.01,1501,2.8,320,12.5,'{}'::jsonb,true,false"
                + " FROM generate_series(1,1000) n", FIRST_TIC, bundle);
        jdbc.update("INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,"
                + "removed_candidate_ids,submitted_period,phase_start,phase_end,fold_reference_time_btjd,"
                + "user_judgment,evidence_checks,match_result,matched_candidate_id,achievement_result,"
                + "residual_model_version,periodogram_config_version,rule_version)"
                + " SELECT ?,?,?,gen_random_uuid(),'candidate',0,'{}',period_days,0.1,0.2,1500.5,"
                + "'LIKELY_PLANET','[]'::jsonb,'matched',id,'recognized','rm-1','pg-1','rule-0'"
                + " FROM candidates WHERE updated_bundle_id=?", owner, FIRST_TIC, bundle, bundle);
        jdbc.update("INSERT INTO user_candidate_achievements(user_id,candidate_id,achievement_type,"
                + "recognized_submission_id,recognized_at)"
                + " SELECT user_id,matched_candidate_id,'unconfirmed',id,now() FROM submissions WHERE user_id=?", owner);
        var meta = publicSky.meta(owner);
        assertEquals(5000, meta.starCount());
        Set<String> seen = new HashSet<>();
        String cursor = null;
        int pages = 0;
        int planetCount = 0;
        do {
            var tile = page(viewer, owner, meta.version(), 1000, cursor);
            assertFalse(tile.versionChanged());
            assertEquals(5000, tile.rangeStarCount());
            for (var star : tile.stars()) {
                assertTrue(seen.add(star.ticId()));
                planetCount += star.planetCount();
            }
            cursor = tile.nextCursor();
            assertTrue(++pages <= 5);
        } while (cursor != null);
        var detail = publicSky.detail(owner, FIRST_TIC);
        assertEquals(5, pages);
        assertEquals(5000, seen.size());
        assertEquals(1000, planetCount);
        assertEquals(meta.version(), detail.version());
        assertEquals(1000, detail.planets().count());
        assertEquals(1000, detail.planets().items().stream().map(PublicSkyViews.Planet::candidateId).distinct().count());
    }

    private PublicSkyViews.Tile page(long reader, long target, String version, int limit, String cursor) {
        return publicSky.tiles(reader, target, 2, X, Y, W, H, version, limit, cursor);
    }

    private static void invalid(Runnable request) {
        assertEquals(ErrorCode.VALIDATION_FAILED,
                assertThrows(BusinessException.class, request::run).getErrorCode());
    }

    private MockHttpServletRequestBuilder request(long target, String suffix) {
        var request = get("/api/v1/members/u-" + target + suffix);
        if (suffix.equals("/sky/tiles")) request.param("level", "2").param("x", String.valueOf(X))
                .param("y", String.valueOf(Y)).param("w", String.valueOf(W)).param("h", String.valueOf(H));
        return request;
    }

    private static JsonNode response(ResultActions request) throws Exception {
        return JSON.readTree(request.andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andReturn().getResponse().getContentAsString());
    }

    private static void keys(JsonNode value, String... expected) {
        assertEquals(Set.of(expected), new HashSet<>(value.propertyNames()));
    }

    private void revokeInNewTransaction() {
        var tx = new TransactionTemplate(transactions);
        tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        tx.executeWithoutResult(status -> setPublic(owner, false));
    }

    private void setPublic(long target, boolean visible) {
        jdbc.update("INSERT INTO user_settings(user_id,star_list_public) VALUES (?,?)"
                + " ON CONFLICT (user_id) DO UPDATE SET star_list_public=EXCLUDED.star_list_public", target, visible);
    }

    private long member() {
        String id = UUID.randomUUID().toString();
        return jdbc.queryForObject("INSERT INTO users(provider,provider_user_id,nickname)"
                + " VALUES ('test',?,?) RETURNING id", Long.class, id, "n-" + id);
    }

    private MockHttpSession session(long member) {
        var request = new MockHttpServletRequest();
        sessions.login(members.requireActive(member), request, new MockHttpServletResponse());
        SecurityContextHolder.clearContext();
        return (MockHttpSession) request.getSession(false);
    }

    private void unlock(long member, int count) {
        if (count == 0) return;
        jdbc.update("INSERT INTO stars(tic_id,confirmed_count,service_status)"
                + " SELECT ? + n,0,'published' FROM generate_series(0,?::int-1) n ON CONFLICT DO NOTHING", FIRST_TIC, count);
        List<Object[]> rows = new ArrayList<>();
        for (int ordinal = 0; ordinal < count; ordinal++) {
            var p = layout.place(ordinal);
            // 배치 함수를 다시 돌리면 비교가 실패하도록 저장값에 고정 차이를 둔다.
            rows.add(new Object[] {member, FIRST_TIC + ordinal, p.depthZ(), p.worldX() + .125,
                    p.worldY() - .25, p.layoutVersion(), ordinal});
        }
        jdbc.batchUpdate("INSERT INTO star_unlocks(user_id,tic_id,unlock_reason,depth_z,unlocked_at,"
                + "world_x,world_y,layout_version,layout_ordinal) VALUES (?,?,'tutorial',?,now(),?,?,?,?)", rows);
    }

    private long bundle(long tic) {
        return jdbc.queryForObject("INSERT INTO publication_bundles(tic_id,bundle_version,status,manifest,"
                + "fold_reference_time_btjd,base_days) VALUES (?,?,'current',?::jsonb,1500.5,27.4) RETURNING id",
                Long.class, tic, "v-" + UUID.randomUUID(), MANIFEST);
    }

    private long candidate(long bundle, boolean confirmed, String disposition) {
        long id = jdbc.queryForObject("INSERT INTO candidates(tic_id,status,updated_bundle_id,removal_step,"
                + "period_days,epoch_btjd,duration_hours,depth_ppm,bls_power,transit_model,discoverable,is_confirmed)"
                + " VALUES (?,'active',?,1,3.37,1501,2.8,320,12.5,'{}'::jsonb,true,?) RETURNING id",
                Long.class, FIRST_TIC, bundle, confirmed);
        if (disposition != null) jdbc.update("INSERT INTO candidate_dispositions(candidate_id,disposition,"
                + "answer_class,rule_version,applied_at,source_refs) VALUES (?,?,'graded','rule-0',now(),'{}'::jsonb)", id, disposition);
        return id;
    }

    private long submit(long member, long bundle, long candidate, String judgment) {
        return jdbc.queryForObject("INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,"
                + "curve_step,removed_candidate_ids,submitted_period,phase_start,phase_end,fold_reference_time_btjd,"
                + "user_judgment,evidence_checks,match_result,matched_candidate_id,achievement_result,"
                + "residual_model_version,periodogram_config_version,rule_version)"
                + " VALUES (?,?,?,?::uuid,'candidate',0,'{}',3.37,0.1,0.2,1500.5,?,'[]'::jsonb,'matched',?,"
                + "'recognized','rm-1','pg-1','rule-0') RETURNING id",
                Long.class, member, FIRST_TIC, bundle, UUID.randomUUID().toString(), judgment, candidate);
    }

    private void recognize(long member, long candidate, String type, long submission) {
        jdbc.update("INSERT INTO user_candidate_achievements(user_id,candidate_id,achievement_type,"
                + "recognized_submission_id,recognized_at) VALUES (?,?,?,?,now())", member, candidate, type, submission);
    }
}
