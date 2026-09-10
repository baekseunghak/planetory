export const MIN_SELECTION_WIDTH = 0.002;
export const MAX_SELECTION_WIDTH = 0.98;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const phaseAt = (time, referenceTime, period) =>
  ((((time - referenceTime) / period) % 1) + 1) % 1;

export function pointerMode(kind, shiftKey, boundary = null, canSelect = true) {
  if (boundary !== null) return canSelect ? "boundary" : null;
  if (kind === "phase" && !shiftKey) return canSelect ? "selection" : null;
  return "pan";
}

export function chartDomain(kind, data, center = 0.5) {
  if (kind === "phase")
    return { min: center - 1, max: center + 1, bounded: false, maxZoom: 20 };
  if (kind === "period")
    return {
      min: Math.log10(data.periodogram.periods[0]),
      max: Math.log10(data.periodogram.periods.at(-1)),
      bounded: true,
      maxZoom: 8,
    };
  return {
    min: data.time[0],
    max: data.time.at(-1),
    bounded: true,
    maxZoom: 8,
  };
}

export function normalizeView(view, domain) {
  const zoom = clamp(
    Number.isFinite(view?.zoom) ? view.zoom : 1,
    1,
    domain.maxZoom ?? 8,
  );
  const half = (domain.max - domain.min) / (2 * zoom);
  const requested = Number.isFinite(view?.center)
    ? view.center
    : (domain.min + domain.max) / 2;
  return {
    zoom,
    center: domain.bounded
      ? clamp(requested, domain.min + half, domain.max - half)
      : requested,
  };
}

export function visibleDomain(view, domain) {
  const half = (domain.max - domain.min) / (2 * view.zoom);
  return [view.center - half, view.center + half];
}

export function zoomAt(view, domain, nextZoom, anchor = view.center) {
  const zoom = clamp(nextZoom, 1, domain.maxZoom ?? 8);
  return normalizeView(
    { zoom, center: anchor + ((view.center - anchor) * view.zoom) / zoom },
    domain,
  );
}

export function panBy(view, domain, viewportFraction) {
  return normalizeView(
    {
      ...view,
      center:
        view.center -
        (viewportFraction * (domain.max - domain.min)) / view.zoom,
    },
    domain,
  );
}

export function stepZoom(zoom, direction, maxZoom = 8) {
  const levels = [1, 2, 4, 8, 16, 20].filter((value) => value <= maxZoom);
  return direction > 0
    ? (levels.find((value) => value > zoom + 1e-8) ?? maxZoom)
    : ([...levels].reverse().find((value) => value < zoom - 1e-8) ?? 1);
}

// The stored range is unwrapped; only display copies are translated by integers.
export function selectionFromDrag(anchor, current) {
  const width = clamp(
    Math.abs(current - anchor),
    MIN_SELECTION_WIDTH,
    MAX_SELECTION_WIDTH,
  );
  return current < anchor ? [anchor - width, anchor] : [anchor, anchor + width];
}

export function moveBoundary(range, boundary, value) {
  return boundary === 0
    ? [
        clamp(
          value,
          range[1] - MAX_SELECTION_WIDTH,
          range[1] - MIN_SELECTION_WIDTH,
        ),
        range[1],
      ]
    : [
        range[0],
        clamp(
          value,
          range[0] + MIN_SELECTION_WIDTH,
          range[0] + MAX_SELECTION_WIDTH,
        ),
      ];
}

export function repeatedRangeShifts(range, min, max) {
  const shifts = [];
  for (
    let shift = Math.ceil(min - range[1]);
    shift <= Math.floor(max - range[0]);
    shift++
  )
    shifts.push(shift);
  return shifts;
}

export function findPeaks(periodogram, count = 3) {
  const { periods, powers } = periodogram;
  const indices = [];
  for (let i = 1; i < powers.length - 1; i++) {
    if (powers[i] > powers[i - 1] && powers[i] >= powers[i + 1])
      indices.push(i);
  }
  indices.sort((a, b) => powers[b] - powers[a]);
  const chosen = [];
  for (const i of indices) {
    if (chosen.every((j) => Math.abs(Math.log(periods[j] / periods[i])) > 0.08))
      chosen.push(i);
    if (chosen.length === count) break;
  }
  return chosen.map((i) => ({ period: periods[i], power: powers[i] }));
}

export function estimateDip(data, period) {
  const bins = Array.from({ length: 100 }, () => []);
  data.time.forEach((time, i) =>
    bins[
      Math.min(99, Math.floor(phaseAt(time, data.referenceTime, period) * 100))
    ].push(data.flux[i]),
  );
  const medians = bins.map((values) => {
    values.sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : Infinity;
  });
  return (medians.indexOf(Math.min(...medians)) + 0.5) / 100;
}
