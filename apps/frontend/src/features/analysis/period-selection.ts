import type { CurveContext } from "./analysis-data";
import type { PeriodogramLoad } from "./load-periodogram";

export type ReadyPeriodogram = Extract<PeriodogramLoad, { kind: "ready" }>;
export type PeriodChoice =
  { kind: "peak"; gridIndex: number } | { kind: "direct"; periodDays: number };
export type PeriodSelection = {
  periodDays: number;
  anchorPeriodDays: number;
  sourcePeakGridIndex: number | null;
  minimum: number;
  maximum: number;
  step: number | null;
};
// #184 consumes the operation, never infers it from the size of the period change.
export type PeriodSelectionChange = {
  kind: "reselect" | "fine-tune";
  revision: number;
  context: CurveContext;
  selectionRulesVersion: string;
  peakRuleVersion: string;
  selection: PeriodSelection;
};

function validPeriod(period: number, minimum: number, maximum: number) {
  if (!Number.isFinite(period) || period <= 0)
    throw new Error("0보다 큰 유한한 주기를 입력해 주세요.");
  if (period < minimum || period > maximum)
    throw new Error(
      "허용 범위 밖입니다. 다른 주기는 새 주기 선택에서 골라 주세요.",
    );
}

export function choosePeriod(
  data: ReadyPeriodogram,
  choice: PeriodChoice,
): PeriodSelection {
  const grid = data.periodogram;
  if (choice.kind === "peak") {
    const peak = data.candidates.peaks.find(
      (item) => item.gridIndex === choice.gridIndex,
    );
    if (!peak) throw new Error("현재 곡선의 추천 봉우리를 다시 선택해 주세요.");
    const minimum = Math.max(grid.periodMinDays, peak.fineTune.periodMinDays);
    const maximum = Math.min(grid.periodMaxDays, peak.fineTune.periodMaxDays);
    validPeriod(peak.periodDays, minimum, maximum);
    return {
      periodDays: peak.periodDays,
      anchorPeriodDays: peak.periodDays,
      sourcePeakGridIndex: peak.gridIndex,
      minimum,
      maximum,
      step: peak.fineTune.periodStepDays,
    };
  }
  const period = choice.periodDays;
  validPeriod(period, grid.periodMinDays, grid.periodMaxDays);
  const logRatio =
    (Math.log(grid.periodMaxDays) - Math.log(grid.periodMinDays)) /
    (grid.nPeriods - 1);
  return {
    periodDays: period,
    anchorPeriodDays: period,
    sourcePeakGridIndex: null,
    minimum: Math.max(
      grid.periodMinDays,
      period * Math.exp(-logRatio * data.rules.halfWidthCells),
    ),
    maximum: Math.min(
      grid.periodMaxDays,
      period * Math.exp(logRatio * data.rules.halfWidthCells),
    ),
    // Direct selection is allowed, but fine tuning waits for a producer-defined step.
    step: null,
  };
}

export function fineTunePeriod(
  selection: PeriodSelection,
  period: number,
): PeriodSelection {
  if (selection.step === null)
    throw new Error(
      "직접 선택한 주기의 미세 조정은 아직 지원하지 않습니다. 새 주기를 선택해 주세요.",
    );
  validPeriod(period, selection.minimum, selection.maximum);
  return { ...selection, periodDays: period };
}

export function stepPeriod(
  selection: PeriodSelection,
  direction: -1 | 1,
): number {
  if (selection.step === null)
    throw new Error("직접 선택한 주기의 미세 조정 간격이 정해지지 않았습니다.");
  return Math.max(
    selection.minimum,
    Math.min(
      selection.maximum,
      selection.periodDays + direction * selection.step,
    ),
  );
}

export function sliderPeriod(
  selection: PeriodSelection,
  period: number,
): number {
  if (selection.step === null)
    throw new Error("직접 선택한 주기의 미세 조정 간격이 정해지지 않았습니다.");
  validPeriod(period, selection.minimum, selection.maximum);
  if (period === selection.minimum || period === selection.maximum)
    return period;
  const steps = Math.round(
    (period - selection.anchorPeriodDays) / selection.step,
  );
  return Math.max(
    selection.minimum,
    Math.min(
      selection.maximum,
      selection.anchorPeriodDays + steps * selection.step,
    ),
  );
}

export function periodChange(
  data: ReadyPeriodogram,
  previous: PeriodSelectionChange | null,
  kind: PeriodSelectionChange["kind"],
  selection: PeriodSelection,
): PeriodSelectionChange {
  return {
    kind,
    revision: (previous?.revision ?? 0) + 1,
    context: data.periodogram.context,
    selectionRulesVersion: data.rules.version,
    peakRuleVersion: data.candidates.peakRuleVersion,
    selection,
  };
}
