package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 별 결과 페이지 응답 (탐사 API 8.4) [S15P21C206-146].
 *
 * <p>결과 카드 [결과 보기]·별 패널 [결과]·마이페이지 [결과]가 같은 응답을 쓴다(AT-74).
 *
 * <p>이 페이지는 <b>회원이 매칭한 신호만</b> 말한다. 매칭하지 못한 후보는 어떤 필드에도 나열하지
 * 않는다(DEC-28). 미매칭 제출은 {@code unmatchedSubmissions}에 제출로만 남고 그 제출이 무엇을
 * 놓쳤는지는 알려주지 않는다.
 */
public final class StarResultViews {

    private StarResultViews() {
    }

    /**
     * @param signals               매칭한 고유 신호마다 한 항목. 신호 수와 제출 수는 다르다 —
     *                              한 신호를 여러 번 제출했으면 항목 하나에 {@code submissionIds}가 여럿이다
     * @param unpublishedSignalCount 매칭했지만 공개하지 않은 신호 수. {@code progress.stage=completed}와
     *                              동시에 0보다 클 수 있다. 그것이 "탐색 완료 / 미게시 분석 있음"이다
     */
    public record StarResult(
            String ticId,
            Star star,
            Bundle bundle,
            Progress progress,
            StarViews.Achievement achievement,
            List<Signal> signals,
            List<UnmatchedSubmission> unmatchedSubmissions,
            List<CurveStep> curveSteps,
            List<DiscoveredStar> discoveredStars,
            int unpublishedSignalCount,
            Links links,
            List<String> nextActions) {
    }

    /** 별 요약. 확정 행성 보유 여부·후보 수는 넣지 않는다(HOME-04, AT-03). */
    public record Star(int sectorCount, Double tmag) {
    }

    /** 현재 판. 판이 없으면 이 객체 자체가 null이다. 판 없음과 값 없음을 섞지 않는다. */
    public record Bundle(String bundleId, OffsetDateTime publishedAt) {
    }

    /**
     * @param matchedCandidateIds       이 회원이 이 별에서 매칭한 신호. {@code signals}와 같은 집합이다
     * @param remainingDiscoverableCount 아직 찾지 못한 탐색 가능 신호 수. <b>어떤 신호인지는 주지 않는다</b>
     */
    public record Progress(
            String stage,
            String completionReason,
            boolean reopenPending,
            Integer currentCurveStep,
            List<String> matchedCandidateIds,
            int remainingDiscoverableCount) {
    }

    /**
     * 매칭한 신호 하나.
     *
     * @param status              후보의 현재 상태. 은퇴한 신호도 성과·기록이 남아 있으므로 계속 보여 준다
     * @param judgmentEvaluation  <b>제출 당시</b> 판정이다. 저장된 응답에서 읽으며 지금 라벨로 다시
     *                            채점하지 않는다(6.6절과 같은 기준). 당시 응답이 없는 옛 기록은 null
     * @param judgmentStatistics  <b>조회 시점</b> 통계다(RES-11·6.4절). 현재 {@code answerClass}가
     *                            {@code analysis}면 {@code kind=public_analyses}, {@code graded}면
     *                            {@code kind=graded}다. 본인 공개 여부나 {@code threadId} 유무로
     *                            가르지 않으며 한 카드에 두 통계를 섞지 않는다
     * @param curveStepAtMatch    <b>처음</b> 매칭한 제출의 곡선 단계. 같은 신호를 다시 제출해도 바뀌지 않는다
     * @param submissionIds       이 신호를 매칭한 본인 제출 전부. 오래된 것부터다
     * @param threadId            서비스 공식 스레드 ID. 없으면 null
     */
    public record Signal(
            String candidateId,
            String disposition,
            String status,
            String latestSubmissionId,
            String latestHistoryId,
            String matchResult,
            String userJudgment,
            String judgmentEvaluation,
            Achievement achievement,
            SubmissionViews.Publication publication,
            Object ai,
            Object judgmentStatistics,
            AchievementViews.Relabel relabel,
            Integer curveStepAtMatch,
            List<String> submissionIds,
            String threadId) {
    }

    /**
     * @param result       이 신호에 대한 마지막 제출의 성과 결과
     * @param recognizedAt 성과 행이 있을 때만 값이 있다. 없으면 null이며 0이나 빈 문자열로 바꾸지 않는다
     */
    public record Achievement(String result, OffsetDateTime recognizedAt) {
    }

    /** 신호를 맞히지 못한 제출. 무엇을 놓쳤는지는 말하지 않는다(DEC-28). */
    public record UnmatchedSubmission(
            String submissionId,
            String historyId,
            String matchResult,
            OffsetDateTime submittedAt) {
    }

    /**
     * 이 회원이 이 별에서 실제로 제출한 곡선 단계.
     *
     * @param removedCandidateIds 그 단계에서 제거한 신호. 원본(0단계)은 빈 배열이며 키를 빼지 않는다 —
     *                            빠지면 "제거 없음"과 "필드 누락"을 구분할 수 없다
     * @param residual            2.4절 잔차 상태 그대로다. 조회는 작업을 만들지 않는다(D-14)
     */
    public record CurveStep(
            int curveStep,
            List<String> removedCandidateIds,
            AnalysisViews.Residual residual) {
    }

    /** 이 별의 성과가 연 주변 별. 좌표는 주지 않는다 — 지도 조회가 정본이다. */
    public record DiscoveredStar(
            String ticId,
            OffsetDateTime unlockedAt,
            String triggerAchievementId) {
    }

    /**
     * @param boardOpen 한 명 이상 발견한 별이면 참(COM-01). 요청 회원 기준이 아니다
     * @param threadIds 이 별의 공식 신호 스레드. <b>회원이 매칭한 신호의 것만</b> 담는다 — 전부 담으면
     *                  매칭하지 못한 후보의 존재가 드러난다(DEC-28)
     */
    public record Links(boolean boardOpen, List<String> threadIds) {
    }
}
