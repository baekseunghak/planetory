package com.planetory.backend.domain.exploration.service;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

/**
 * 별 결과 페이지 (탐사 API 8.4, RES-10, AT-74) [S15P21C206-146].
 *
 * <p>한 별에서 회원이 한 일을 모두 모은다. 세 진입점(결과 카드·별 패널·마이페이지)이 같은 응답을
 * 쓴다.
 *
 * <p><b>조회는 아무것도 바꾸지 않는다.</b> 상세 보기 열람 기록도, 진행도, 잔차 작업도 만들지
 * 않는다(D-14). 결과 페이지를 여는 것만으로 튜토리얼 건너뛰기 조건이 채워지면 안 된다.
 */
@Service
@RequiredArgsConstructor
public class StarResultService {

    /** 6.4절 공개 자격과 같은 매칭 성공 집합. 이 셋만 공개 기록을 만들 수 있다. */
    private static final Set<String> MATCHED = Set.of("matched", "matched_harmonic", "duplicate");

    private final StarRepository stars;
    private final StarResultRepository results;
    private final SubmissionRepository submissions;
    private final ExplorationCompletionRepository candidates;
    private final ResidualResultReader residuals;

    /**
     * 별 결과 페이지.
     *
     * <p>여러 질의로 한 응답을 만들므로 <b>같은 스냅샷</b>에서 읽는다. 중간에 판이 바뀌거나 공개
     * 상태가 달라지면 신호 카드와 미게시 수가 서로 다른 시점을 말하게 된다.
     *
     * <p>{@code remainingDiscoverableCount}는 완료 판정이 쓰는 것과 <b>같은 집계</b>다. 따로 세면
     * "완료인데 남은 신호가 있다"처럼 화면이 자기 모순에 빠진다.
     *
     * @throws BusinessException 제출 이력이 없거나 없는 별이면 {@code RESOURCE_NOT_FOUND}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public StarResultViews.StarResult result(long memberId, long ticId) {
        // 없는 별과 제출한 적 없는 별을 같은 404로 덮는다. 둘을 가르면 TIC 존재 여부가 드러난다.
        if (!stars.hasSubmission(memberId, ticId)) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }

        StarViews.StarInfo info = stars.findStar(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        StarViews.Progress saved = stars.findProgress(memberId, ticId)
                .orElseGet(() -> new StarViews.Progress("unexplored", null, null, false, null, null));

        List<StarResultRepository.SignalRow> rows = results.findSignals(memberId, ticId);
        List<StarResultViews.Signal> signals = rows.stream().map(row -> signal(memberId, row)).toList();

        StarViews.Achievement counted = stars.countAchievements(memberId, ticId);
        int unpublished = results.countUnpublishedSignals(memberId, ticId);

        return new StarResultViews.StarResult(
                String.valueOf(ticId),
                new StarResultViews.Star(info.sectorCount(), info.tmag()),
                results.findCurrentBundle(ticId).orElse(null),
                progress(memberId, ticId, saved, signals),
                new StarViews.Achievement(counted.count(), StarService.grade(counted.count()),
                        counted.byType()),
                signals,
                results.findUnmatchedSubmissions(memberId, ticId),
                curveSteps(memberId, ticId),
                results.findDiscoveredStars(memberId, ticId),
                unpublished,
                links(ticId, signals),
                nextActions(memberId, ticId, saved.stage(), unpublished));
    }

    private StarResultViews.Progress progress(long memberId, long ticId, StarViews.Progress saved,
                                              List<StarResultViews.Signal> signals) {
        return new StarResultViews.Progress(
                saved.stage(), saved.completionReason(), saved.reopenPending(), saved.currentCurveStep(),
                signals.stream().map(StarResultViews.Signal::candidateId).toList(),
                candidates.countCandidates(memberId, ticId).discoverableUnmatched());
    }

    private StarResultViews.Signal signal(long memberId, StarResultRepository.SignalRow row) {
        // 후보에 판정 행이 없으면 6.4절과 같이 의존 자원 장애로 본다. 없는 판정을 지어내지 않는다.
        if (row.disposition() == null) {
            throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        }
        var disposition = new SubmissionRepository.Disposition(
                row.disposition(), row.answerClass(), row.planetTruth());

        return new StarResultViews.Signal(
                ExplorationIds.candidate(row.candidateId()),
                AchievementRepository.apiDisposition(row.disposition()),
                row.candidateStatus(),
                ExplorationIds.submission(row.latestSubmissionId()),
                row.latestHistoryId() == null ? null : "h-" + row.latestHistoryId(),
                row.matchResult(),
                row.userJudgment(),
                row.evaluation(),
                new StarResultViews.Achievement(row.achievementResult(), row.recognizedAt()),
                publication(row),
                submissions.ai(row.candidateId()),
                // 조회 시점 통계다. 본인 공개 여부나 스레드 유무로 가르지 않는다(8.4절).
                submissions.statistics(row.candidateId(), disposition),
                row.relabeledAt() == null ? null : new AchievementViews.Relabel(row.relabeledAt(),
                        AchievementRepository.apiDisposition(row.relabelDisposition())),
                row.curveStepAtMatch(),
                Arrays.stream(row.submissionIds()).map(ExplorationIds::submission).toList(),
                row.threadId() == null ? null : "st-" + row.threadId());
    }

    /**
     * 공개 상태는 <b>제출 당시</b> 자격으로 가른다(8.2절과 같은 기준). 지금 라벨이 확정으로 바뀌어도
     * 그때 미확정으로 남긴 미공개 기록은 계속 {@code UNPUBLISHED}다(F07-Q2).
     */
    private static SubmissionViews.Publication publication(StarResultRepository.SignalRow row) {
        boolean eligible = "analysis".equals(row.submittedAnswerClass())
                && MATCHED.contains(String.valueOf(row.submittedMatchStatus()));
        String state = row.isPublic() ? "PUBLISHED"
                : row.isModerationHidden() ? "HIDDEN"
                : eligible ? "UNPUBLISHED" : "NOT_ELIGIBLE";
        return new SubmissionViews.Publication(state,
                row.publicAnalysisId() == null ? null
                        : ExplorationIds.publicAnalysis(row.publicAnalysisId()));
    }

