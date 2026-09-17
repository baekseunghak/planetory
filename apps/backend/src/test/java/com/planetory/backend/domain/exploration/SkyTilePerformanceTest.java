package com.planetory.backend.domain.exploration;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.planetory.backend.domain.exploration.service.GalaxyLayout;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews;
import com.planetory.backend.domain.exploration.service.SkyViews.Bounds;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyMeta;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyTile;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 10만 별 시드 타일 조회 비용 측정 [S15P21C206-137].
 *
 * <p>기본 {@code test}에서 제외하고 {@code ./gradlew perfTest}로 돌린다. 시드에 수 분이 걸린다.
 *
 * <p>시드는 {@code S15P21C206-215}(W18)와 같은 규격이다. 개별 별 100,000개와 계정 전체
 * 내 행성 항목 5,000개를 쓰고 신규 1개·500개·100,000개 세 단계를 잰다. 좌표는 실제 배치
 * 함수로 만든다. 나선팔은 균일 분포가 아니라서, 임의 좌표로 재면 인덱스 선택도가 실제와
 * 달라진다.
 *
 * <p>여기서 재는 것은 <b>서버 조회 비용</b>이다. 프레임·힙·GPU는 215번 몫이다.
 */
@Tag("perf")
@ActiveProfiles("local")
@SpringBootTest
class SkyTilePerformanceTest {

    private static final String SCHEMA =
            "sky_perf_" + UUID.randomUUID().toString().replace("-", "");

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
    @Autowired com.planetory.backend.domain.exploration.service.SkyRepository starsRepository;

    private static final ObjectMapper JSON = new ObjectMapper()
            .findAndRegisterModules();

    /** 215번과 맞춘 시드 단계. */
    private static final int[] SEEDS = {1, 500, 100_000};

    /** 계정 전체 내 행성 항목 수(215번 규격). */
    private static final int TOTAL_PLANET_ITEMS = 5_000;

    private static final long TIC_BASE = 1_000_000L;
    private static final int BATCH = 2_000;
    private static final int WARMUP = 5;
    private static final int ROUNDS = 50;

    /**
     * 인덱스 후보. 이름과 정의만 두고 판단은 측정에 맡긴다.
     *
     * <p>{@code world_x}·{@code world_y}가 NUMERIC이라 double 파라미터와 비교하면 열 쪽이
     * 캐스팅돼 일반 B-tree를 못 쓴다. 그래서 식 인덱스도 후보에 넣는다.
     */
    private static final List<String[]> INDEX_CANDIDATES = List.of(
            new String[]{"없음", null},
            new String[]{"(user_id, tic_id)",
                    "CREATE INDEX ix_probe ON star_unlocks (user_id, tic_id)"},
            new String[]{"(user_id, world_x, world_y)",
                    "CREATE INDEX ix_probe ON star_unlocks (user_id, world_x, world_y)"},
            new String[]{"(user_id, float8 식)",
                    "CREATE INDEX ix_probe ON star_unlocks"
                            + " (user_id, ((world_x)::float8), ((world_y)::float8))"},
            new String[]{"(user_id, float8 식, tic_id)",
                    "CREATE INDEX ix_probe ON star_unlocks"
                            + " (user_id, ((world_x)::float8), ((world_y)::float8), tic_id)"});

    /** 10만 시드에서 인덱스 후보별 비용을 비교한다. 추측으로 고르지 않는다. */
    @Test
    void 인덱스_후보별_조회_비용을_비교한다() {
        long memberId = seedMember(100_000);
        SkyMeta meta = sky.meta(memberId, false);
        List<Viewport> scenes = viewports(meta.bounds());

        System.out.println("\n=== 인덱스 후보 비교 · 별 100,000개 [S15P21C206-137] ===");
        for (String[] candidate : INDEX_CANDIDATES) {
            jdbc.execute("DROP INDEX IF EXISTS ix_probe");
            if (candidate[1] != null) {
                jdbc.execute(candidate[1]);
            }
            jdbc.execute("ANALYZE star_unlocks");

            System.out.printf("%n--- %s ---%n", candidate[0]);
            for (Viewport scene : scenes) {
                measure(memberId, meta.version(), scene);
            }
            explainPage(memberId, scenes.get(0));
        }
        jdbc.execute("DROP INDEX IF EXISTS ix_probe");
        System.out.println("\n=== 끝 ===\n");
    }

