package com.planetory.backend.domain.exploration;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.planetory.backend.domain.exploration.service.GalaxyLayout.StarPosition;
import com.planetory.backend.domain.exploration.service.PersonalSpiralGalaxyLayout;

import static org.junit.jupiter.api.Assertions.*;

/**
 * `personal-spiral-v1` 배치 이식 검증 [S15P21C206-136].
 *
 * <p>정답은 {@code docs/development/sky-reference}다. 이 테스트는 Java 이식이 그 참조 구현과
 * 같은 좌표를 내는지 벡터로 대조한다. 허용 오차도 그 자료의 값을 그대로 읽는다.
 */
class PersonalSpiralGalaxyLayoutTest {

    private static final Path REFERENCE =
            Path.of("../../docs/development/sky-reference/vectors.json");

    private static JsonNode vectors;
    private static double positionTolerance;
    private static double depthTolerance;

    private final PersonalSpiralGalaxyLayout layout = new PersonalSpiralGalaxyLayout();

    @BeforeAll
    static void readReference() throws IOException {
        assertTrue(Files.exists(REFERENCE),
                "참조 자료가 없으면 이 이식을 검증할 수 없다: " + REFERENCE.toAbsolutePath().normalize());
        JsonNode root = new ObjectMapper().readTree(Files.readString(REFERENCE));
        vectors = root.get("vectors");
        positionTolerance = root.get("tolerance").get("position").asDouble();
        depthTolerance = root.get("tolerance").get("depth").asDouble();
    }

    @Test
    void 참조_자료와_같은_배치_버전을_쓴다() throws IOException {
        JsonNode root = new ObjectMapper().readTree(Files.readString(REFERENCE));
        assertEquals(root.get("layoutVersion").asText(), PersonalSpiralGalaxyLayout.LAYOUT_VERSION);
    }

    /** 12개 벡터는 중앙부·나선 팔·고정 앵커·큰 순번을 모두 지난다. */
    @Test
    void 참조_벡터의_좌표를_허용_오차_안에서_재현한다() {
        assertTrue(vectors.size() >= 12, "벡터가 줄었으면 참조 자료 변경을 먼저 확인한다");

        for (JsonNode vector : vectors) {
            int ordinal = vector.get("layoutOrdinal").asInt();
            StarPosition actual = layout.place(ordinal);

            assertEquals(vector.get("x").asDouble(), actual.worldX(), positionTolerance,
                    "layoutOrdinal=" + ordinal + " 의 x");
            assertEquals(vector.get("y").asDouble(), actual.worldY(), positionTolerance,
                    "layoutOrdinal=" + ordinal + " 의 y");
            assertEquals(vector.get("depthZ").asDouble(), actual.depthZ(), depthTolerance,
                    "layoutOrdinal=" + ordinal + " 의 depthZ");
        }
    }

    /** 재처리·재현이 성립하려면 같은 순번이 항상 같은 좌표여야 한다. */
    @Test
    void 같은_순번은_항상_같은_좌표를_준다() {
        for (int ordinal : List.of(0, 6, 7, 42, 999, 99_999)) {
            StarPosition first = layout.place(ordinal);
            StarPosition again = new PersonalSpiralGalaxyLayout().place(ordinal);

            assertEquals(first.worldX(), again.worldX());
            assertEquals(first.worldY(), again.worldY());
            assertEquals(first.depthZ(), again.depthZ());
            assertEquals(first.layoutVersion(), again.layoutVersion());
        }
    }

    @Test
    void 앞선_여섯_순번은_시제품_좌표에_고정된다() {
        // 나머지 순번과 달리 난수에서 나오지 않는다.
        assertEquals(760, layout.place(0).worldX());
        assertEquals(430, layout.place(0).worldY());
        assertEquals(-200, layout.place(5).worldX());
        assertEquals(-540, layout.place(5).worldY());
        assertNotEquals(0, layout.place(6).worldX(), "일곱 번째부터는 계산값이어야 한다");
    }

    /** 깊이는 정규화 값이라 범위를 벗어나면 프론트 투영이 깨진다. */
    @Test
    void 깊이는_항상_정규화_범위_안이다() {
        for (int ordinal = 0; ordinal < 5_000; ordinal++) {
            double depth = layout.place(ordinal).depthZ();
            assertTrue(depth >= -1 && depth <= 1, "layoutOrdinal=" + ordinal + " depthZ=" + depth);
        }
    }

    @Test
    void 좌표가_서로_충분히_흩어진다() {
        Set<String> seen = new HashSet<>();
        for (int ordinal = 0; ordinal < 1_000; ordinal++) {
            StarPosition position = layout.place(ordinal);
            assertTrue(Double.isFinite(position.worldX()) && Double.isFinite(position.worldY()));
            seen.add(position.worldX() + ":" + position.worldY());
        }
        assertEquals(1_000, seen.size(), "같은 자리에 두 별이 놓이면 안 된다");
    }

    @Test
    void 음수_순번은_거절한다() {
        assertThrows(IllegalArgumentException.class, () -> layout.place(-1));
    }
}
