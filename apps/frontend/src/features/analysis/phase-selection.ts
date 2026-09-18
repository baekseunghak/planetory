import { contextKey, type AnalysisContext } from "./analysis-data.ts";
import type {
  PeriodSelectionChange,
  ReadyPeriodogram,
} from "./period-selection.ts";
import {
  selectionError,
  SelectionInputError,
  type SelectionIssue,
} from "./selection-rules.ts";

export type PhaseRange = Readonly<{ phaseStart: number; phaseEnd: number }>;
export type SelectionLimits = Readonly<{
  minWindowDays: number;
  minPhaseWidth: number;
  maxPhaseWidth: number;
  maxWindowDays: number;
}>;
export type PhaseSelectionResult =
  | {
      kind: "preview";
      selection: PhaseRange & {
        periodDays: number;
        sourcePeakGridIndex: number | null;
      };
      epochPreviewBtjd: number;
      durationPreviewDays: number;
      durationPreviewHours: number;
      limits: SelectionLimits;
      selectionRulesVersion: string;
      // A numeric preview is not the later submission gate (#185/#187).
      pendingChecks: readonly ["phase-coverage", "server-validation"];
    }
  | { kind: "invalid"; issues: readonly SelectionIssue[] };

function finite(value: number, field: string) {
  if (!Number.isFinite(value))
    selectionError(field, "NON_FINITE", "유한한 수치를 입력해 주세요.");
}

function unitPhase(value: number): number {
  const remainder = value % 1;
  const phase = remainder < 0 ? remainder + 1 : remainder;
  return phase === 0 || phase === 1 ? 0 : phase;
}

/** Ordered, unwrapped display coordinates; never modulo both endpoints independently. */
export function normalizePhaseRange(start: number, end: number): PhaseRange {
  finite(start, "selection.phaseStart");
  finite(end, "selection.phaseEnd");
  if (
    Math.abs(start) >= Number.MAX_SAFE_INTEGER ||
    Math.abs(end) >= Number.MAX_SAFE_INTEGER
  )
    selectionError(
      "selection.phaseStart",
      "UNSAFE_PHASE",
      "위상 좌표를 안전하게 계산할 수 없습니다.",
    );
  const width = end - start;
  if (!(width > 0 && width < 1))
    selectionError(
      "selection.phaseEnd",
      "INVALID_PHASE_WIDTH",
      "선택 구간은 순서대로 지정하고 폭은 0보다 크고 1보다 작아야 합니다.",
    );
  const phaseStart = unitPhase(start),
    phaseEnd = phaseStart + width;
  if (!(phaseEnd > phaseStart && phaseEnd < phaseStart + 1))
    selectionError(
      "selection.phaseEnd",
      "UNREPRESENTABLE_PHASE_WIDTH",
      "선택 구간의 폭을 안전하게 표현할 수 없습니다.",
    );
  return { phaseStart, phaseEnd };
}

/** No epsilon extends the server's boundaries; shared tolerance fixtures remain pending. */
export function getSelectionLimits(
  context: AnalysisContext,
  data: ReadyPeriodogram,
  change: PeriodSelectionChange,
): SelectionLimits {
  const contract = context.selectionContract;
  if (contract.kind === "unavailable")
    throw new SelectionInputError(contract.issues[0]);
  const rules = contract.rules;
  const expected = contextKey(context.curveContext);
  if (
    [data.periodogram.context, data.candidates.context, change.context].some(
      (value) => contextKey(value) !== expected,
    ) ||
    data.rules.version !== rules.version ||
    change.selectionRulesVersion !== rules.version ||
    change.peakRuleVersion !== data.candidates.peakRuleVersion
  )
    selectionError(
      "curveContext",
      "STALE_SELECTION",
      "현재 자료와 같은 문맥·규칙의 주기를 다시 선택해 주세요.",
    );
  const { periodDays, sourcePeakGridIndex } = change.selection;
  finite(periodDays, "selection.periodDays");
  if (
    periodDays <= 0 ||
    periodDays < data.periodogram.periodMinDays ||
    periodDays > data.periodogram.periodMaxDays
  )
    selectionError(
      "selection.periodDays",
      "PERIOD_OUT_OF_RANGE",
      "현재 주기도 범위 안의 양수 주기를 선택해 주세요.",
    );
  let maxWindowDays = rules.phaseWidthMax * periodDays;
  if (sourcePeakGridIndex !== null) {
    const peak = data.candidates.peaks.find(
      (candidate) => candidate.gridIndex === sourcePeakGridIndex,
    );
    if (
      !Number.isSafeInteger(sourcePeakGridIndex) ||
      !peak ||
      periodDays < peak.fineTune.periodMinDays ||
      periodDays > peak.fineTune.periodMaxDays
    )
      selectionError(
        "selection.sourcePeakGridIndex",
        "INVALID_PEAK_SOURCE",
        "선택한 봉우리와 미세 조정 범위를 확인해 주세요.",
      );
    const peakMaxDays =
      (peak.suggestedDurationHours / 24) * rules.maxDurationMultipleOfSuggested;
    finite(peakMaxDays, "selectionRules.maxDurationMultipleOfSuggested");
    maxWindowDays = Math.min(maxWindowDays, peakMaxDays);
  }
  const minPhaseWidth = rules.minWindowDays / periodDays;
  const maxPhaseWidth = Math.min(
    rules.phaseWidthMax,
    maxWindowDays / periodDays,
  );
  if (
    !Number.isFinite(minPhaseWidth) ||
    !Number.isFinite(maxWindowDays) ||
    !(maxWindowDays > 0) ||
    minPhaseWidth >= 1 ||
    rules.minWindowDays > maxWindowDays
  )
    selectionError(
      "selection.phaseEnd",
      "NO_VALID_SELECTION_WIDTH",
      "이 주기에서는 최소·최대 폭을 함께 만족하는 구간을 선택할 수 없습니다.",
    );
  return {
    minWindowDays: rules.minWindowDays,
    minPhaseWidth,
    maxPhaseWidth,
    maxWindowDays,
  };
}