    private List<StarResultViews.CurveStep> curveSteps(long memberId, long ticId) {
        return results.findCurveSteps(memberId, ticId).stream().map(step -> {
            List<String> removed = Arrays.stream(step.removedCandidateIds())
                    .map(ExplorationIds::candidate).toList();
            return new StarResultViews.CurveStep(step.curveStep(), removed, residual(ticId, step, removed));
        }).toList();
    }

    /** 원본은 DB 행이 곧 결과라 조회하지 않는다. 나머지는 캐시·작업 상태를 읽기만 한다(D-14). */
    private AnalysisViews.Residual residual(long ticId, StarResultRepository.StepRow step,
                                            List<String> removed) {
        if (step.curveStep() == 0) return AnalysisViews.Residual.ORIGINAL;
        var lookup = residuals.lookup(ticId, new AnalysisViews.CurveContext(
                ExplorationIds.bundle(step.bundleId()), step.curveStep(), removed,
                step.residualModelVersion(), step.periodogramConfigVersion()));
        return new AnalysisViews.Residual(lookup.status(), lookup.jobId(), lookup.computedAt());
    }

    /**
     * 스레드는 <b>회원이 매칭한 신호의 것만</b> 모은다. 이 별의 스레드를 전부 담으면 회원이 아직
     * 맞히지 못한 후보가 몇 개 있는지 드러난다(DEC-28).
     */
    private StarResultViews.Links links(long ticId, List<StarResultViews.Signal> signals) {
        return new StarResultViews.Links(stars.isBoardOpen(ticId),
                signals.stream().map(StarResultViews.Signal::threadId).filter(java.util.Objects::nonNull)
                        .distinct().toList());
    }

    /**
     * 서버 힌트다(RES-03·08). 실행하면 서버가 다시 검증하며, 게시 화면으로 강제로 옮기지 않는다(AT-36).
     *
     * <p>[모두 게시]·[나중에]는 <b>탐색이 끝나고</b> 공개하지 않은 신호가 남았을 때만 준다(RES-08
     * "별 탐색 종료 후", RES-10 "종료 시"). 진행 중에는 개별 [분석 공개]가 그 일을 한다.
     */
    private List<String> nextActions(long memberId, long ticId, String stage, int unpublished) {
        List<String> actions = new ArrayList<>();
        if ("completed".equals(stage) && unpublished > 0) {
            actions.add("PUBLISH_ALL");
            actions.add("LATER");
        }
        if (results.hasRestorableSubmission(memberId, ticId)) {
            actions.add("RETRY");
        }
        return List.copyOf(actions);
    }
}
