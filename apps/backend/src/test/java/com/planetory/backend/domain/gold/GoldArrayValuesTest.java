package com.planetory.backend.domain.gold;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 조회 모델의 Gold 배열 값 검사 [S15P21C206-140].
 *
 * <p>V10 CHECK가 적재를 막으므로 DB에 틀린 값을 넣어 조회 경로로 시험할 수 없다. 검사 자체를 직접 본다.
 * DB 제약은 {@link GoldCatalogSchemaTest}가 본다.
 */
class GoldArrayValuesTest {

    @Test
    void 곡선은_유한수와_빈_bin의_NULL을_그대로_준다() {
        Float[] flux = {1.0f, null, 0.98f};

        assertSame(flux, GoldCatalogRepository.requireContractValues("flux", flux, true));
    }

    @Test
    void NaN이나_무한대는_곡선에서도_거절한다() {
        for (Float bad : new Float[] {Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY}) {
            IllegalStateException e = assertThrows(IllegalStateException.class,
                    () -> GoldCatalogRepository.requireContractValues("flux", new Float[] {1.0f, bad}, true),
                    bad + "는 거절해야 한다");
            assertTrue(e.getMessage().contains("flux[1]"), e.getMessage());
        }
    }

    /** 주기도는 격자 전 점에 값이 있어야 한다. 빈 칸은 곡선에만 있다. */
    @Test
    void 주기도는_NULL도_거절한다() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> GoldCatalogRepository.requireContractValues("power", new Float[] {0.1f, null}, false));

        assertTrue(e.getMessage().contains("power[1]"), e.getMessage());
    }
}
