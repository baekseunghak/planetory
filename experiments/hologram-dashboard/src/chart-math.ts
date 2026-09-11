import type { PhaseRange } from './types';

export function positiveMod(value: number, divisor = 1): number {
  return ((value % divisor) + divisor) % divisor;
}

export function phaseAt(time: number, period: number, reference: number): number {
  if (![time, period, reference].every(Number.isFinite) || period <= 0) return NaN;
  return positiveMod((time - reference) / period);
}

/** The end remains unwrapped: [0.95, 1.05] is a valid transit. */
export function normalizePhaseRange(
  first: number, second: number, minWidth = 0.002, maxWidth = 0.25,
): PhaseRange {
  if (![first, second, minWidth, maxWidth].every(Number.isFinite)
    || minWidth <= 0 || maxWidth < minWidth || maxWidth >= 1) {
    throw new RangeError('Invalid phase selection or width limits');
  }
  const low = Math.min(first, second);
  const width = Math.max(minWidth, Math.min(maxWidth, Math.abs(second - first)));
  const start = positiveMod(low);
  return [start, start + width];
}

export function phaseInRange(phase: number, range: PhaseRange): boolean {
  return positiveMod(phase - range[0]) <= range[1] - range[0] + 1e-12;
}

export function previewTransit(range: PhaseRange, period: number, reference: number,
  observationStart: number, observationEnd: number) {
  const center = positiveMod((range[0] + range[1]) / 2);
  const kMin = Math.ceil((observationStart - reference) / period - center);
  const kMax = Math.floor((observationEnd - reference) / period - center);
  if (kMin > kMax || period <= 0) return null;
  const options = [Math.floor(-center), Math.ceil(-center)]
    .map(k => Math.max(kMin, Math.min(kMax, k)))
    .map(k => reference + (center + k) * period)
    .sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference) || a - b);
  return { epoch: options[0], durationHours: (range[1] - range[0]) * period * 24 };
}

export function foldPoints(times: ArrayLike<number>, flux: ArrayLike<number>, period: number,
  reference: number, binCount = 240) {
  if (times.length !== flux.length || !Number.isFinite(period) || period <= 0
    || !Number.isFinite(reference) || !Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError('Invalid folding input');
  }
  const phases = new Float64Array(times.length);
  const means = new Float64Array(binCount);
  const counts = new Uint32Array(binCount);
  for (let i = 0; i < times.length; i++) {
    const phase = Number.isFinite(times[i]) ? positiveMod((times[i] - reference) / period) : NaN;
    phases[i] = phase;
    if (!Number.isFinite(phase) || !Number.isFinite(flux[i])) continue;
    const bin = Math.min(binCount - 1, Math.floor(phase * binCount));
    means[bin] += flux[i];
    counts[bin]++;
  }
  for (let i = 0; i < binCount; i++) means[i] = counts[i] ? means[i] / counts[i] : NaN;
  return { phases, means, counts };
}

export function zoomWindow(zoom: number, center: number): [number, number] {
  const width = 2 / Math.max(1, Math.min(8, zoom));
  const safeCenter = Math.max(width / 2, Math.min(2 - width / 2, center));
  return [safeCenter - width / 2, safeCenter + width / 2];
}

/** Preserve the supplied BLS units; leave headroom without flattening small powers. */
export function powerAxisMaximum(powers: ArrayLike<number>): number {
  let maximum = 0;
  for (let i = 0; i < powers.length; i++) {
    if (Number.isFinite(powers[i])) maximum = Math.max(maximum, powers[i]);
  }
  return maximum > 0 ? maximum * 1.13 : Number.EPSILON;
}

export function formatPowerTick(value: number, maximum: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (maximum < 0.01 || maximum >= 10000) return value.toExponential(1);
  return value.toFixed(Math.max(0, 2 - Math.floor(Math.log10(maximum))));
}
