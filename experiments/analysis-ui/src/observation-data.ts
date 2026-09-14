export interface Peak {
  id: string;
  rank: number;
  period_days: number;
  relative_power: number;
  period_min: number;
  period_max: number;
  period_step: number;
}

export interface Target {
  id: string;
  label: string;
  tic_id: string | number;
  file: string;
  point_count: number;
  sectors: number[];
}

export interface Observation {
  id: string;
  label: string;
  tic_id: string | number;
  bundle_id: string;
  time_btjd: number[];
  normalized_flux: number[];
  fold_reference_time_btjd: number;
  periodogram: { period_days: number[]; power: number[] };
  peaks: Peak[];
  selection_rules: { version: string; min_width_phase: number; max_width_phase: number };
  observation_windows: { sector: number; start_btjd: number; end_btjd: number }[];
  provenance: Record<string, unknown> & {
    quality_counts?: {
      raw: number;
      retained: number;
      quality_nonzero: number;
      nonfinite: number;
      nonpositive_flux: number;
      upper_sigma_clip: number;
    };
  };
}

/** Same tolerance for pointer arithmetic, local saving and restoration. */
export function allowedWidth(start: number, end: number, min: number, max: number): boolean {
  const width = end - start;
  return (
    Number.isFinite(width) && width > 0 && width < 1 && width >= min - 1e-12 && width <= max + 1e-12
  );
}

export function validateObservation(value: Observation): Observation {
  const { time_btjd: times, normalized_flux: flux, periodogram, selection_rules: rules } = value;
  if (
    !Array.isArray(times) ||
    times.length < 20 ||
    times.length !== flux?.length ||
    times.some(
      (t, i) => !Number.isFinite(t) || !Number.isFinite(flux[i]) || (i > 0 && t < times[i - 1]),
    ) ||
    !Number.isFinite(value.fold_reference_time_btjd) ||
    !value.bundle_id ||
    !value.id ||
    !periodogram ||
    periodogram.period_days.length !== periodogram.power.length ||
    periodogram.period_days.length < 2 ||
    periodogram.period_days.some(
      (p, i) => !Number.isFinite(p) || p <= 0 || !Number.isFinite(periodogram.power[i]),
    ) ||
    !rules ||
    !(
      rules.min_width_phase > 0 &&
      rules.max_width_phase < 1 &&
      rules.min_width_phase < rules.max_width_phase
    ) ||
    !value.peaks?.length ||
    value.peaks.some(
      (p) =>
        ![p.period_days, p.period_min, p.period_max, p.period_step].every(Number.isFinite) ||
        p.period_min <= 0 ||
        p.period_min > p.period_days ||
        p.period_max < p.period_days ||
        p.period_step <= 0,
    )
  )
    throw new Error(
      '관측 자료의 배열·기준 시각·선택 설정이 유효하지 않습니다. 다시 내보내 주세요.',
    );
  return value;
}

export async function fetchJson<T>(file: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}observations/${file}`, { signal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(
      '로컬 관측 자료를 찾을 수 없습니다. README의 export 명령으로 생성한 뒤 다시 불러오세요.',
    );
  }
  return response.json() as Promise<T>;
}
