import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldPoints, formatPowerTick, normalizePhaseRange, phaseAt, phaseInRange, powerAxisMaximum, previewTransit, zoomWindow } from '../src/chart-math';

test('fixed reference folds negative and repeated observation times equivalently', () => {
  assert.equal(phaseAt(99, 4, 100), 0.75);
  assert.equal(phaseAt(103, 4, 100), 0.75);
  assert.equal(phaseAt(107, 4, 100), 0.75);
  assert.ok(Number.isNaN(phaseAt(100, 0, 100)));
});

test('range crosses phase zero without inflating transit duration', () => {
  const range = normalizePhaseRange(0.95, 1.05, 0.01, 0.3);
  assert.ok(Math.abs(range[0] - 0.95) < 1e-12);
  assert.ok(Math.abs(range[1] - 1.05) < 1e-12);
  assert.ok(phaseInRange(0.01, range));
  assert.ok(phaseInRange(0.99, range));
  assert.ok(!phaseInRange(0.5, range));
  const secondCycle = normalizePhaseRange(1.95, 2.05, 0.01, 0.3);
  assert.ok(Math.abs(secondCycle[0] - range[0]) < 1e-12);
  assert.ok(Math.abs(secondCycle[1] - range[1]) < 1e-12);
});

test('reverse dragging and configured width constraints normalize safely', () => {
  assert.deepEqual(normalizePhaseRange(0.5, 0.25, 0.02, 0.2), [0.25, 0.45]);
  const small = normalizePhaseRange(0.3, 0.3, 0.02, 0.2);
  assert.ok(Math.abs(small[1] - small[0] - 0.02) < 1e-12);
  assert.throws(() => normalizePhaseRange(NaN, 0.2), RangeError);
  assert.throws(() => normalizePhaseRange(0, 0.2, 0.5, 0.1), RangeError);
  assert.throws(() => normalizePhaseRange(0, 0.2, 0.001, 1), RangeError);
});

test('epoch preview obeys observed range and chooses earlier epoch on ties', () => {
  const transit = previewTransit([0.2, 0.3], 4, 100, 95, 110)!;
  assert.equal(transit.epoch, 101);
  assert.ok(Math.abs(transit.durationHours - 9.6) < 1e-10);
  assert.equal(previewTransit([0.45, 0.55], 4, 100, 95, 105)!.epoch, 98);
  assert.equal(previewTransit([0.45, 0.55], 4, 100, 100, 101), null);
});

test('folding preserves every input point and omits invalid values from means', () => {
  const folded = foldPoints([100, 101, 102, 103, 104], [1, 2, NaN, 4, 5], 4, 100, 4);
  assert.equal(folded.phases.length, 5);
  assert.deepEqual([...folded.phases], [0, 0.25, 0.5, 0.75, 0]);
  assert.deepEqual([...folded.counts], [2, 1, 0, 1]);
  assert.equal(folded.means[0], 3);
  assert.ok(Number.isNaN(folded.means[2]));
  assert.throws(() => foldPoints([1], [], 1, 0), RangeError);
});

test('zoom remains inside the two-cycle domain', () => {
  assert.deepEqual(zoomWindow(1, 0), [0, 2]);
  assert.deepEqual(zoomWindow(8, 0), [0, 0.25]);
  assert.deepEqual(zoomWindow(8, 2), [1.75, 2]);
});

test('all observation bundles retain their raw BLS scale and visible peaks', () => {
  for (const id of ['toi270', 'l98-59', 'cm-dra']) {
    const observation = JSON.parse(readFileSync(new URL(`../public/observations/${id}.json`, import.meta.url), 'utf8'));
    const powers: number[] = observation.periodogram.power;
    const maximum = Math.max(...powers);
    const axisMaximum = powerAxisMaximum(powers);
    assert.ok(maximum / axisMaximum > 0.87 && maximum / axisMaximum < 0.90, `${id}: peak remains visible`);
    const ticks = [0, 1, 2, 3, 4].map(i => formatPowerTick(axisMaximum * i / 4, axisMaximum));
    assert.equal(new Set(ticks).size, 5, `${id}: tick labels stay distinct`);
    if (id !== 'cm-dra') assert.match(ticks[4], /e-/);
  }
});

test('tiny positive BLS values are not flattened by a fixed lower bound', () => {
  assert.ok(powerAxisMaximum([1e-20, 2e-20]) < 3e-20);
  assert.ok(powerAxisMaximum([0, NaN]) > 0);
  assert.equal(formatPowerTick(0, 0.0005), '0');
  assert.equal(formatPowerTick(0.00025, 0.0005), '2.5e-4');
});
