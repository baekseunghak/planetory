package com.planetory.backend.global.error;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** details는 최상위에 펼쳐지므로 기존 필드와 이름이 겹치면 안 된다 [S15P21C206-140]. */
class ErrorResponseDetailsTest {

    @Test
    void 최상위_필드와_같은_이름은_details에_넣을_수_없다() {
        for (String reserved : List.of("code", "message", "fieldErrors")) {
            assertThrows(IllegalArgumentException.class,
                    () -> new ErrorResponse("BUNDLE_CHANGED", "m", List.of(), Map.of(reserved, "x")),
                    reserved + "가 거절되지 않았다");
        }
    }

    @Test
    void 겹치지_않는_추가_필드는_그대로_담긴다() {
        ErrorResponse response = new ErrorResponse("BUNDLE_CHANGED", "m", List.of(),
                Map.of("currentBundleId", "b-3"));
        assertEquals(Map.of("currentBundleId", "b-3"), response.details());
    }

    @Test
    void 추가_필드가_없으면_빈_맵이다() {
        assertEquals(Map.of(), ErrorResponse.of(ErrorCode.STAR_NOT_PUBLISHED).details());
    }
}
