import type { TimeCurve } from "./time-curve.ts";

export type TransitWindow = {
  periodDays: number;
  epochPreviewBtjd: number;
  durationPreviewDays: number;
};
export type TransitBand = {
  segmentId: string;
  cycle: number;
  centerBtjd: number;
  startBtjd: number;
  endBtjd: number;
  xStart: number;
  xEnd: number;
};

/** Project only visible segment time; never enumerate compressed Sector gaps.
 * Half-cadence aligns real BTJD with the chart's existing bin centers. */
export function projectTransitBands(
  curve: TimeCurve,
  window: TransitWindow,
  low: number,
  high: number,
): TransitBand[] {
  const {
    periodDays: period,
    epochPreviewBtjd: epoch,
    durationPreviewDays: duration,
  } = window;
  if (
    ![period, epoch, duration, low, high].every(Number.isFinite) ||
    period <= 0 ||
    duration <= 0 ||
    duration >= period ||
    low >= high
  )
    throw new Error("예상 구간을 표시할 주기·시간·보기 범위를 확인해 주세요.");
  const half = duration / 2;
  const bands: TransitBand[] = [];
  for (const segment of curve.segments) {
    const left = Math.max(low, segment.start),
      right = Math.min(high, segment.end);
    if (left >= right) continue;
    const offset =
      segment.source.startBtjd - segment.start - segment.cadence / 2;
    const timeLow = left + offset,
      timeHigh = right + offset;
    const first = Math.ceil((timeLow - half - epoch) / period);
    const last = Math.floor((timeHigh + half - epoch) / period);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))
      throw new Error(
        "관측 시각 범위의 예상 구간을 안전하게 계산할 수 없습니다.",
      );
    for (let cycle = first; cycle <= last; cycle++) {
      const centerBtjd = epoch + cycle * period;
      const startBtjd = Math.max(timeLow, centerBtjd - half);
      const endBtjd = Math.min(timeHigh, centerBtjd + half);
      if (startBtjd >= endBtjd) continue;
      bands.push({
        segmentId: segment.source.segmentId,
        cycle: cycle === 0 ? 0 : cycle,
        centerBtjd,
        startBtjd,
        endBtjd,
        xStart: Math.max(left, startBtjd - offset),
        xEnd: Math.min(right, endBtjd - offset),
      });
    }
  }
  return bands;
}
