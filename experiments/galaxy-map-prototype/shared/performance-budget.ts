export interface PerformanceRow {
  count: number;
  scene: string;
  p95: number;
  worst: number;
  firstDisplayMs: number;
  heapMB: number;
  drawCalls: number;
  orbitStars: number;
}
export const MAP_BUDGET = {
  p95: 16.7,
  worst: 33,
  firstDisplayMs: 2000,
  heapMB: 300,
  drawCalls: 2,
  orbitStars: 60,
};
export function budgetFailures(
  rows: PerformanceRow[],
  baseline?: PerformanceRow[],
) {
  const failures: string[] = [];
  for (const r of rows) {
    for (const [key, limit] of Object.entries(MAP_BUDGET)) {
      const value = r[key as keyof typeof MAP_BUDGET];
      if (!Number.isFinite(value) || value < 0 || value > limit)
        failures.push(`${r.count}/${r.scene}: ${key}=${value}, limit=${limit}`);
    }
    if (baseline) {
      const before = baseline.find(
        (b) => b.count === r.count && b.scene === r.scene,
      );
      if (!before) {
        failures.push(`${r.count}/${r.scene}: baseline missing`);
        continue;
      }
      for (const key of ["p95", "worst", "firstDisplayMs", "heapMB"] as const)
        if (
          !Number.isFinite(before[key]) ||
          before[key] <= 0 ||
          r[key] >= before[key] * 1.2
        )
          failures.push(
            `${r.count}/${r.scene}: ${key} regression >=20% or invalid baseline`,
          );
    }
  }
  return failures;
}
