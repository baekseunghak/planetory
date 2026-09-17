package com.planetory.backend.domain.exploration;

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
import com.planetory.backend.domain.exploration.service.SkyProperties;
import com.planetory.backend.domain.exploration.service.SkyService;
import com.planetory.backend.global.error.BusinessException;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 전송 규격 설정이 실제로 먹는지 [S15P21C206-137].
 *
 * <p>값을 설정으로 빼놓고 동작이 안 바뀌면 뺀 의미가 없다. 기본값(512)이 아닌 값을 주고
 * 응답 범위와 상한이 따라 움직이는지 확인한다.
 */
@ActiveProfiles("local")
@SpringBootTest(properties = {
        "planetory.sky.tile-size=128",
        "planetory.sky.max-box=8192"
})
class SkyPropertiesTest {

    private static final String SCHEMA =
            "sky_props_" + UUID.randomUUID().toString().replace("-", "");

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

    private long memberId;

    @BeforeEach
    void seedOneAccount() {
        String unique = UUID.randomUUID().toString();
        memberId = jdbc.queryForObject("INSERT INTO users(provider, provider_user_id, nickname)"
                + " VALUES ('test', ?, ?) RETURNING id", Long.class, unique, "n-" + unique);
        for (int ordinal = 0; ordinal < 5; ordinal++) {
            long ticId = 900_000_001L + ordinal;
            jdbc.update("INSERT INTO stars(tic_id, confirmed_count, service_status)"
                    + " VALUES (?, 0, 'published') ON CONFLICT DO NOTHING", ticId);
            var position = layout.place(ordinal);
            jdbc.update("INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, depth_z,"
                            + " unlocked_at, world_x, world_y, layout_version, layout_ordinal)"
                            + " VALUES (?, ?, 'tutorial', ?, now(), ?, ?, ?, ?)",
                    memberId, ticId, position.depthZ(), position.worldX(), position.worldY(),
                    position.layoutVersion(), ordinal);
        }
    }

    /** 설정한 타일 한 변이 메타와 실제 응답 범위에 함께 반영된다. */
    @Test
    void 설정한_타일_한_변으로_응답_범위가_맞춰진다() {
        assertEquals(128, sky.tileSize(), "설정값이 서비스에 들어와야 한다");
        assertEquals(128, sky.meta(memberId, false).tileSize(), "메타가 설정값을 알려야 한다");

        // 기본값 512였다면 격자에 걸리지 않을 요청이다.
        var tile = sky.tiles(memberId, 2, -300, -300, 600, 600,
                sky.version(memberId), 100, null);

        assertEquals(0.0, Math.abs(tile.bounds().x() % 128), "왼쪽 경계가 128 격자에 맞아야 한다");
        assertEquals(0.0, Math.abs(tile.bounds().y() % 128));
        assertEquals(0.0, Math.abs(tile.bounds().w() % 128));
        assertNotEquals(0.0, Math.abs(tile.bounds().x() % 512),
                "512 격자에도 맞으면 설정이 먹었는지 구분할 수 없다");
    }

    /** 상한도 설정을 따른다. 예전 기본값(32768)은 이제 거절돼야 한다. */
    @Test
    void 설정한_상한을_넘는_요청은_거절된다() {
        assertEquals(8192, sky.maxBox());

        assertDoesNotThrow(() -> sky.tiles(memberId, 2, 0, 0, 8192, 8192,
                sky.version(memberId), 100, null), "상한과 같은 크기는 통과한다");

        assertThrows(BusinessException.class, () -> sky.tiles(memberId, 2, 0, 0, 8193, 8192,
                sky.version(memberId), 100, null));
        assertThrows(BusinessException.class, () -> sky.tiles(memberId, 2, 0, 0, 32768, 32768,
                sky.version(memberId), 100, null), "예전 기본값이 그대로 통과하면 설정이 안 먹은 것이다");
    }

    /** 기동 때 잡아야 하는 조합. 서비스가 뜬 뒤 이상한 범위를 내보내는 것보다 낫다. */
    @Test
    void 성립하지_않는_조합은_만들_때_거절된다() {
        assertThrows(IllegalArgumentException.class, () -> new SkyProperties(0, 8192),
                "타일 한 변이 0이면 격자를 만들 수 없다");
        assertThrows(IllegalArgumentException.class, () -> new SkyProperties(512, 256),
                "상한이 타일보다 작으면 어떤 요청도 통과하지 못한다");
        assertThrows(IllegalArgumentException.class, () -> new SkyProperties(512, 1000),
                "상한이 격자의 배수가 아니면 상한 크기 요청이 스냅 뒤 상한을 넘는다");

        assertDoesNotThrow(() -> new SkyProperties(512, 32768));
        assertDoesNotThrow(() -> new SkyProperties(128, 8192));
    }
}