    @Test
    void 시드_단계별_타일_조회_비용을_기록한다() {
        System.out.println("\n=== 타일 조회 비용 [S15P21C206-137] ===");
        System.out.println(environment());

        for (int count : SEEDS) {
            long memberId = seedMember(count);
            SkyMeta meta = sky.meta(memberId, false);

            System.out.printf("%n--- 별 %,d개 · 경계 x[%.0f, %.0f] y[%.0f, %.0f] ---%n",
                    meta.starCount(), meta.bounds().minX(), meta.bounds().maxX(),
                    meta.bounds().minY(), meta.bounds().maxY());
            assertEquals(count, meta.starCount());

            for (Viewport viewport : viewports(meta.bounds())) {
                measure(memberId, meta.version(), viewport);
            }
            explainPage(memberId, viewports(meta.bounds()).get(0));
        }
        System.out.println("\n=== 끝 ===\n");
    }

    /**
     * 시작 배율을 정하려면 "상자를 줄이면 별이 얼마나 주는가"를 알아야 한다 [S15P21C206-137].
     *
     * <p>나선팔 코어가 조밀해서 단순 비례가 아니다. 중심과 코어 바깥을 함께 잰다.
     * 프론트(W05·215)가 첫 카메라를 어디에 얼마나 좁게 둘지 정하는 근거다.
     */
    @Test
    void 상자_크기별_별_수와_적재_시간을_잰다() {
        long memberId = seedMember(100_000);
        SkyMeta meta = sky.meta(memberId, false);
        double cx = (meta.bounds().minX() + meta.bounds().maxX()) / 2;
        double cy = (meta.bounds().minY() + meta.bounds().maxY()) / 2;
        double offX = cx + (meta.bounds().maxX() - cx) * 0.55;
        double offY = cy + (meta.bounds().maxY() - cy) * 0.55;

        System.out.println("\n=== 상자 크기별 비용 · 별 100,000개 [S15P21C206-137] ===");
        for (double[] origin : new double[][]{{cx, cy}, {offX, offY}}) {
            System.out.printf("%n--- %s ---%n", origin[0] == cx ? "중심" : "코어 바깥");
            for (int side : new int[]{512, 1024, 2048, 4096, 8192, 16384, 32768}) {
                Viewport v = box(String.valueOf(side),
                        origin[0] - side / 2.0, origin[1] - side / 2.0, side, side);
                Pages pages = drainAllPages(memberId, meta.version(), v);
                System.out.printf("  %,6d각 | 별 %,7d개 | %,3d페이지 | %,10d바이트 | 적재 %6.0fms%n",
                        side, pages.stars(), pages.pages(), pages.bytes(), ms(pages.elapsedNanos()));
            }
        }
        System.out.println("\n=== 끝 ===\n");
    }

    /**
     * 타일 한 변을 줄이면 코어에서 몇 개까지 내려가는지 [S15P21C206-137].
     *
     * <p>{@code TILE_SIZE}는 응답 범위의 최소 단위다. 512면 코어에서 아무리 좁게 요청해도
     * 512각을 받는다. 스냅을 거치지 않고 저장소에 직접 물어 "타일을 더 잘게 했을 때"를 잰다.
     *
     * <p>밀도가 균일하면 넓이에 비례해 줄겠지만 나선팔 코어는 봉우리라 그렇지 않다.
     */
    @Test
    void 타일_한_변을_줄이면_별_수가_얼마나_주는지_잰다() {
        long memberId = seedMember(100_000);
        SkyMeta meta = sky.meta(memberId, false);
        double cx = (meta.bounds().minX() + meta.bounds().maxX()) / 2;
        double cy = (meta.bounds().minY() + meta.bounds().maxY()) / 2;

        System.out.println("\n=== 타일 한 변별 코어 별 수 · 별 100,000개 [S15P21C206-137] ===");
        System.out.println("  (넓이 비례라면 한 변이 절반일 때 별도 1/4이 된다)");
        long previous = -1;
        for (int side : new int[]{512, 256, 128, 64, 32, 16}) {
            var bounds = new SkyViews.TileBounds(cx - side / 2.0, cy - side / 2.0, side, side);
            long count = starsRepository.countInRange(memberId, bounds);
            String ratio = previous < 0 ? "-" : String.format("이전의 %.0f%%", 100.0 * count / previous);
            System.out.printf("  %,5d각 | 별 %,7d개 | 추정 %,9d바이트 | %,3d페이지 | %s%n",
                    side, count, count * 221, (count + SkyService.MAX_LIMIT - 1) / SkyService.MAX_LIMIT,
                    ratio);
            previous = count;
        }
        System.out.println("\n=== 끝 ===\n");
    }

