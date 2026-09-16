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

    /** 카메라 장면 네 가지(215번 기준). 실제 경계에서 만들어 시드 크기에 따라 함께 움직인다. */
    private List<Viewport> viewports(Bounds bounds) {
        double width = Math.max(bounds.maxX() - bounds.minX(), 1);
        double height = Math.max(bounds.maxY() - bounds.minY(), 1);
        double centerX = (bounds.minX() + bounds.maxX()) / 2;
        double centerY = (bounds.minY() + bounds.maxY()) / 2;
        double max = SkyService.MAX_BOX;

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

        Pages pages = drainAllPages(memberId, version, v);
        assertEquals(first.rangeStarCount(), pages.stars(),
                "전체 페이지를 모은 수가 범위 수와 같아야 한다");

        System.out.printf(
                "  %-10s 범위 %,10d개 | 첫 페이지 p50 %6.1fms p95 %6.1fms 최악 %6.1fms"
                        + " | 전체 %,3d페이지 %,9d바이트%n",
                v.name(), first.rangeStarCount(),
                ms(elapsed[ROUNDS / 2]), ms(elapsed[(int) (ROUNDS * 0.95)]), ms(elapsed[ROUNDS - 1]),
                pages.pages(), pages.bytes());
    }

    /** 가시 범위를 끝까지 받아 전송량을 잰다. 프론트는 이걸 다 받아야 화면이 완성된다. */
    private Pages drainAllPages(long memberId, String version, Viewport v) {
        int pages = 0;
        long stars = 0;
        long bytes = 0;
        String cursor = null;
        do {
            SkyTile tile = sky.tiles(memberId, 2, v.x(), v.y(), v.w(), v.h(),
                    version, SkyService.MAX_LIMIT, cursor);
            assertFalse(tile.versionChanged(), "측정 중 버전이 바뀌면 안 된다");
            pages++;
            stars += tile.stars().size();
            bytes += serializedBytes(tile);
            cursor = tile.nextCursor();
        } while (cursor != null);
        return new Pages(pages, stars, bytes);
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

    private record Pages(int pages, long stars, long bytes) {
    }
}
