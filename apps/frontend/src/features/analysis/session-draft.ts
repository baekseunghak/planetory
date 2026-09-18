import type { AnalysisContext } from "./analysis-data";
import {
  choosePeriod,
  fineTunePeriod,
  type ReadyPeriodogram,
} from "./period-selection";
import {
  evidenceOptions,
  judgments,
  type JudgmentDraft,
} from "./analysis-judgment";
import type { PhaseRange } from "./phase-selection";

export type SavedAnalysisDraft = {
  schema: 1;
  identity: string;
  periodDays: number;
  sourcePeakGridIndex: number | null;
  range: PhaseRange | null;
  judgment: JudgmentDraft;
};
export function draftIdentity(
  context: AnalysisContext,
  data: ReadyPeriodogram,
  dataId: string,
) {
  return JSON.stringify([
    dataId,
    context.selectionContract,
    data.rules,
    data.candidates.peakRuleVersion,
  ]);
}
export function readSavedDraft(
  raw: string,
  identity: string,
): SavedAnalysisDraft {
  const draft = JSON.parse(raw) as SavedAnalysisDraft;
  if (
    !draft ||
    draft.schema !== 1 ||
    draft.identity !== identity ||
    !Number.isFinite(draft.periodDays) ||
    draft.periodDays <= 0 ||
    !(
      draft.sourcePeakGridIndex === null ||
      (Number.isSafeInteger(draft.sourcePeakGridIndex) &&
        draft.sourcePeakGridIndex >= 0)
    ) ||
    !(
      draft.range === null ||
      (draft.range &&
        [draft.range.phaseStart, draft.range.phaseEnd].every(
          (n) => Number.isFinite(n) && n >= -0.5 && n <= 1.5,
        ))
    ) ||
    !draft.judgment ||
    !(
      draft.judgment.userJudgment === null ||
      judgments.some(({ value }) => value === draft.judgment.userJudgment)
    ) ||
    typeof draft.judgment.memo !== "string" ||
    !Array.isArray(draft.judgment.evidenceChecks) ||
    new Set(draft.judgment.evidenceChecks).size !==
      draft.judgment.evidenceChecks.length ||
    draft.judgment.evidenceChecks.some(
      (item) => !evidenceOptions.some(({ value }) => value === item),
    )
  )
    throw new Error("현재 자료와 맞지 않거나 손상된 초안입니다.");
  // Deliberately preserve over-limit text; the editor must show its validation error.
  return draft;
}
export function restoreDraftPeriod(
  draft: SavedAnalysisDraft,
  data: ReadyPeriodogram,
) {
  const selection = choosePeriod(
    data,
    draft.sourcePeakGridIndex === null
      ? { kind: "direct", periodDays: draft.periodDays }
      : { kind: "peak", gridIndex: draft.sourcePeakGridIndex },
  );
  return selection.periodDays === draft.periodDays
    ? selection
    : fineTunePeriod(selection, draft.periodDays);
}
