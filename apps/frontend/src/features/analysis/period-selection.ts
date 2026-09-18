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
  /** 서버가 정한 격자 한 칸. 거친 이동(Page 키)과 표시에 쓴다. */
  step: number | null;
  /** 슬라이더·방향키의 실제 간격. 아래 FINE_TUNE_DIVISIONS 참고. */
  fineStep: number | null;
};

/** 서버 격자 한 칸을 몇 등분해 미세 조정할지.
 *
 *  허용 범위는 격자 `halfWidthCells`칸의 양쪽이므로 fixture 기준 6칸 ≈ 0.0617일이고,
 *  칸 하나는 ≈ 0.01029일이다. 128등분하면 간격이 ≈ 8.0e-5일로 요구한 소수점 넷째
 *  자리 아래를 만족하고, 범위 전체가 6 × 128 = 768단계가 된다. 1440px에서 슬라이더
 *  폭이 ≈ 900px이므로 1픽셀이 약 한 단계이고, 포인터 이벤트는 화면 주사율로 합쳐지니
 *  끝까지 끌어도 초당 60회 정도만 다시 접는다. 더 잘게 쪼개면 포인터로는 닿지 않는
 *  단계만 늘고 키보드 이동만 길어진다.
 *
 *  2의 거듭제곱이라 서버 격자 칸과 봉우리 원래 주기가 항상 격자 위에 그대로 남는다. */
export const FINE_TUNE_DIVISIONS = 128;
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
      fineStep: peak.fineTune.periodStepDays / FINE_TUNE_DIVISIONS,
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
    fineStep: null,
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

/** 봉우리 원래 주기를 기준으로 맞춰 앵커가 항상 격자 위에 남게 한다. */
function snap(selection: PeriodSelection, period: number, size: number) {
  const steps = Math.round((period - selection.anchorPeriodDays) / size);
  return Math.max(
    selection.minimum,
    Math.min(selection.maximum, selection.anchorPeriodDays + steps * size),
  );
}

/** 방향키는 미세 간격, Page 키는 서버 격자 한 칸을 움직인다. */
export function stepPeriod(
  selection: PeriodSelection,
  direction: -1 | 1,
  coarse = false,
): number {
  const size = coarse ? selection.step : selection.fineStep;
  if (size === null)
    throw new Error("직접 선택한 주기의 미세 조정 간격이 정해지지 않았습니다.");
  return snap(selection, selection.periodDays + direction * size, size);
}

export function sliderPeriod(
  selection: PeriodSelection,
  period: number,
): number {
  if (selection.fineStep === null)
    throw new Error("직접 선택한 주기의 미세 조정 간격이 정해지지 않았습니다.");
  validPeriod(period, selection.minimum, selection.maximum);
  if (period === selection.minimum || period === selection.maximum)
    return period;
  return snap(selection, period, selection.fineStep);
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
