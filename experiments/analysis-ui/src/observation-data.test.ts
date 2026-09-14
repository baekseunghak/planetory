import { describe, expect, it } from 'vitest';
import { allowedWidth, validateObservation, type Observation } from './observation-data';

function data(): Observation {
  return {
    id: 'fixture',
    label: 'Validation fixture',
    tic_id: 'synthetic',
    bundle_id: 'fixture-v1',
    time_btjd: Array.from({ length: 20 }, (_, i) => 1000 + i / 10),
    normalized_flux: Array.from({ length: 20 }, () => 1),
    fold_reference_time_btjd: 1000.95,
    periodogram: { period_days: [0.5, 40], power: [0.1, 0.2] },
    peaks: [
      {
        id: 'P1',
        rank: 1,
        period_days: 3,
        relative_power: 1,
        period_min: 2.9,
        period_max: 3.1,
        period_step: 0.001,
      },
    ],
    selection_rules: { version: 'test', min_width_phase: 0.001, max_width_phase: 0.25 },
    observation_windows: [{ sector: 1, start_btjd: 1000, end_btjd: 1001.9 }],
    provenance: {},
  };
}

describe('observation data boundary', () => {
  it('rejects misaligned, nonfinite, reversed-time and invalid range data before drawing', () => {
    expect(validateObservation(data()).time_btjd).toHaveLength(20);
    const badLength = data();
    badLength.normalized_flux.pop();
    const nonfinite = data();
    nonfinite.time_btjd[5] = NaN;
    const reversed = data();
    reversed.time_btjd.reverse();
    const invalidPeak = data();
    invalidPeak.peaks[0].period_min = 4;
    const invalidRules = data();
    invalidRules.selection_rules.max_width_phase = 1;
    for (const value of [badLength, nonfinite, reversed, invalidPeak, invalidRules]) {
      expect(() => validateObservation(value)).toThrow();
    }
  });
  it('keeps the same sub-ulp width boundaries for interactive selection and restoration', () => {
    expect(allowedWidth(0.5, 0.5009999999999999, 0.001, 0.25)).toBe(true);
    expect(allowedWidth(0.98, 1.02, 0.001, 0.25)).toBe(true);
    expect(allowedWidth(0.5, 0.50099, 0.001, 0.25)).toBe(false);
    expect(allowedWidth(0.5, 0.75001, 0.001, 0.25)).toBe(false);
    expect(allowedWidth(1, 1, 0.001, 0.25)).toBe(false);
    expect(allowedWidth(0, NaN, 0.001, 0.25)).toBe(false);
  });
});