    /** 카메라 장면 네 가지(215번 기준). 실제 경계에서 만들어 시드 크기에 따라 함께 움직인다. */
    private List<Viewport> viewports(Bounds bounds) {
        double width = Math.max(bounds.maxX() - bounds.minX(), 1);
        double height = Math.max(bounds.maxY() - bounds.minY(), 1);
        double centerX = (bounds.minX() + bounds.maxX()) / 2;
        double centerY = (bounds.minY() + bounds.maxY()) / 2;
        double max = sky.maxBox();

        return List.of(
                // 최대 축소: 허용 상한. 지도가 이보다 넓으면 한 요청으로 못 덮는다.
                box("최대 축소", centerX - max / 2, centerY - max / 2, max, max),
                // 홈: 전체의 절반쯤 보이는 초기 화면
                box("홈", centerX - width / 4, centerY - height / 4,
                        Math.min(width / 2, max), Math.min(height / 2, max)),
                // 확대 이동: 중심에서 벗어난 작은 창
                box("확대 이동", centerX + width / 8, centerY + height / 8,
                        Math.min(width / 16, max), Math.min(height / 16, max)),
                // 선택: 별 하나를 고른 근접 뷰
                box("선택", centerX - 256, centerY - 256, 512, 512));
    }

    private Viewport box(String name, double x, double y, double w, double h) {
        return new Viewport(name, x, y, Math.max(w, 1), Math.max(h, 1));
    }

    private void measure(long memberId, String version, Viewport v) {
        for (int i = 0; i < WARMUP; i++) {
            sky.tiles(memberId, 2, v.x(), v.y(), v.w(), v.h(), version, SkyService.MAX_LIMIT, null);
        }

        long[] elapsed = new long[ROUNDS];
        SkyTile first = null;
        for (int i = 0; i < ROUNDS; i++) {
            long start = System.nanoTime();
            SkyTile tile = sky.tiles(memberId, 2, v.x(), v.y(), v.w(), v.h(),
                    version, SkyService.MAX_LIMIT, null);
            elapsed[i] = System.nanoTime() - start;
            if (first == null) {
                first = tile;
            }
        }
        java.util.Arrays.sort(elapsed);

        // 전체 호출의 어느 부분이 비용인지 나눠 잰다. 페이지 질의와 범위 수 집계는
        // 인덱스가 듣는 방식이 달라서 합쳐 재면 판단을 못 한다.
        var bounds = first.bounds();   // 응답이 이미 격자에 맞춘 범위를 담고 있다
        long[] pageOnly = new long[ROUNDS];
        long[] countOnly = new long[ROUNDS];
        for (int i = 0; i < ROUNDS; i++) {
            long t0 = System.nanoTime();
            starsRepository.findStarsInRange(memberId, bounds, null, SkyService.MAX_LIMIT + 1);
            long t1 = System.nanoTime();
            starsRepository.countInRange(memberId, bounds);
            long t2 = System.nanoTime();
            pageOnly[i] = t1 - t0;
            countOnly[i] = t2 - t1;
        }
        java.util.Arrays.sort(pageOnly);
        java.util.Arrays.sort(countOnly);

        Pages pages = drainAllPages(memberId, version, v);
        assertEquals(first.rangeStarCount(), pages.stars(),
                "전체 페이지를 모은 수가 범위 수와 같아야 한다");

        System.out.printf(
                "  %-10s 범위 %,10d개 | 전체 p95 %6.1fms"
                        + " = 페이지 %6.1f + 범위수 %6.1f + 나머지 %6.1f"
                        + " | 전체 %,3d페이지 %,9d바이트 적재 %6.0fms%n",
                v.name(), first.rangeStarCount(),
                ms(elapsed[(int) (ROUNDS * 0.95)]),
                ms(pageOnly[(int) (ROUNDS * 0.95)]), ms(countOnly[(int) (ROUNDS * 0.95)]),
                ms(elapsed[(int) (ROUNDS * 0.95)] - pageOnly[(int) (ROUNDS * 0.95)]
                        - countOnly[(int) (ROUNDS * 0.95)]),
                pages.pages(), pages.bytes(), ms(pages.elapsedNanos()));
    }

    /** 가시 범위를 끝까지 받아 전송량을 잰다. 프론트는 이걸 다 받아야 화면이 완성된다. */
    private Pages drainAllPages(long memberId, String version, Viewport v) {
        int pages = 0;
        long stars = 0;
        long bytes = 0;
        String cursor = null;
        long started = System.nanoTime();
        do {
            SkyTile tile = sky.tiles(memberId, 2, v.x(), v.y(), v.w(), v.h(),
                    version, SkyService.MAX_LIMIT, cursor);
            assertFalse(tile.versionChanged(), "측정 중 버전이 바뀌면 안 된다");
            pages++;
            stars += tile.stars().size();
            bytes += serializedBytes(tile);
            cursor = tile.nextCursor();
        } while (cursor != null);
        return new Pages(pages, stars, bytes, System.nanoTime() - started);
    }

