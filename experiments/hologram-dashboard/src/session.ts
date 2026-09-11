import type { Observation, Peak, PhaseRange, SavedNote } from './types';

export const NOTES_KEY = 'planetory.hologram.notes.v1';
const EPSILON = 1e-12;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isPositiveInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value > 0;

function isCanonicalRange(value: unknown): value is PhaseRange {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber) &&
    value[0] >= 0 && value[0] < 1 && value[1] > value[0] && value[1] - value[0] <= 1 + EPSILON;
}

function isSavedNote(note: unknown): note is SavedNote {
  return isRecord(note) && isText(note.id) && typeof note.starId === 'string' &&
    ['toi270', 'l98-59', 'cm-dra'].includes(note.starId) &&
    isText(note.starName) && isText(note.tic) &&
    typeof note.createdAt === 'string' && Number.isFinite(Date.parse(note.createdAt)) &&
    isFiniteNumber(note.period) && note.period > 0 && isCanonicalRange(note.range) &&
    typeof note.judgment === 'string' && ['행성 같음', '아닌 것 같음', '모르겠음'].includes(note.judgment) &&
    Array.isArray(note.reasons) && note.reasons.every(reason => typeof reason === 'string' && ['홀짝 깊이', '2차 식', 'V/U형'].includes(reason)) &&
    typeof note.memo === 'string' && note.memo.length <= 500 && isText(note.bundleId) && isFiniteNumber(note.referenceTime);
}

export function readNotes(value: string | null): SavedNote[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((note): note is SavedNote => {
      if (!isSavedNote(note) || seen.has(note.id)) return false;
      seen.add(note.id);
      return true;
    });
  } catch { return []; }
}

// A stored phase interval is meaningful only with the same target, bundle,
// reference epoch and selection rules. Keep those checks together on restore.
export function findRestorablePeak(data: Observation, note: SavedNote): Peak | undefined {
  if (note.starId !== data.id || note.tic !== data.tic_id || note.bundleId !== data.bundle_id ||
    note.referenceTime !== data.fold_reference_time_btjd || !isCanonicalRange(note.range) ||
    !isFiniteNumber(note.period) || note.period <= 0) return undefined;
  const width = note.range[1] - note.range[0];
  if (width < data.selection_rules.min_width_phase - EPSILON ||
    width > data.selection_rules.max_width_phase + EPSILON) return undefined;
  return data.peaks.find(peak => note.period >= peak.period_min && note.period <= peak.period_max);
}

export function assertObservation(value: unknown): asserts value is Observation {
  const invalid = () => { throw new Error('관측 자료의 형식을 확인할 수 없습니다.'); };
  if (!isRecord(value) || value.schema_version !== 'analysis-observations-v1' ||
    !isText(value.id) || !isText(value.label) || !isText(value.tic_id) || !isText(value.bundle_id) ||
    !Array.isArray(value.time_btjd) || !Array.isArray(value.normalized_flux) ||
    value.time_btjd.length === 0 || value.time_btjd.length !== value.normalized_flux.length ||
    value.point_count !== value.time_btjd.length || !isFiniteNumber(value.fold_reference_time_btjd) ||
    !value.time_btjd.every(isFiniteNumber) || !value.normalized_flux.every(isFiniteNumber) ||
    !Array.isArray(value.sectors) || !value.sectors.length || !value.sectors.every(isPositiveInteger)) return invalid();

  const periodogram = value.periodogram;
  if (!isRecord(periodogram) || !Array.isArray(periodogram.period_days) || !Array.isArray(periodogram.power) ||
    periodogram.period_days.length < 2 || periodogram.period_days.length !== periodogram.power.length ||
    !periodogram.period_days.every((period, index, all) => isFiniteNumber(period) && period > 0 && (index === 0 || period > all[index - 1])) ||
    !periodogram.power.every(power => isFiniteNumber(power) && power >= 0)) return invalid();

  const rules = value.selection_rules;
  if (!isRecord(rules) || !isFiniteNumber(rules.min_width_phase) || !isFiniteNumber(rules.max_width_phase) ||
    rules.min_width_phase <= 0 || rules.max_width_phase < rules.min_width_phase || rules.max_width_phase >= 1) return invalid();

  if (!Array.isArray(value.observation_windows) || !value.observation_windows.length ||
    !value.observation_windows.every(window => isRecord(window) && isFiniteNumber(window.source_index) &&
      Number.isInteger(window.source_index) && window.source_index >= 0 && isPositiveInteger(window.sector) &&
      isFiniteNumber(window.start_btjd) && isFiniteNumber(window.end_btjd) && window.end_btjd > window.start_btjd)) return invalid();

  if (!Array.isArray(value.peaks) || !value.peaks.length || !value.peaks.every(peak => isRecord(peak) &&
    isText(peak.id) && isPositiveInteger(peak.rank) && isFiniteNumber(peak.relative_power) && peak.relative_power >= 0 && peak.relative_power <= 1 + EPSILON &&
    isFiniteNumber(peak.period_days) && isFiniteNumber(peak.period_min) && isFiniteNumber(peak.period_max) && isFiniteNumber(peak.period_step) &&
    peak.period_min > 0 && peak.period_max >= peak.period_min && peak.period_step > 0 &&
    peak.period_days >= peak.period_min && peak.period_days <= peak.period_max)) return invalid();
}
