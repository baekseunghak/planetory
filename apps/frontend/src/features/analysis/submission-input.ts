import type { AnalysisContext, CurveContext } from "./analysis-data.ts";
import type { CandidateReview } from "./analysis-judgment.ts";
import type { SubmissionKind } from "./submission-data.ts";

// 제출 본문을 종류별로 만든다(탐사 API 6.1·6.5절). `requestId`는 넣지 않는다.
// 예약은 지문을 보고 정해지므로 `submitAnalysis`가 얹는다.

/** `requestId`를 뺀 제출 본문. */
export type SubmissionInput = Record<string, unknown> & {
  submissionKind: SubmissionKind;
  curveContext: CurveContext;
};

const copyContext = (context: CurveContext): CurveContext => ({
  bundleId: context.bundleId,
  curveStep: context.curveStep,
  removedCandidateIds: [...context.removedCandidateIds],
  residualModelVersion: context.residualModelVersion,
  periodogramConfigVersion: context.periodogramConfigVersion,
});

/** 일반 제출. #185가 만든 제출값 확인 스냅샷을 그대로 보낸다. */
export function candidateInput(review: CandidateReview): SubmissionInput {
  const input = review.input;
  return {
    submissionKind: "candidate",
    curveContext: copyContext(input.curveContext),
    selection: { ...input.selection },
    userJudgment: input.userJudgment,
    evidenceChecks: [...input.evidenceChecks],
    memo: input.memo,
    viewState: {
      periodogramViewport: { ...input.viewState.periodogramViewport },
      foldedXZoomRatio: input.viewState.foldedXZoomRatio,
    },
    retryOfSubmissionId: null,
  };
}

/**
 * 더 없음·건너뛰기. **선택·판단·근거를 인자로 받지 않는다.**
 *
 * 티켓의 완료 조건이 「더 없음 요청에 이전 후보의 수치·판단·근거를 섞지
 * 않는다」이다. 지우는 것보다 처음부터 받지 않는 편이 확실하다. 재현용
 * `viewState`도 넣지 않는다. 보내지 않은 선택을 어디서 보고 있었는지는
 * 이 제출의 의미가 아니다.
 */
function specialInput(
  kind: Exclude<SubmissionKind, "candidate">,
  context: CurveContext,
): SubmissionInput {
  return {
    submissionKind: kind,
    curveContext: copyContext(context),
    retryOfSubmissionId: null,
  };
}
export const noCandidateInput = (context: CurveContext) =>
  specialInput("no_candidate", context);
export const skippedInput = (context: CurveContext) =>
  specialInput("skipped", context);

export type SpecialSubmission = {
  kind: Exclude<SubmissionKind, "candidate">;
  label: string;
  /** 왜 지금 내놓을 수 없는지. 제안하지 않는 이유를 화면이 설명한다. */
  unavailable: string | null;
};

/**
 * 지금 내놓을 수 있는 특수 제출. 서버가 최종 권한이며(6.5절의 409) 여기서는
 * **근거가 있을 때만 제안한다.** 근거가 없으면 제안하지 않는 쪽으로 기운다.
 */
export function specialSubmissions(
  context: AnalysisContext,
): SpecialSubmission[] {
  return [
    {
      kind: "no_candidate",
      label: "더 이상 없음",
      // 완료한 별에 다시 보내면 409다. 단계를 모르면 막지 않는다. 서버가 본다.
      unavailable:
        context.progressStage === "completed"
          ? "이미 탐색을 마친 별입니다."
          : null,
    },
    {
      kind: "skipped",
      label: "이 별 건너뛰기",
      // 조건은 서버만 안다(튜토리얼 여부·오답 횟수·상세 보기). 허용 표시가
      // 없으면 제안하지 않는다.
      unavailable: context.skipAvailable ? null : "지금은 건너뛸 수 없습니다.",
    },
  ];
}
