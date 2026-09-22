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
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.InitialExplorationService;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyStar;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyTile;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 별 지도 타일 계약 [S15P21C206-136].
 *
 * <p>사례는 {@code docs/development/sky-reference/contracts.json}의 first-page·last-page·
 * overlapping-replay·empty-range·version-changed·invalid-cursor를 따른다.
 */
@ActiveProfiles("local")
@SpringBootTest
class SkyTilesTest {

    private static final String SCHEMA = "sky_test_" + UUID.randomUUID().toString().replace("-", "");

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

    @Autowired SkyService sky;
    @Autowired GalaxyLayout layout;
    @Autowired JdbcTemplate jdbc;
    @Autowired InitialExplorationService exploration;
    @Autowired TransactionTemplate transactions;

    private long memberId;
    private long otherMemberId;
    private String version;

    /** 참조 자료와 같은 범위: 10개 별을 넉넉한 상자로 덮는다. */
    private static final double BOX_X = -1600;
    private static final double BOX_Y = -1600;
    private static final double BOX_W = 3200;
    private static final double BOX_H = 3200;

    @BeforeEach
    void seedTwoAccounts() {
        memberId = createMemberWithStars(10);
        otherMemberId = createMemberWithStars(4);
        version = sky.version(memberId);
    }

    private long createMemberWithStars(int count) {
        String unique = UUID.randomUUID().toString();
        long id = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
        for (int ordinal = 0; ordinal < count; ordinal++) {
            long ticId = 900_000_001L + ordinal;
            jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                    + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", ticId);
            var position = layout.place(ordinal);
            jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z,"
                            + " unlocked_at, world_x, world_y, layout_version, layout_ordinal)"
                            + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                    id, ticId, position.depthZ(), position.worldX(), position.worldY(),
                    position.layoutVersion(), ordinal);
        }
        return id;
    }

    private SkyTile page(String cursor, int limit) {
        return sky.tiles(memberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H, version, limit, cursor);
    }

    // ---------- 4.1 위치 찾기 ----------

    /**
     * 위치 찾기는 <b>타일이 주는 좌표와 같은 값</b>이어야 한다. 둘이 다르면 목록에서 고른 별과
     * 지도에 그려진 별이 어긋난다.
     */
    @Test
    void 위치_찾기는_타일과_같은_좌표를_준다() {
        long ticId = 900_000_003L;
        var star = sky.tiles(memberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H, version, 1000, null)
                .stars().stream().filter(s -> s.ticId().equals(String.valueOf(ticId))).findFirst().orElseThrow();

        var located = sky.locate(memberId, ticId);

        assertEquals(star.x(), located.x());
        assertEquals(star.y(), located.y());
        assertEquals(star.depthZ(), located.depthZ());
        assertEquals(star.layoutOrdinal(), located.layoutOrdinal());
        assertEquals(sky.version(memberId), located.version());
        assertEquals(String.valueOf(ticId), located.ticId());
    }

    /** 경계 상자는 그 별이 든 타일 한 칸이다. 그대로 타일 조회에 넣으면 그 별이 와야 한다. */
    @Test
    void 경계_상자는_그_별이_든_타일_한_칸이다() {
        long ticId = 900_000_005L;
        var located = sky.locate(memberId, ticId);
        int tile = sky.tileSize();

        assertEquals(tile, located.bounds().w());
        assertEquals(tile, located.bounds().h());
        assertTrue(located.bounds().x() <= located.x() && located.x() < located.bounds().x() + tile,
                "x가 상자 밖이면 그 상자로 타일을 받아도 별이 오지 않는다");
        assertTrue(located.bounds().y() <= located.y() && located.y() < located.bounds().y() + tile);
        // 음수 좌표의 나머지는 -0.0이라 delta로 본다. 부호 있는 0을 가르는 것이 목적이 아니다.
        assertEquals(0.0, located.bounds().x() % tile, 0.0, "타일 격자에 맞춘다");
        assertEquals(0.0, located.bounds().y() % tile, 0.0);

        // 아직 받지 않은 범위라도 이 상자로 요청하면 그 별이 온다(완료 조건).
        var tiles = sky.tiles(memberId, located.level(), located.bounds().x(), located.bounds().y(),
                located.bounds().w(), located.bounds().h(), located.version(), 1000, null);
        assertTrue(tiles.stars().stream().anyMatch(s -> s.ticId().equals(String.valueOf(ticId))));
    }

    /** 기준 배율은 1.0이다. 카메라를 옮기는 조회라 가장 넓은 쪽도 좁은 쪽도 아니다. */
    @Test
    void 기준_배율_단계를_준다() {
        var located = sky.locate(memberId, 900_000_001L);

        double scale = sky.meta(memberId, false).zoomLevels().stream()
                .filter(zoom -> zoom.level() == located.level()).findFirst().orElseThrow().scale();
        assertEquals(1.0, scale);
    }

    /** 회원 경계. 남의 별은 발견하지 않은 별과 같다. */
    @Test
    void 발견하지_않은_별과_남의_별은_STAR_LOCKED다() {
        long othersOnly = 900_000_009L;
        assertEquals(10, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ?",
                Integer.class, memberId), "이 별은 내 것이고");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM star_unlocks WHERE user_id = ? "
                + "AND tic_id = ?", Integer.class, otherMemberId, othersOnly), "상대에게는 없다");

        for (long ticId : new long[] {123_456_789L, 900_000_099L}) {
            assertEquals(ErrorCode.STAR_LOCKED, assertThrows(BusinessException.class,
                    () -> sky.locate(memberId, ticId)).getErrorCode(), String.valueOf(ticId));
        }
        assertEquals(ErrorCode.STAR_LOCKED, assertThrows(BusinessException.class,
                () -> sky.locate(otherMemberId, othersOnly)).getErrorCode(),
                "남의 별을 위치로 찾을 수 없다");
    }

    /** first-page: 한 페이지만 받으면 범위가 아직 안 찼고 nextCursor가 있다. */
    @Test
    void 첫_페이지는_요청한_수만큼_주고_다음_커서를_준다() {
        SkyTile first = page(null, 6);

        assertEquals("individual-stars", first.representation());
        assertEquals(version, first.version());
        assertFalse(first.versionChanged());
        assertEquals(6, first.stars().size());
        assertNotNull(first.nextCursor(), "남은 별이 있으면 이어읽을 커서를 준다");
        assertTrue(first.stars().size() < first.rangeStarCount(), "아직 범위가 차지 않았다");
    }

    /** last-page: 페이지를 다 모으면 중복·누락 없이 rangeStarCount와 같다. */
    @Test
    void 페이지를_다_모으면_범위_수와_같고_중복이_없다() {
        List<String> collected = new ArrayList<>();
        String cursor = null;
        long rangeStarCount = -1;

        do {
            SkyTile tile = page(cursor, 6);
            rangeStarCount = tile.rangeStarCount();
            tile.stars().forEach(star -> collected.add(star.ticId()));
            cursor = tile.nextCursor();
        } while (cursor != null);

        assertEquals(10, collected.size());
        assertEquals(rangeStarCount, collected.size(), "최종 수가 rangeStarCount와 달라지면 계약 오류다");
        assertEquals(Set.copyOf(collected).size(), collected.size(), "TIC 중복이 없어야 한다");
    }

    /** overlapping-replay: 같은 버전에서 같은 요청을 되풀이해도 결과가 같다. */
    @Test
    void 같은_요청을_되풀이해도_같은_집합을_준다() {
        Set<String> first = new HashSet<>();
        Set<String> again = new HashSet<>();
        for (Set<String> into : List.of(first, again)) {
            String cursor = null;
            do {
                SkyTile tile = page(cursor, 4);
                tile.stars().forEach(star -> into.add(star.ticId()));
                cursor = tile.nextCursor();
            } while (cursor != null);
        }
        assertEquals(first, again);
        assertEquals(10, first.size());
    }

    /** empty-range: 별이 없는 범위는 정상 응답이며 계정이 빈 것이 아니다. */
    @Test
    void 별이_없는_범위는_빈_배열과_범위_수_0을_준다() {
        SkyTile tile = sky.tiles(memberId, 0, 40_000, 40_000, 50, 50, version, null, null);

        assertTrue(tile.stars().isEmpty());
        assertEquals(0, tile.rangeStarCount());
        assertNull(tile.nextCursor());
        assertFalse(tile.versionChanged());
        assertTrue(sky.meta(memberId, false).starCount() > 0, "계정 전체가 빈 것은 아니다");
    }

    /** version-changed: 이전 버전으로 요청하면 별을 주지 않고 재시작을 요구한다. */
    @Test
    void 버전이_달라지면_별_대신_재시작을_요구한다() {
        String stale = version;
        String bumped = sky.bumpVersion(memberId);
        assertNotEquals(stale, bumped);

        SkyTile tile = sky.tiles(memberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H, stale, null, null);

        assertTrue(tile.versionChanged());
        assertEquals(bumped, tile.version(), "응답에는 현재 버전을 담아 재조회를 유도한다");
        assertTrue(tile.stars().isEmpty());
        assertNull(tile.nextCursor());
        assertTrue(sky.meta(memberId, false).starCount() > 0, "빈 지도를 뜻하지 않는다");
    }

    /** invalid-cursor: 형식이 깨졌거나 다른 조건에 묶인 커서는 400이다. */
    @Test
    void 잘못된_커서는_거절한다() {
        assertThrows(BusinessException.class, () -> page("not-a-cursor", 6));

        String cursor = page(null, 6).nextCursor();
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 1, BOX_X, BOX_Y, BOX_W, BOX_H, version, 6, cursor),
                "다른 level의 커서를 쓸 수 없다");
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H, version, 5, cursor),
                "다른 limit의 커서를 쓸 수 없다");
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 0, 0, BOX_Y, BOX_W, BOX_H, version, 6, cursor),
                "다른 범위의 커서를 쓸 수 없다");
        assertThrows(BusinessException.class,
                () -> sky.tiles(otherMemberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H,
                        sky.version(otherMemberId), 6, cursor),
                "다른 회원의 커서를 쓸 수 없다");
    }

    /** 회원 격리: 다른 회원의 별은 어떤 응답에도 들어가지 않는다. */
    @Test
    void 다른_회원의_별은_범위와_페이지에_없다() {
        Set<Long> mine = new HashSet<>(jdbc.queryForList(
                "SELECT tic_id FROM star_unlocks WHERE user_id = ?", Long.class, memberId));

        SkyTile tile = page(null, 100);

        assertEquals(10, tile.rangeStarCount(), "다른 회원 별이 범위 수에 섞이면 안 된다");
        for (SkyStar star : tile.stars()) {
            assertTrue(mine.contains(Long.parseLong(star.ticId())), star.ticId());
        }
    }

    /** 저장한 좌표·순번을 그대로 돌려준다. 조회 때 배치를 다시 계산하지 않는다. */
    @Test
    void 저장한_좌표와_순번을_그대로_준다() {
        SkyTile tile = page(null, 100);

        for (SkyStar star : tile.stars()) {
            var stored = jdbc.queryForMap("SELECT world_x::float8 AS x, world_y::float8 AS y,"
                            + " depth_z::float8 AS z, layout_ordinal FROM star_unlocks"
                            + " WHERE user_id = ? AND tic_id = ?",
                    memberId, Long.parseLong(star.ticId()));
            assertEquals((Double) stored.get("x"), star.x());
            assertEquals((Double) stored.get("y"), star.y());
            assertEquals((Double) stored.get("z"), star.depthZ());
            assertEquals(stored.get("layout_ordinal"), star.layoutOrdinal());
        }
    }

    @Test
    void 경계_상자와_배율_단계를_검증한다() {
        int overLimit = sky.maxBox() + 1;
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 0, 0, 0, overLimit, 100, version, null, null));
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 0, 0, 0, 0, 100, version, null, null));
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 99, BOX_X, BOX_Y, BOX_W, BOX_H, version, null, null));
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H, version, 0, null));
        assertThrows(BusinessException.class,
                () -> sky.tiles(memberId, 0, BOX_X, BOX_Y, BOX_W, BOX_H, version,
                        SkyService.MAX_LIMIT + 1, null));
    }

    /** 응답 범위는 타일 격자에 맞춰 넓히고 모든 별이 그 안에 있다. */
    @Test
    void 응답_범위를_타일_격자에_맞춘다() {
        SkyTile tile = sky.tiles(memberId, 0, -1500, -1500, 3000, 3000, version, 100, null);

        // 음수 좌표의 나머지는 -0.0이 나올 수 있어 절댓값으로 본다.
        assertEquals(0.0, Math.abs(tile.bounds().x() % sky.tileSize()));
        assertEquals(0.0, Math.abs(tile.bounds().y() % sky.tileSize()));
        assertEquals(0.0, Math.abs(tile.bounds().w() % sky.tileSize()));
        assertTrue(tile.bounds().x() <= -1500 && tile.bounds().y() <= -1500, "요청 범위를 덮어야 한다");

        for (SkyStar star : tile.stars()) {
            assertTrue(star.x() >= tile.bounds().x()
                    && star.x() < tile.bounds().x() + tile.bounds().w(), star.ticId());
            assertTrue(star.y() >= tile.bounds().y()
                    && star.y() < tile.bounds().y() + tile.bounds().h(), star.ticId());
        }
    }

    /** 메타는 배치·연출 버전을 필수로 담는다. */
    @Test
    void 메타는_표현_구분값과_두_버전을_담는다() {
        var meta = sky.meta(memberId, true);

        assertEquals("individual-stars", meta.representation());
        assertEquals("personal-spiral-v1", meta.layoutVersion());
        assertEquals("personal-galaxy-v1", meta.presentationVersion());
        assertEquals(10, meta.starCount());
        assertEquals(sky.tileSize(), meta.tileSize());
        assertFalse(meta.zoomLevels().isEmpty());
        assertTrue(meta.firstVisit());
        assertEquals(List.of("900000001"), meta.centerTicIds());
        assertTrue(meta.bounds().minX() <= meta.bounds().maxX());
    }

    /**
     * 발견이 일어나면 지도 버전이 움직여야 한다(D-7). 버전이 그대로면 프론트가 새 별을
     * 받으러 오지 않는다.
     */
    @Test
    void 가입_시_첫_별_발견이_지도_버전을_올린다() {
        long ticId = 800_000_001L;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", ticId);
        jdbc.update("INSERT INTO tutorial_stars(seq, tic_id, intent, active)"
                + " VALUES (1, ?, 'deep_confirmed', true) ON CONFLICT (seq) DO NOTHING", ticId);

        String unique = UUID.randomUUID().toString();
        long newMemberId = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);

        String before = sky.version(newMemberId);
        transactions.executeWithoutResult(status -> exploration.initialize(newMemberId));
        String after = sky.version(newMemberId);

        assertNotEquals(before, after, "별이 열렸는데 버전이 그대로면 갱신을 알릴 수 없다");
        assertEquals(1, sky.meta(newMemberId, false).starCount());
    }

    /** 버전은 단조 증가해 같은 시각의 여러 변경도 구분한다. */
    @Test
    void 버전은_올릴_때마다_달라진다() {
        String first = sky.version(memberId);
        String second = sky.bumpVersion(memberId);
        String third = sky.bumpVersion(memberId);

        assertNotEquals(first, second);
        assertNotEquals(second, third);
        assertEquals(third, sky.version(memberId));
        assertNotEquals(third, sky.version(otherMemberId), "회원마다 따로 센다");
    }
}