/** Checks a bounded set of integer cycles, rather than iterating through observations. */
export function closestEpoch(
  reference: number,
  period: number,
  center: number,
  bounds: readonly [number, number],
): number {
  finite(reference, "bundle.foldReferenceTimeBtjd");
  finite(period, "selection.periodDays");
  finite(center, "selection.phaseStart");
  if (period <= 0 || center < 0 || center >= 1)
    selectionError(
      "selection",
      "INVALID_EPOCH_INPUT",
      "기준 시각 환산에 필요한 주기와 위상을 확인해 주세요.",
    );
  const [low, high] = bounds;
  finite(low, "bundle.observationBounds");
  finite(high, "bundle.observationBounds");
  if (low > high)
    selectionError(
      "bundle.observationBounds",
      "INVALID_OBSERVATION_BOUNDS",
      "관측 시각 범위가 역전되어 있습니다.",
    );
  const first = (low - reference) / period - center;
  const last = (high - reference) / period - center;
  if (
    ![first, last].every(
      (value) =>
        Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER,
    )
  )
    selectionError(
      "selection",
      "UNSAFE_EPOCH",
      "관측 범위와 주기로 기준 시각을 안전하게 계산할 수 없습니다.",
    );
  const cycles = new Set([
    Math.floor(-center),
    Math.ceil(-center),
    Math.floor(first),
    Math.ceil(first),
    Math.floor(last),
    Math.ceil(last),
  ]);
  let best: number | undefined;
  for (const cycle of cycles) {
    const epoch = reference + (center + cycle) * period;
    if (!Number.isFinite(epoch) || epoch < low || epoch > high) continue;
    if (
      best === undefined ||
      Math.abs(epoch - reference) < Math.abs(best - reference) ||
      (Math.abs(epoch - reference) === Math.abs(best - reference) &&
        epoch < best)
    )
      best = epoch;
  }
  if (best === undefined)
    selectionError(
      "selection",
      "EPOCH_OUT_OF_RANGE",
      "관측 범위 안에 기준 시각을 둘 수 없습니다. 구간을 다시 선택해 주세요.",
    );
  return best;
}

export function previewPhaseSelection(
  context: AnalysisContext,
  data: ReadyPeriodogram,
  change: PeriodSelectionChange,
  start: number,
  end: number,
): PhaseSelectionResult {
  try {
    const limits = getSelectionLimits(context, data, change);
    const range = normalizePhaseRange(start, end);
    const { periodDays, sourcePeakGridIndex } = change.selection;
    const width = range.phaseEnd - range.phaseStart;
    const durationPreviewDays = width * periodDays;
    const durationPreviewHours = durationPreviewDays * 24;
    if (
      !Number.isFinite(durationPreviewHours) ||
      durationPreviewDays <= 0 ||
      durationPreviewDays >= periodDays
    )
      selectionError(
        "selection.phaseEnd",
        "INVALID_DURATION",
        "가려진 시간을 안전하게 계산할 수 없습니다.",
      );
    if (
      durationPreviewDays < limits.minWindowDays ||
      durationPreviewDays > limits.maxWindowDays ||
      width > limits.maxPhaseWidth
    )
      selectionError(
        "selection.phaseEnd",
        "DURATION_OUT_OF_RANGE",
        "선택한 구간이 서버 규칙의 최소·최대 폭을 벗어났습니다.",
      );
    const contract = context.selectionContract;
    if (contract.kind !== "ready")
      throw new SelectionInputError(contract.issues[0]);
    const epochPreviewBtjd = closestEpoch(
      context.foldReferenceTimeBtjd,
      periodDays,
      unitPhase((range.phaseStart + range.phaseEnd) / 2),
      contract.observationBounds,
    );
    return {
      kind: "preview",
      selection: { periodDays, sourcePeakGridIndex, ...range },
      epochPreviewBtjd,
      durationPreviewDays,
      durationPreviewHours,
      limits,
      selectionRulesVersion: contract.rules.version,
      pendingChecks: ["phase-coverage", "server-validation"],
    };
  } catch (error) {
    if (error instanceof SelectionInputError)
      return { kind: "invalid", issues: [error.issue] };
    throw error;
  }
}
