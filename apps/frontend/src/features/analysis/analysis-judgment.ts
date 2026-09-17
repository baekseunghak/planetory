import type { CurveContext } from "./analysis-data.ts";
import type { PhaseSelectionResult } from "./phase-selection.ts";
import type { SelectionIssue } from "./selection-rules.ts";

export const judgments = [
  { value: "LIKELY_PLANET", label: "행성 같음" },
  { value: "UNLIKELY_PLANET", label: "아닌 것 같음" },
  { value: "UNSURE", label: "모르겠음" },
] as const;
export const evidenceOptions = [
  { value: "oddeven", label: "홀짝 깊이" },
  { value: "secondary", label: "2차 식" },
  { value: "ushape", label: "V·U형" },
] as const;
export type Judgment = (typeof judgments)[number]["value"];
export type Evidence = (typeof evidenceOptions)[number]["value"];
export type JudgmentDraft = {
  userJudgment: Judgment | null;
  evidenceChecks: Evidence[];
  memo: string;
};
export const emptyJudgment: JudgmentDraft = {
  userJudgment: null,
  evidenceChecks: [],
  memo: "",
};
// Provisional UI bound from exploration-api-spec §6.1/D-12; backend agreement pending.
export const PROVISIONAL_MEMO_LIMIT = 2000;
export const memoCodePoints = (memo: string) => Array.from(memo).length;
export type PhasePreview = Extract<PhaseSelectionResult, { kind: "preview" }>;
export type PeriodogramViewport = { minDays: number; maxDays: number };
// This is a local review snapshot, not a sent request or a stored Submission.
// #187 must add requestId and perform server validation at actual submission.
export type CandidateReview = {
  ticId: string;
  selectionRulesVersion: string;
  epochPreviewBtjd: number;
  durationPreviewHours: number;
  input: {
    submissionKind: "candidate";
    curveContext: CurveContext;
    selection: PhasePreview["selection"];
    userJudgment: Judgment;
    evidenceChecks: Evidence[];
    memo: string;
    viewState: {
      periodogramViewport: PeriodogramViewport;
      foldedXZoomRatio: number;
    };
    retryOfSubmissionId: null;
  };
};

export function validateJudgment(draft: JudgmentDraft): SelectionIssue[] {
  const issues: SelectionIssue[] = [];
  if (!judgments.some(({ value }) => value === draft.userJudgment))
    issues.push({
      field: "userJudgment",
      code: "REQUIRED_JUDGMENT",
      message: "판단을 하나 선택해 주세요.",
    });
  if (
    new Set(draft.evidenceChecks).size !== draft.evidenceChecks.length ||
    draft.evidenceChecks.some(
      (item) => !evidenceOptions.some(({ value }) => item === value),
    )
  )
    issues.push({
      field: "evidenceChecks",
      code: "INVALID_EVIDENCE",
      message: "근거는 홀짝 깊이, 2차 식, V·U형 중에서 선택해 주세요.",
    });
  if (memoCodePoints(draft.memo) > PROVISIONAL_MEMO_LIMIT)
    issues.push({
      field: "memo",
      code: "MEMO_TOO_LONG",
      message: "메모를 2,000자 이내로 줄여 주세요.",
    });
  return issues;
}

export function createCandidateReview(
  ticId: string,
  context: CurveContext,
  preview: PhasePreview,
  draft: JudgmentDraft,
  viewport: PeriodogramViewport,
  zoom: number,
): CandidateReview {
  const issues = validateJudgment(draft);
  if (issues.length) throw new Error(issues[0].message);
  if (
    !Number.isFinite(zoom) ||
    zoom < 1 ||
    zoom > 32 ||
    !Number.isFinite(viewport.minDays) ||
    !Number.isFinite(viewport.maxDays) ||
    viewport.minDays <= 0 ||
    viewport.maxDays <= viewport.minDays
  )
    throw new Error("그래프 표시 범위를 확인해 주세요.");
  return {
    ticId,
    selectionRulesVersion: preview.selectionRulesVersion,
    epochPreviewBtjd: preview.epochPreviewBtjd,
    durationPreviewHours: preview.durationPreviewHours,
    input: {
      submissionKind: "candidate",
      curveContext: {
        ...context,
        removedCandidateIds: [...context.removedCandidateIds],
      },
      selection: { ...preview.selection },
      userJudgment: draft.userJudgment!,
      evidenceChecks: [...draft.evidenceChecks],
      memo: draft.memo,
      viewState: {
        periodogramViewport: { ...viewport },
        foldedXZoomRatio: zoom,
      },
      retryOfSubmissionId: null,
    },
  };
}
