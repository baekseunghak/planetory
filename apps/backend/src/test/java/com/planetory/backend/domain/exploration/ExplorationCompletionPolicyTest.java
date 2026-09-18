package com.planetory.backend.domain.exploration;

import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import com.planetory.backend.domain.exploration.service.ExplorationCompletionPolicy;
import com.planetory.backend.domain.exploration.service.ExplorationCompletionPolicy.Decision;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ExplorationCompletionPolicyTest {

    @ParameterizedTest(name = "active={0}, discoverableUnmatched={1}, undiscoverableUnmatched={2} -> {3}")
    @MethodSource("cases")
    void 후보_조합으로_완료와_재개_대기를_판정한다(int active, int discoverableUnmatched,
                                                   int undiscoverableUnmatched, Decision expected) {
        assertEquals(expected,
                ExplorationCompletionPolicy.decide(active, discoverableUnmatched, undiscoverableUnmatched));
    }

    private static Stream<Arguments> cases() {
        return Stream.of(
                Arguments.of(0, 0, 0, Decision.NOT_APPLICABLE),
                Arguments.of(1, 1, 0, Decision.KEEP_IN_PROGRESS),
                Arguments.of(3, 1, 1, Decision.KEEP_IN_PROGRESS),
                Arguments.of(2, 0, 0, Decision.COMPLETE_ALL_FOUND),
                Arguments.of(1, 0, 1, Decision.COMPLETE_UNDISCOVERABLE_ONLY),
                Arguments.of(3, 0, 2, Decision.COMPLETE_UNDISCOVERABLE_ONLY));
    }

    @Test
    void 모순된_후보_개수는_거절한다() {
        assertThrows(IllegalArgumentException.class,
                () -> ExplorationCompletionPolicy.decide(-1, 0, 0));
        assertThrows(IllegalArgumentException.class,
                () -> ExplorationCompletionPolicy.decide(1, 1, 1));
    }
}
