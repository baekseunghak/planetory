import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertObservation, findRestorablePeak, readNotes } from '../src/session';
import type { Observation, SavedNote, StarTarget } from '../src/types';

const observationBytes = (id: string) => readFileSync(new URL(`../public/observations/${id}.json`, import.meta.url));
const data: Observation = JSON.parse(observationBytes('toi270').toString('utf8'));
const note: SavedNote = {
  id: 'observation-1', starId: data.id, starName: data.label, tic: data.tic_id,
  createdAt: '2026-09-10T09:00:00.000Z', period: data.peaks[0].period_days,
  range: [0.97, 1.03], judgment: '모르겠음', reasons: ['홀짝 깊이'], memo: '위상 0을 가로지르는 구간',
  bundleId: data.bundle_id, referenceTime: data.fold_reference_time_btjd,
};

test('saved notes survive phase-zero wrapping while malformed neighbours are excluded', () => {
  const restored = readNotes(JSON.stringify([
    null, { ...note, id: 'wrong-target', starId: 'unknown' },
    { ...note, id: 'bad-range', range: [-0.03, 0.03] },
    { ...note, id: 'wrong-cycle', range: [1.97, 2.03] },
    { ...note, id: 'reverse', range: [0.2, 0.1] },
    { ...note, id: 'bad-date', createdAt: 'yesterday' },
    { ...note, id: 'bad-period', period: 0 },
    { ...note, id: 'bad-reasons', reasons: { reason: '홀짝 깊이' } },
    note, note,
  ]));
  assert.deepEqual(restored, [note]);
  assert.deepEqual(readNotes('{broken'), []);
  assert.deepEqual(readNotes('{"notes":[]}'), []);
  assert.deepEqual(readNotes(null), []);
});

test('restoration preserves its bundle, target, reference epoch and valid period domain', () => {
  assert.equal(findRestorablePeak(data, note)?.id, data.peaks[0].id);
  for (const patch of [
    { starId: 'l98-59' }, { tic: '307210830' }, { bundleId: 'another-bundle' },
    { referenceTime: note.referenceTime + 0.01 }, { period: 1000 },
  ]) assert.equal(findRestorablePeak(data, { ...note, ...patch }), undefined, JSON.stringify(patch));
});

test('restoration enforces current selection width without discarding valid wrapped ranges', () => {
  const minimum = data.selection_rules.min_width_phase;
  const maximum = data.selection_rules.max_width_phase;
  assert.equal(findRestorablePeak(data, { ...note, range: [0.99, 0.99 + minimum] })?.id, data.peaks[0].id);
  assert.equal(findRestorablePeak(data, { ...note, range: [0.9, 0.9 + maximum] })?.id, data.peaks[0].id);
  assert.equal(findRestorablePeak(data, { ...note, range: [0.4, 0.4 + minimum / 2] }), undefined);
  assert.equal(findRestorablePeak(data, { ...note, range: [0.4, 0.4 + maximum + 0.01] }), undefined);
  assert.equal(findRestorablePeak(data, { ...note, range: [-0.03, 0.03] }), undefined);
});

test('invalid chart inputs are rejected before a chart can render them', () => {
  for (const patch of [
    { observation_windows: undefined }, { observation_windows: [{}] },
    { selection_rules: undefined }, { selection_rules: { min_width_phase: 0.2, max_width_phase: 0.1 } },
    { selection_rules: { min_width_phase: 0.001, max_width_phase: 1 } },
    { periodogram: { period_days: [1, 2], power: [1] } },
    { periodogram: { period_days: [2, 1], power: [1, 1] } },
    { peaks: [{ ...data.peaks[0], period_max: Infinity }] },
    { peaks: [{ ...data.peaks[0], period_days: -1 }] },
    { tic_id: null }, { id: '' }, { point_count: 12 },
    { normalized_flux: [1, NaN] },
  ]) assert.throws(() => assertObservation({ ...data, ...patch }), /관측 자료의 형식/);
});

test('every shipped observation matches its manifest, catalogue identity and covered time windows', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/observations/manifest.json', import.meta.url), 'utf8'));
  const catalogue: StarTarget[] = JSON.parse(readFileSync(new URL('../src/catalog.json', import.meta.url), 'utf8'));
  for (const target of catalogue) {
    const bytes = observationBytes(target.id);
    const observation: unknown = JSON.parse(bytes.toString('utf8'));
    assertObservation(observation);
    const entry = manifest.records.find((record: { file: string }) => record.file === `${target.id}.json`);
    assert.ok(entry, `${target.id} has a provenance manifest`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(observation.id, target.id);
    assert.equal(observation.tic_id, target.tic);
    assert.equal(observation.point_count, target.pointCount);
    assert.equal(observation.bundle_id, entry.bundleId);
    assert.deepEqual(observation.sectors, target.sectors);
    assert.ok(observation.time_btjd.every((time, index, all) => index === 0 || time >= all[index - 1]));
    assert.ok(observation.time_btjd.every(time => observation.observation_windows.some(window => time >= window.start_btjd - 1e-8 && time <= window.end_btjd + 1e-8)), `${target.id} plots all observations in its declared windows`);
  }
});
