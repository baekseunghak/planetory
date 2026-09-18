import {
  contextKey,
  type AnalysisContext,
  type CurveData,
} from "./analysis-data";

export type FoldPoint = Readonly<{
  btjd: number;
  flux: number;
  segmentId: string;
  sector: number;
  index: number;
}>;
export type FoldData = Readonly<{
  dataId: string;
  reference: number;
  points: readonly FoldPoint[];
  times: Float64Array<ArrayBuffer>;
}>;

/** Consumes decoded full curves, never compressed display coordinates or a viewport. */
export function buildFoldData(
  context: AnalysisContext,
  curve: CurveData,
): FoldData {
  if (curve.kind !== "ready")
    throw new Error("접기에 필요한 곡선이 아직 준비되지 않았습니다.");
  if (contextKey(context.curveContext) !== contextKey(curve.context))
    throw new Error("접기 문맥과 곡선이 일치하지 않습니다.");
  if (!Number.isFinite(context.foldReferenceTimeBtjd))
    throw new Error("접기 기준 시각은 유한한 값이어야 합니다.");
  const points: FoldPoint[] = [];
  for (const segment of curve.segments) {
    if (
      segment.nPoints !== segment.flux.length ||
      !Number.isSafeInteger(segment.nPoints) ||
      segment.nPoints < 1 ||
      !Number.isFinite(segment.binMinutes) ||
      segment.binMinutes <= 0
    )
      throw new Error("접기 곡선의 길이와 관측 간격을 확인해 주세요.");
    for (let index = 0; index < segment.nPoints; index++) {
      const flux = segment.flux[index];
      const btjd = segment.startBtjd + index * (segment.binMinutes / 1440);
      if (!Number.isFinite(btjd) || (flux !== null && !Number.isFinite(flux)))
        throw new Error("접기 관측값은 유한한 값이어야 합니다.");
      if (flux === null) continue;
      points.push(
        Object.freeze({
          btjd,
          flux,
          segmentId: segment.segmentId,
          sector: segment.sector,
          index,
        }),
      );
    }
  }
  // Empty is a data state, never a successful zero-point fold or a no-signal judgment.
  return Object.freeze({
    dataId: JSON.stringify([
      context.ticId,
      contextKey(curve.context),
      context.foldReferenceTimeBtjd,
      curve.segments.map((s) => [
        s.segmentId,
        s.binningRevision,
        s.startBtjd,
        s.binMinutes,
        s.nPoints,
      ]),
    ]),
    reference: context.foldReferenceTimeBtjd,
    points: Object.freeze(points),
    times: Float64Array.from(points, (point) => point.btjd),
  });
}

export function requireFoldPeriod(period: number): void {
  if (!Number.isFinite(period) || period <= 0)
    throw new RangeError("주기는 0보다 큰 유한한 값이어야 합니다.");
}

/** Phase in [0, 1); subtraction always uses the Bundle's original BTJD reference. */
export function foldTimes(
  times: ArrayLike<number>,
  reference: number,
  period: number,
): Float64Array<ArrayBuffer> {
  requireFoldPeriod(period);
  if (!Number.isFinite(reference))
    throw new RangeError("접기 기준 시각이 유효하지 않습니다.");
  if (!times.length) throw new RangeError("유효한 관측 시각이 없습니다.");
  const phases = new Float64Array(times.length);
  for (let i = 0; i < times.length; i++) {
    const cycles = (times[i] - reference) / period;
    if (!Number.isFinite(cycles) || Math.abs(cycles) > Number.MAX_SAFE_INTEGER)
      throw new RangeError("관측 시각과 주기를 안전하게 계산할 수 없습니다.");
    const remainder = cycles % 1;
    const phase = remainder < 0 ? remainder + 1 : remainder;
    // A negative sub-ulp remainder can round to one. Also canonicalize negative zero.
    phases[i] = phase === 0 || phase === 1 ? 0 : phase;
  }
  return phases;
}
