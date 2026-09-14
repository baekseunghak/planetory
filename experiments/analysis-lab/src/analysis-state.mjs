// Local preview rules derived from the saved BLS grid. Production uses API limits.
export function fineRangeFor(periods, period) {
  let closest = 0;
  for (let i = 1; i < periods.length; i++) {
    if (Math.abs(periods[i] - period) < Math.abs(periods[closest] - period))
      closest = i;
  }
  const low = Math.max(0, closest - 1),
    high = Math.min(periods.length - 1, closest + 1);
  const spacing = (periods[high] - periods[low]) / (high - low);
  return {
    origin: period,
    min: Math.max(periods[0], period - spacing * 4),
    max: Math.min(periods.at(-1), period + spacing * 4),
    step: spacing / 50,
  };
}

export function selectionPreview(data, period, range) {
  if (
    !data ||
    !Number.isFinite(period) ||
    period <= 0 ||
    !range?.every(Number.isFinite)
  )
    return null;
  const width = range[1] - range[0];
  if (!(width > 0 && width < 1)) return null;
  const start = ((range[0] % 1) + 1) % 1;
  const end = start + width;
  const center = ((((start + end) / 2) % 1) + 1) % 1;
  const base = data.referenceTime + center * period;
  const minK = Math.ceil((data.time[0] - base) / period);
  const maxK = Math.floor((data.time.at(-1) - base) / period);
  if (minK > maxK) return null;
  const target = -center;
  const candidates = [
    ...new Set(
      [Math.floor(target), Math.ceil(target)].map((k) =>
        Math.max(minK, Math.min(maxK, k)),
      ),
    ),
  ];
  candidates.sort((a, b) => {
    // Compare phase distances before adding the large absolute BTJD value.
    const difference = Math.abs(center + a) - Math.abs(center + b);
    return Math.abs(difference) <= Number.EPSILON * 8 ? a - b : difference;
  });
  return {
    start,
    end,
    epoch: data.referenceTime + (center + candidates[0]) * period,
    durationHours: width * period * 24,
  };
}