    private long serializedBytes(SkyTile tile) {
        try {
            return JSON.writeValueAsBytes(tile).length;
        } catch (Exception e) {
            throw new IllegalStateException("타일 응답을 직렬화하지 못했다", e);
        }
    }

    /**
     * 실제 조회와 같은 모양의 계획을 남긴다.
     *
     * <p>{@code SkyRepository.findStarsInRange}의 WHERE·ORDER·LIMIT을 옮긴 것이다.
     * 저장소 질의를 바꾸면 여기도 같이 고친다.
     */
    private void explainPage(long memberId, Viewport v) {
        List<String> plan = jdbc.queryForList("""
                EXPLAIN (ANALYZE, BUFFERS, SUMMARY)
                SELECT u.tic_id, u.world_x, u.world_y, u.depth_z, u.layout_ordinal
                  FROM star_unlocks u
                 WHERE u.user_id = ?
                   AND u.world_x >= ? AND u.world_x < ?
                   AND u.world_y >= ? AND u.world_y < ?
                 ORDER BY u.tic_id
                 LIMIT ?
                """, String.class, memberId, v.x(), v.x() + v.w(), v.y(), v.y() + v.h(),
                SkyService.MAX_LIMIT + 1);
        System.out.println("  [실행 계획 · " + v.name() + "]");
        plan.forEach(line -> System.out.println("    " + line));
    }

    // ---------- 시드 ----------

    private long seedMember(int count) {
        String unique = UUID.randomUUID().toString();
        long memberId = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);

        insertStars(count);
        insertUnlocks(memberId, count);
        insertPlanetItems(memberId, count);
        jdbc.execute("ANALYZE star_unlocks");
        return memberId;
    }

    /** 별 카탈로그는 회원 사이에 공유된다. 이미 있으면 건너뛴다. */
    private void insertStars(int count) {
        batched(count, "INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING",
                (ps, i) -> ps.setLong(1, TIC_BASE + i));
    }

    private void insertUnlocks(long memberId, int count) {
        batched(count, "INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z,"
                + " unlocked_at, world_x, world_y, layout_version, layout_ordinal)"
                + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                (ps, i) -> {
                    var position = layout.place(i);
                    ps.setLong(1, memberId);
                    ps.setLong(2, TIC_BASE + i);
                    ps.setDouble(3, position.depthZ());
                    ps.setDouble(4, position.worldX());
                    ps.setDouble(5, position.worldY());
                    ps.setString(6, position.layoutVersion());
                    ps.setInt(7, i);
                });
    }

    /**
     * 계정 전체 내 행성 항목 5,000개를 별에 나눠 담는다. 별이 5,000개보다 적으면 한 별에
     * 여러 개가 몰린다(215번의 "가장 많은 행성의 별" 장면).
     */
    private void insertPlanetItems(long memberId, int count) {
        int perStar = Math.max(1, TOTAL_PLANET_ITEMS / Math.max(count, 1));
        int starsWithPlanets = Math.min(count, TOTAL_PLANET_ITEMS);
        batched(starsWithPlanets, "INSERT INTO user_star_progress(user_id, tic_id, planet_count,"
                + " progress_stage) VALUES (?, ?, ?, 'in_progress')"
                + " ON CONFLICT (user_id, tic_id) DO NOTHING",
                (ps, i) -> {
                    ps.setLong(1, memberId);
                    ps.setLong(2, TIC_BASE + i);
                    ps.setInt(3, perStar);
                });
    }

    private interface RowSetter {
        void set(java.sql.PreparedStatement ps, int index) throws java.sql.SQLException;
    }

    private void batched(int total, String sql, RowSetter setter) {
        for (int offset = 0; offset < total; offset += BATCH) {
            int size = Math.min(BATCH, total - offset);
            int base = offset;
            jdbc.batchUpdate(sql, new BatchPreparedStatementSetter() {
                @Override
                public void setValues(java.sql.PreparedStatement ps, int i) throws java.sql.SQLException {
                    setter.set(ps, base + i);
                }

                @Override
                public int getBatchSize() {
                    return size;
                }
            });
        }
    }

    private String environment() {
        String db = jdbc.queryForObject("SELECT version()", String.class);
        List<String> indexes = new ArrayList<>(jdbc.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE tablename = 'star_unlocks'"
                        + " AND schemaname = current_schema()", String.class));
        return "DB: " + db
                + "\nJVM: " + System.getProperty("java.version")
                + "\nstar_unlocks 인덱스:\n  " + String.join("\n  ", indexes);
    }

    private static double ms(long nanos) {
        return nanos / 1_000_000.0;
    }

    private record Viewport(String name, double x, double y, double w, double h) {
    }

    private record Pages(int pages, long stars, long bytes, long elapsedNanos) {
    }
}
