/** Browser preview math for EXP-06–08. The server still derives final submission values. */
export interface PhaseSelection {
  period_days: number;
  phase_start: number;
  phase_end: number;
}

export interface PhaseInterval {
  phase_start: number;
  phase_end: number;
}

export interface TransitValues {
  epoch_btjd: number;
  duration_days: number;
}

export interface TransitWindow {
  start: number;
  end: number;
}

/** Rendering guard, not a scientific selection limit. Never silently truncate bands. */
export const MAX_TRANSIT_WINDOWS = 10_000;

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label}은 유한한 값이어야 합니다.`);
}

function requirePeriod(period: number): void {
  if (!Number.isFinite(period) || period <= 0)
    throw new RangeError('주기는 0보다 큰 유한한 값이어야 합니다.');
}

/** Positive modulo, including timestamps before the fixed Bundle reference. */
export function normalizePhase(value: number): number {
  requireFinite(value, '위상');
  const remainder = value % 1;
  const positive = remainder < 0 ? remainder + 1 : remainder;
  // A negative sub-ulp remainder can round to one; phase one is phase zero.
  return positive === 0 || positive === 1 ? 0 : positive;
}

/** Handles stay ordered on the continuous two-cycle axis; reversed endpoints are invalid. */
export function normalizeInterval(start: number, end: number): PhaseInterval {
  requireFinite(start, '구간 시작');
  requireFinite(end, '구간 끝');
  const width = end - start;
  if (!(width > 0 && width < 1))
    throw new RangeError('구간 폭은 0보다 크고 한 주기보다 작아야 합니다.');
  const phase_start = normalizePhase(start);
  const phase_end = phase_start + width;
  if (!(phase_end > phase_start && phase_end < phase_start + 1)) {
    throw new RangeError('이 구간은 현재 수치 정밀도로 표현할 수 없습니다.');
  }
  return { phase_start, phase_end };
}

function validateSelection(selection: PhaseSelection): number {
  requirePeriod(selection.period_days);
  const { phase_start: start, phase_end: end } = selection;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start >= 1 ||
    !(end > start && end < start + 1)
  ) {
    throw new RangeError(
      '정규화한 위상 구간이 필요합니다. 시작은 0 이상 1 미만이고 폭은 한 주기보다 작아야 합니다.',
    );
  }
  const duration = (end - start) * selection.period_days;
  if (!Number.isFinite(duration) || !(duration > 0 && duration < selection.period_days)) {
    throw new RangeError('지속시간을 유효한 수치로 계산할 수 없습니다.');
  }
  return duration;
}

function observationBounds(times: readonly number[]): { min: number; max: number } {
  if (times.length === 0) throw new RangeError('유효한 관측 시각이 없습니다.');
  let min = Infinity;
  let max = -Infinity;
  // A loop handles full observations without spreading a large array into Math.min/max.
  for (const time of times) {
    requireFinite(time, '관측 시각');
    if (time < min) min = time;
    if (time > max) max = time;
  }
  return { min, max };
}

function requireIntegerRange(first: number, last: number): void {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
    throw new RangeError('시각과 주기의 비율이 안전하게 계산할 수 있는 범위를 넘었습니다.');
  }
}

export function deriveTransit(
  selection: PhaseSelection,
  reference: number,
  times: readonly number[],
): TransitValues {
  const duration_days = validateSelection(selection);
  requireFinite(reference, '기준 시각');
  const { min, max } = observationBounds(times);
  const center = normalizePhase((selection.phase_start + selection.phase_end) / 2);
  const period = selection.period_days;
  const first = Math.ceil((min - reference) / period - center);
  const last = Math.floor((max - reference) / period - center);
  requireIntegerRange(first, last);
  if (first > last)
    throw new RangeError('관측 범위 안에 transit 중심이 없습니다. 구간을 다시 선택해주세요.');

  // center is in [0,1): zero or minus one is nearest to the fixed reference.
  // Exactly half a period chooses minus one, hence the earlier epoch.
  const nearest = center < 0.5 ? 0 : -1;
  const k = Math.max(first, Math.min(last, nearest));
  const epoch_btjd = reference + (center + k) * period;
  if (!Number.isFinite(epoch_btjd) || epoch_btjd < min || epoch_btjd > max) {
    throw new RangeError('관측 범위 안에 epoch를 안정적으로 계산할 수 없습니다.');
  }
  return { epoch_btjd, duration_days };
}

/** All valid observations, in their input order; no binning or epoch re-estimation. */
export function foldTimes(
  times: readonly number[],
  reference: number,
  period: number,
): Float64Array<ArrayBuffer> {
  requireFinite(reference, '기준 시각');
  requirePeriod(period);
  const phases = new Float64Array(times.length);
  for (let index = 0; index < times.length; index += 1) {
    requireFinite(times[index], '관측 시각');
    phases[index] = normalizePhase((times[index] - reference) / period);
  }
  return phases;
}

/** Full transit spans intersecting the observation bounds; the chart clips their edges. */
export function transitWindows(
  selection: PhaseSelection,
  reference: number,
  times: readonly number[],
): TransitWindow[] {
  validateSelection(selection);
  requireFinite(reference, '기준 시각');
  const { min, max } = observationBounds(times);
  const period = selection.period_days;
  const first = Math.ceil((min - reference) / period - selection.phase_end);
  const last = Math.floor((max - reference) / period - selection.phase_start);
  requireIntegerRange(first, last);
  if (first > last) return [];
  if (last - first + 1 > MAX_TRANSIT_WINDOWS) {
    throw new RangeError(
      `예상 transit 구간이 ${MAX_TRANSIT_WINDOWS.toLocaleString('en-US')}개를 넘습니다. 표시 범위를 줄여주세요.`,
    );
  }
  const windows: TransitWindow[] = [];
  for (let k = first; k <= last; k += 1) {
    const start = reference + (selection.phase_start + k) * period;
    const end = reference + (selection.phase_end + k) * period;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
      throw new RangeError('예상 transit 구간을 안정적으로 계산할 수 없습니다.');
    }
    if (end >= min && start <= max) windows.push({ start, end });
  }
  return windows;
}
