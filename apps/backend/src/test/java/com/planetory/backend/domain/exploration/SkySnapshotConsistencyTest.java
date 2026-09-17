package com.planetory.backend.domain.exploration;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
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
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyTile;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 타일 응답의 스냅샷 일관성 [S15P21C206-137].
 *
 * <p>완료 조건은 "같은 version·요청 범위의 전체 페이지에서 최종 개별 별 수가
 * {@code rangeStarCount}와 일치한다"이다. 프론트는 그 수로 적재 완료를 판단하므로,
 * 어긋나면 영원히 기다리거나 덜 받은 채로 끝난다.
 *
 * <p>실행마다 별도 스키마를 만들고 끝나면 지운다.
 */
@ActiveProfiles("local")
@SpringBootTest
class SkySnapshotConsistencyTest {

    private static final String SCHEMA =
            "sky_snapshot_test_" + UUID.randomUUID().toString().replace("-", "");

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

    /** 허용 상한과 같은 상자. 한 페이지로 다 받아 페이지 합과 범위 수를 바로 비교한다. */
    private double box;
    private double origin;

    private static final int SEEDED = 50;
    private static final int READS = 400;

    private long memberId;
    private final AtomicInteger nextOrdinal = new AtomicInteger(SEEDED);

    @BeforeEach
    void seedOneAccount() {
        box = sky.maxBox();
        origin = -box / 2;
        String unique = UUID.randomUUID().toString();
        memberId = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
        for (int ordinal = 0; ordinal < SEEDED; ordinal++) {
            insertDiscovery(ordinal);
        }
    }

    /**
     * 읽는 도중 발견이 들어와도 한 응답 안의 별 수와 범위 수는 어긋나지 않는다.
     *
     * <p>고치기 전에는 버전·페이지·범위 수를 문장마다 다른 스냅샷에서 읽었다. 페이지를 읽은 뒤
     * 범위 수를 읽기 전에 발견이 커밋되면, 마지막 페이지인데도 {@code rangeStarCount}가 하나 더
     * 크게 나온다. 창이 좁아서 한 번으로는 잘 안 걸리므로 여러 번 읽는다.
     */
    @Test
    void 읽는_도중_발견이_들어와도_별_수와_범위_수가_어긋나지_않는다() throws Exception {
        var writerRunning = new AtomicBoolean(true);
        var writerReady = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();

        Future<Integer> writes = pool.submit(() -> {
            writerReady.countDown();
            int inserted = 0;
            while (writerRunning.get()) {
                insertDiscovery(nextOrdinal.getAndIncrement());
                sky.bumpVersion(memberId);
                inserted++;
            }
            return inserted;
        });

        try {
            writerReady.await();
            int compared = 0;
            for (int i = 0; i < READS; i++) {
                // 실제 프론트와 같은 순서: 현재 버전을 받고 그 버전으로 범위를 요청한다.
                String version = sky.version(memberId);
                SkyTile tile = sky.tiles(memberId, 2, origin, origin, box, box,
                        version, SkyService.MAX_LIMIT, null);

                if (tile.versionChanged()) {
                    continue;   // 버전이 움직였으면 별을 주지 않는 정상 경로다
                }
                assertNull(tile.nextCursor(), "상한 limit이면 한 페이지로 끝나야 한다");
                assertEquals(tile.rangeStarCount(), tile.stars().size(),
                        "마지막 페이지인데 범위 수가 다르면 프론트가 적재 완료를 판단할 수 없다");
                compared++;
            }
            assertTrue(compared > 0, "버전 변경만 반복돼 정작 비교를 못 했다");
        } finally {
            writerRunning.set(false);
            pool.shutdown();
            assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS), "쓰기 스레드가 끝나지 않았다");
        }

        assertTrue(writes.get() > 0, "쓰기가 한 건도 없으면 경합을 만들지 못한 것이다");
    }

    /** 메타의 별 수와 경계도 한 스냅샷에서 나온다. 경계 밖 별이 있으면 카메라가 못 따라간다. */
    @Test
    void 메타의_별_수와_경계는_서로_맞는다() {
        var meta = sky.meta(memberId, false);

        assertEquals(SEEDED, meta.starCount());
        assertTrue(meta.bounds().minX() <= meta.bounds().maxX());
        assertTrue(meta.bounds().minY() <= meta.bounds().maxY());

        SkyTile whole = sky.tiles(memberId, 2, origin, origin, box, box,
                meta.version(), SkyService.MAX_LIMIT, null);
        assertFalse(whole.versionChanged());
        assertEquals(meta.starCount(), whole.rangeStarCount(),
                "전체를 덮는 상자의 범위 수는 메타의 별 수와 같아야 한다");
    }

    private void insertDiscovery(int ordinal) {
        long ticId = 900_000_001L + ordinal;
        jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", ticId);
        var position = layout.place(ordinal);
        jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z,"
                        + " unlocked_at, world_x, world_y, layout_version, layout_ordinal)"
                        + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)"
                        + " ON CONFLICT (user_id, tic_id) DO NOTHING",
                memberId, ticId, position.depthZ(), position.worldX(), position.worldY(),
                position.layoutVersion(), ordinal);
    }
}
