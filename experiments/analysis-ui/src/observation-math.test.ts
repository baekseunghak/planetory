import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveTransit,
  foldTimes,
  MAX_TRANSIT_WINDOWS,
  normalizeInterval,
  normalizePhase,
  transitWindows,
} from './observation-math';
import type { PhaseSelection } from './observation-math';
import type { FoldResponse, WorkerRequest, WorkerResponse } from './fold.worker';

afterEach(() => vi.unstubAllGlobals());

const selection: PhaseSelection = { period_days: 2, phase_start: 0.2, phase_end: 0.3 };

describe('phase preview math using a fixed Bundle reference', () => {
  it('normalizes negative phases, complete cycles and negative zero into [0,1)', () => {
    expect([-2.25, -1, -0, 0.25, 2.25].map(normalizePhase)).toEqual([0.75, 0, 0, 0.25, 0.25]);
    expect(Object.is(normalizePhase(-0), -0)).toBe(false);
    expect(normalizePhase(-Number.MIN_VALUE)).toBe(0);
    for (const invalid of [NaN, Infinity, -Infinity])
      expect(() => normalizePhase(invalid)).toThrow(RangeError);
  });

  it('normalizes the same wrapped transit in either cycle without shortening its width', () => {
    for (const [start, end] of [
      [0.98, 1.02],
      [1.98, 2.02],
      [-0.02, 0.02],
    ]) {
      const normalized = normalizeInterval(start, end);
      expect(normalized.phase_start).toBeCloseTo(0.98, 14);
      expect(normalized.phase_end).toBeCloseTo(1.02, 14);
      expect(normalized.phase_end - normalized.phase_start).toBeCloseTo(0.04, 14);
    }
    expect(normalizeInterval(1.25, 1.75)).toEqual({ phase_start: 0.25, phase_end: 0.75 });
    for (const [start, end] of [
      [0.98, 0.02],
      [0, 0],
      [0, 1],
      [1, 3],
      [NaN, 1],
      [0, Infinity],
    ]) {
      expect(() => normalizeInterval(start, end)).toThrow(RangeError);
    }
  });

  it('folds every unsorted observation around the supplied reference without changing its input', () => {
    const times = Object.freeze([11, -1, 0, 7.5]);
    const phases = foldTimes(times, 2, 3);
    expect(phases).toBeInstanceOf(Float64Array);
    expect(phases).toHaveLength(times.length);
    [0, 0, 1 / 3, 5 / 6].forEach((phase, index) => expect(phases[index]).toBeCloseTo(phase, 14));
    expect(times).toEqual([11, -1, 0, 7.5]);
    expect(foldTimes([], 2, 3)).toHaveLength(0);
    expect(() => foldTimes([1, NaN], 2, 3)).toThrow(RangeError);
  });

  it('chooses the earlier epoch at an exact tie and preserves the original six-day duration', () => {
    const result = deriveTransit(
      { period_days: 6, phase_start: 0.49, phase_end: 0.51 },
      1006,
      [1012, 1000, 1003, 1007.5],
    );
    expect(result.epoch_btjd).toBe(1003);
    expect(result.duration_days).toBeCloseTo(0.12, 14);
  });

  it('uses observation bounds rather than snapping an epoch to an irregular observed sample', () => {
    const irregular = [15, 2, 12, 2.25];
    const result = deriveTransit({ ...selection, period_days: 4 }, 5, irregular);
    expect(result.epoch_btjd).toBe(6);
    expect(irregular).not.toContain(result.epoch_btjd);
    expect(
      deriveTransit({ period_days: 2, phase_start: 0.9, phase_end: 1.1 }, 50, [10, 12]).epoch_btjd,
    ).toBe(12);
  });

  it('accepts boundary epochs and repeated times but rejects a range with no transit center', () => {
    const centered: PhaseSelection = { period_days: 2, phase_start: 0.9, phase_end: 1.1 };
    expect(deriveTransit(centered, 10, [9, 10]).epoch_btjd).toBe(10);
    expect(deriveTransit(centered, 10, [10, 10]).epoch_btjd).toBe(10);
    expect(
      deriveTransit({ period_days: 2, phase_start: 0.4, phase_end: 0.6 }, 10, [11]).epoch_btjd,
    ).toBe(11);
    expect(() => deriveTransit(centered, 10, [10.2, 10.4])).toThrow(/중심/);
  });

  it('derives the same transit for normalized copies of a boundary-crossing interval', () => {
    const first = deriveTransit(
      { period_days: 3, ...normalizeInterval(0.98, 1.02) },
      1006,
      [1000, 1012],
    );
    const second = deriveTransit(
      { period_days: 3, ...normalizeInterval(1.98, 2.02) },
      1006,
      [1000, 1012],
    );
    expect(first).toEqual(second);
    expect(first.epoch_btjd).toBe(1006);
    expect(first.duration_days).toBeCloseTo(0.12, 14);
  });

  it('returns complete intersecting windows, including partial edge transits, without requiring an in-range center', () => {
    const wrapped: PhaseSelection = { period_days: 1, phase_start: 0.98, phase_end: 1.02 };
    const windows = transitWindows(wrapped, 0, [2.01, 0.99]);
    expect(windows).toHaveLength(2);
    expect(windows[0].start).toBeCloseTo(0.98, 14);
    expect(windows[0].end).toBeCloseTo(1.02, 14);
    expect(windows[1].start).toBeCloseTo(1.98, 14);
    expect(windows[1].end).toBeCloseTo(2.02, 14);
    const edgeOnly = transitWindows(wrapped, 0, [0.01, 0.015]);
    expect(edgeOnly).toHaveLength(1);
    expect(edgeOnly[0].start).toBeCloseTo(-0.02, 14);
    expect(edgeOnly[0].end).toBeCloseTo(0.02, 14);
    expect(() => deriveTransit(wrapped, 0, [0.01, 0.015])).toThrow(/중심/);
    expect(transitWindows(wrapped, 0, [0.4, 0.6])).toEqual([]);
  });

  it('includes bands touching a boundary and rejects excess bands rather than silently truncating', () => {
    expect(
      transitWindows({ period_days: 2, phase_start: 0.25, phase_end: 0.75 }, 0, [1.5, 2.5]),
    ).toEqual([
      { start: 0.5, end: 1.5 },
      { start: 2.5, end: 3.5 },
    ]);
    expect(() =>
      transitWindows({ ...selection, period_days: 1 }, 0, [0, MAX_TRANSIT_WINDOWS + 1]),
    ).toThrow(/10,000/);
  });

  it('rejects invalid selection, reference and observation inputs before producing preview values', () => {
    for (const period_days of [0, -1, NaN, Infinity]) {
      expect(() => deriveTransit({ ...selection, period_days }, 0, [0, 10])).toThrow(RangeError);
      expect(() => foldTimes([0, 1], 0, period_days)).toThrow(RangeError);
      expect(() => transitWindows({ ...selection, period_days }, 0, [0, 10])).toThrow(RangeError);
    }
    for (const interval of [
      { phase_start: -0.1, phase_end: 0.1 },
      { phase_start: 1, phase_end: 1.1 },
      { phase_start: 0.2, phase_end: 0.2 },
      { phase_start: 0.2, phase_end: 1.2 },
    ]) {
      expect(() => deriveTransit({ period_days: 2, ...interval }, 0, [0, 10])).toThrow(RangeError);
    }
    for (const times of [[], [0, NaN], [Infinity]]) {
      expect(() => deriveTransit(selection, 0, times)).toThrow(RangeError);
      expect(() => transitWindows(selection, 0, times)).toThrow(RangeError);
    }
    expect(() => deriveTransit(selection, NaN, [0, 10])).toThrow(RangeError);
    expect(() => foldTimes([0], Infinity, 2)).toThrow(RangeError);
  });
});

