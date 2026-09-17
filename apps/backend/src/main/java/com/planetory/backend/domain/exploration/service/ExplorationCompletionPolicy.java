package com.planetory.backend.domain.exploration.service;

/**
 * 현재 판의 활성 후보와 회원의 누적 매칭으로 별 탐색 완료를 판정한다 [S15P21C206-149].
 *
 * <p>판단 정오·성과·공개 여부는 입력이 아니다. 후보를 수치적으로 매칭했는지만 본다.
 */
public final class ExplorationCompletionPolicy {

    private ExplorationCompletionPolicy() {
    }

    /**
     * @param activeCandidateCount 현재 별의 활성 후보 수
     * @param discoverableUnmatchedCount 아직 매칭하지 않은 탐색 가능 후보 수
     * @param undiscoverableUnmatchedCount 아직 매칭하지 않은 탐색 불가능 후보 수
     */
    public static Decision decide(int activeCandidateCount,
                                  int discoverableUnmatchedCount,
                                  int undiscoverableUnmatchedCount) {
        validateCounts(activeCandidateCount, discoverableUnmatchedCount, undiscoverableUnmatchedCount);

        if (activeCandidateCount == 0) {
            return Decision.NOT_APPLICABLE;
        }
        if (discoverableUnmatchedCount > 0) {
            return Decision.KEEP_IN_PROGRESS;
        }
        if (undiscoverableUnmatchedCount > 0) {
            return Decision.COMPLETE_UNDISCOVERABLE_ONLY;
        }
        return Decision.COMPLETE_ALL_FOUND;
    }

    private static void validateCounts(int active, int discoverableUnmatched, int undiscoverableUnmatched) {
        if (active < 0 || discoverableUnmatched < 0 || undiscoverableUnmatched < 0) {
            throw new IllegalArgumentException("후보 수는 음수일 수 없습니다");
        }
        if (discoverableUnmatched + undiscoverableUnmatched > active) {
            throw new IllegalArgumentException("미매칭 후보 수가 활성 후보 수보다 많을 수 없습니다");
        }
    }

    public enum Decision {
        /** 활성 후보가 없는 별. 무신호 별을 완료로 만들지 않는다. */
        NOT_APPLICABLE(false, null, false),
        /** 아직 사용자가 찾을 수 있는 신호가 남아 있다. */
        KEEP_IN_PROGRESS(false, null, false),
        /** 모든 활성 후보를 매칭했다. */
        COMPLETE_ALL_FOUND(true, "all_found", false),
        /** 남은 후보는 현재 데이터로 탐색할 수 없어 새 판의 재개를 기다린다. */
        COMPLETE_UNDISCOVERABLE_ONLY(true, "undiscoverable_only", true);

        private final boolean completes;
        private final String completionReason;
        private final boolean reopenPending;

        Decision(boolean completes, String completionReason, boolean reopenPending) {
            this.completes = completes;
            this.completionReason = completionReason;
            this.reopenPending = reopenPending;
        }

        public boolean completes() {
            return completes;
        }

        public String completionReason() {
            return completionReason;
        }

        public boolean reopenPending() {
            return reopenPending;
        }
    }
}
