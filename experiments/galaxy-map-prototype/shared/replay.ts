import type { History } from "./types";
export interface Replay {
  points: number[][];
  bundleId: string;
  referenceTime: number;
  phaseStart: number | null;
  phaseEnd: number | null;
  restoreFallback: boolean;
  removedIds: string[];
}
export function rephase(
  h: Pick<
    History,
    "period" | "epoch" | "duration" | "phaseStart" | "phaseEnd"
  > & { originalPeriod?: number | null },
  referenceTime: number,
) {
  const period = h.originalPeriod ?? h.period;
  if (period === null || h.epoch === null || h.duration === null)
    return { phaseStart: h.phaseStart, phaseEnd: h.phaseEnd };
  const center = ((((h.epoch - referenceTime) / period) % 1) + 1) % 1;
  const width = h.duration / period;
  const start = (((center - width / 2) % 1) + 1) % 1;
  return { phaseStart: start, phaseEnd: start + width };
}
