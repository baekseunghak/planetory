package com.planetory.backend.domain.exploration.command;

import java.util.List;

/**
 * 후보 정정 사전검사 결과 [S15P21C206-154].
 *
 * <p>계약은 docs/architecture/candidate-correction-contract.md이며 5.2절이 세라고 한 것을 그대로
 * 담는다. 이 패키지의 모든 조회는 읽기 전용이다.
 */
public final class CorrectionViews {

    private CorrectionViews() {
    }

    /** 계약 1장의 세 사건 중 DB 작업이 필요한 둘. 라벨 변경은 배치가 자동으로 하므로 여기 없다. */
    public enum Kind {
        MERGE, SPLIT;

        static Kind of(String value) {
            return switch (value == null ? "" : value.strip().toLowerCase()) {
                case "merge" -> MERGE;
                case "split" -> SPLIT;
                default -> null;
            };
        }
    }

    /**
     * 후보 하나가 붙들고 있는 것. 계약 5.2절의 여섯 가지 중 후보별로 세는 다섯 가지다.
     *
     * <p>{@code submissions}는 불변 기록이라 어떤 정정에서도 옮기지 않는다(계약 3.1). 그래도 세는
     * 이유는 채점형 일치율의 모집단이 이 값이라 정정 뒤 통계가 어디에 남는지를 보여주기 때문이다.
     *
     * @param unlockedStars <b>별 열림 기록 건수</b>다. 여러 회원이 같은 별을 열 수 있으므로 고유 TIC
     *                      수도, 이 정정이 영향을 주는 별 전체 수도 아니다 [S15P21C206-154 리뷰]
     */
    public record CandidateImpact(long candidateId, long ticId, String status, int achievements,
                                  int unlockedStars, int publishedAnalyses, int activePublishedAnalyses,
                                  int officialThreads, int submissions) {

        /**
         * 회원 데이터가 이 후보에 매달려 있는지. 제출은 옮기지 않기로 이미 정해져 있으므로 빼고,
         * 계약 4장의 미확정 항목이 걸리는 셋만 본다.
         */
        public boolean touchesMembers() {
            return achievements > 0 || publishedAnalyses > 0 || officialThreads > 0;
        }
    }

    /**
     * 사전검사 결과.
     *
     * @param conflictingMembers 병합 대상 둘 이상에 성과를 가진 회원 수. 0보다 크면 계약 S3 때문에
     *                           그 회원들의 성과는 어떤 결정을 하더라도 한 후보로 모을 수 없다
     * @param rejections         비어 있지 않으면 실행하지 않는다(계약 3.4)
     * @param approvals          비어 있지 않으면 회원 쪽 승인 없이 회원 데이터를 건드리지 않는다(계약 5.1)
     */
    public record Precheck(Kind kind, List<Long> candidateIds, Long keepId, List<CandidateImpact> impacts,
                           int conflictingMembers, List<String> rejections, List<String> approvals) {

        public boolean rejected() {
            return !rejections.isEmpty();
        }

        /** 거절되지 않았지만 회원 데이터가 걸려 있어 Gold 쪽만 적용할 수 있는 경우다. */
        public boolean needsMemberApproval() {
            return !rejected() && !approvals.isEmpty();
        }
    }
}
