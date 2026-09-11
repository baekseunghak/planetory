export type PhaseRange = [number, number];
export type ChartKind = 'light' | 'period' | 'phase';
export interface Peak {
  id: string; rank: number; period_days: number; relative_power: number;
  period_min: number; period_max: number; period_step: number;
}
export interface Observation {
  schema_version: string; id: string; label: string; tic_id: string;
  bundle_id: string; point_count: number; sectors: number[];
  time_btjd: number[]; normalized_flux: number[]; fold_reference_time_btjd: number;
  periodogram: { period_days: number[]; power: number[] };
  peaks: Peak[];
  selection_rules: { min_width_phase: number; max_width_phase: number };
  observation_windows: { source_index: number; sector: number; start_btjd: number; end_btjd: number }[];
}
export interface StarTarget {
  id: string; tic: string; name: string; ra: number; dec: number;
  magnitude: number; temperature: number; radius: number;
  sectors: number[]; pointCount: number;
  observations: { sector: number; start: string; end: string }[];
  x: number; y: number;
}
export interface SavedNote {
  id: string; starId: string; tic: string; starName: string; createdAt: string;
  period: number; range: PhaseRange; judgment: string; reasons: string[]; memo: string;
  bundleId: string; referenceTime: number;
}