describe('fold worker protocol (unit test, not a browser Worker execution)', () => {
  interface Reply {
    response: WorkerResponse;
    transfer?: Transferable[];
  }

  async function startWorker() {
    vi.resetModules();
    const worker = {
      onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
      postMessage: vi.fn<(message: WorkerResponse, transfer?: Transferable[]) => void>(),
    };
    vi.stubGlobal('self', worker);
    await import('./fold.worker');
    return (data: WorkerRequest): Reply => {
      const index = worker.postMessage.mock.calls.length;
      worker.onmessage?.({ data } as MessageEvent<WorkerRequest>);
      expect(worker.postMessage).toHaveBeenCalledTimes(index + 1);
      const [response, transfer] = worker.postMessage.mock.calls[index];
      return { response, transfer };
    };
  }

  function folded(reply: Reply): FoldResponse {
    expect(reply.response.type).toBe('folded');
    if (reply.response.type !== 'folded') throw new Error('Expected a fold response');
    expect(reply.response.phases).toBeInstanceOf(Float64Array);
    expect(reply.transfer).toEqual([reply.response.phases.buffer]);
    return reply.response;
  }

  it('initializes observations once and folds multiple periods with data IDs, revisions and transferable results', async () => {
    const send = await startWorker();
    expect(send({ type: 'init', dataId: 'bundle-a', times: [-1, 0, 1], reference: 0 })).toEqual({
      response: { type: 'ready', dataId: 'bundle-a' },
      transfer: undefined,
    });
    const first = folded(send({ type: 'fold', dataId: 'bundle-a', revision: 7, period: 2 }));
    expect(first).toMatchObject({ dataId: 'bundle-a', revision: 7 });
    expect(first.error).toBeUndefined();
    expect([...first.phases]).toEqual([0.5, 0, 0.5]);
    const second = folded(send({ type: 'fold', dataId: 'bundle-a', revision: 8, period: 4 }));
    expect(second).toMatchObject({ dataId: 'bundle-a', revision: 8 });
    expect(second.error).toBeUndefined();
    expect([...second.phases]).toEqual([0.75, 0, 0.25]);
  });

  it('rejects absent or wrong data and discards the previous cache when replacement initialization fails', async () => {
    const send = await startWorker();
    const beforeInit = folded(send({ type: 'fold', dataId: 'bundle-a', revision: 1, period: 2 }));
    expect(beforeInit.error).toMatch(/초기화/);
    expect(beforeInit.phases).toHaveLength(0);
    send({ type: 'init', dataId: 'bundle-a', times: [-1, 0, 1], reference: 0 });
    const wrongData = folded(send({ type: 'fold', dataId: 'bundle-b', revision: 2, period: 2 }));
    expect(wrongData).toMatchObject({ dataId: 'bundle-b', revision: 2 });
    expect(wrongData.error).toMatch(/일치/);
    expect(wrongData.phases).toHaveLength(0);
    expect(
      folded(send({ type: 'fold', dataId: 'bundle-a', revision: 3, period: 2 })).error,
    ).toBeUndefined();

    expect(
      send({ type: 'init', dataId: 'bundle-b', times: [0, 1], reference: NaN }).response,
    ).toMatchObject({
      type: 'init-error',
      dataId: 'bundle-b',
      error: expect.any(String),
    });
    const discarded = folded(send({ type: 'fold', dataId: 'bundle-a', revision: 4, period: 2 }));
    expect(discarded.error).toMatch(/초기화/);
    expect(discarded.phases).toHaveLength(0);
    for (const times of [[], [0, Infinity]]) {
      expect(
        send({ type: 'init', dataId: 'bundle-b', times, reference: 0 }).response,
      ).toMatchObject({
        type: 'init-error',
        dataId: 'bundle-b',
        error: expect.any(String),
      });
    }
    expect(
      send({ type: 'init', dataId: 'bundle-b', times: [10, 11], reference: 10 }).response,
    ).toEqual({
      type: 'ready',
      dataId: 'bundle-b',
    });
    const reinitialized = folded(
      send({ type: 'fold', dataId: 'bundle-b', revision: 5, period: 2 }),
    );
    expect(reinitialized.error).toBeUndefined();
    expect([...reinitialized.phases]).toEqual([0, 0.5]);
  });

  it('returns a transferable empty error result for an invalid period and recovers without reinitializing', async () => {
    const send = await startWorker();
    send({ type: 'init', dataId: 'bundle-a', times: [-1, 0, 1], reference: 0 });
    const failure = folded(send({ type: 'fold', dataId: 'bundle-a', revision: 13, period: 0 }));
    expect(failure).toMatchObject({ dataId: 'bundle-a', revision: 13 });
    expect(failure.error).toMatch(/주기/);
    expect(failure.phases).toHaveLength(0);
    const recovered = folded(send({ type: 'fold', dataId: 'bundle-a', revision: 14, period: 2 }));
    expect(recovered).toMatchObject({ dataId: 'bundle-a', revision: 14 });
    expect(recovered.error).toBeUndefined();
    expect([...recovered.phases]).toEqual([0.5, 0, 0.5]);
  });
});
