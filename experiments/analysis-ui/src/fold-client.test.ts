import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoldClient, FOLD_TIMEOUT_MS, type FoldWorker } from './fold-client';
import type { FoldRequest, WorkerRequest, WorkerResponse } from './fold.worker';

class TestWorker implements FoldWorker {
  onmessage: FoldWorker['onmessage'] = null;
  onerror: FoldWorker['onerror'] = null;
  messages: WorkerRequest[] = [];
  terminated = false;
  postMessage(message: WorkerRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  send(data: WorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<WorkerResponse>);
  }
  ready() {
    this.send({ type: 'ready', dataId: 'bundle-A' });
  }
  folds() {
    return this.messages.filter((m): m is FoldRequest => m.type === 'fold');
  }
  complete(request: FoldRequest, phases = [0, 0.5, 0]) {
    this.send({
      type: 'folded',
      dataId: request.dataId,
      revision: request.revision,
      phases: new Float64Array(phases),
    });
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const clients: FoldClient[] = [];
function flushFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
function setup() {
  const workers: TestWorker[] = [];
  const client = new FoldClient({ dataId: 'bundle-A', times: [0, 1, 2], reference: 0 }, () => {
    const worker = new TestWorker();
    workers.push(worker);
    return worker;
  });
  clients.push(client);
  return { client, workers };
}
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('persistent fold scheduling', () => {
  it('initializes observations once and sends only the latest period in each frame', async () => {
    const { client, workers } = setup();
    const first = client.request(2),
      second = client.request(3),
      third = client.request(4);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toEqual([
      { type: 'init', dataId: 'bundle-A', times: [0, 1, 2], reference: 0 },
    ]);
    workers[0].ready();
    flushFrame();
    expect(workers[0].folds().map((f) => f.period)).toEqual([4]);
    workers[0].complete(workers[0].folds()[0]);
    await expect(third).resolves.toEqual(new Float64Array([0, 0.5, 0]));
    const fourth = client.request(5);
    flushFrame();
    workers[0].complete(workers[0].folds()[1]);
    await fourth;
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].messages.filter((m) => m.type === 'init')).toHaveLength(1);
    for (const message of workers[0].folds()) expect(message).not.toHaveProperty('times');
  });

  it('bounds work to one active and one latest input, and ignores duplicate old replies', async () => {
    const { client, workers } = setup();
    const first = client.request(2);
    workers[0].ready();
    flushFrame();
    const second = client.request(3),
      third = client.request(4);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    flushFrame();
    expect(workers[0].folds().map((f) => f.period)).toEqual([2]);
    workers[0].complete(workers[0].folds()[0]);
    flushFrame();
    expect(workers[0].folds().map((f) => f.period)).toEqual([2, 4]);
    const settled = vi.fn();
    void third.then(settled);
    workers[0].complete(workers[0].folds()[0], [0.9, 0.9, 0.9]);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    workers[0].complete(workers[0].folds()[1], [0.1, 0.2, 0.3]);
    await expect(third).resolves.toEqual(new Float64Array([0.1, 0.2, 0.3]));
  });

  it('rejects the latest input on a crash and reinitializes on the next request', async () => {
    const { client, workers } = setup();
    const first = client.request(2);
    workers[0].ready();
    flushFrame();
    const pending = client.request(3);
    await first;
    const failed = expect(pending).rejects.toThrow(/Worker/);
    const preventDefault = vi.fn();
    workers[0].onerror?.({ preventDefault } as unknown as ErrorEvent);
    await failed;
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(workers[0].terminated).toBe(true);
    const retry = client.request(3);
    expect(workers).toHaveLength(2);
    workers[0].complete(workers[0].folds()[0]);
    workers[1].ready();
    flushFrame();
    workers[1].complete(workers[1].folds()[0]);
    await expect(retry).resolves.toHaveLength(3);
  });

  it('times out unresponsive initialization and an active fold, even when newer inputs arrive', async () => {
    const { client, workers } = setup();
    const first = client.request(2);
    const initFailed = expect(first).rejects.toThrow(/초과/);
    vi.advanceTimersByTime(FOLD_TIMEOUT_MS);
    await initFailed;
    expect(workers[0].terminated).toBe(true);
    const next = client.request(3);
    workers[1].ready();
    flushFrame();
    vi.advanceTimersByTime(FOLD_TIMEOUT_MS - 1);
    const latest = client.request(4);
    await expect(next).resolves.toBeNull();
    const failed = expect(latest).rejects.toThrow(/초과/);
    vi.advanceTimersByTime(1);
    await failed;
    expect(workers[1].terminated).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('keeps the cache after a fold error and allows a corrected request', async () => {
    const { client, workers } = setup();
    const bad = client.request(0);
    workers[0].ready();
    flushFrame();
    const failed = expect(bad).rejects.toThrow('invalid period');
    workers[0].send({
      type: 'folded',
      dataId: 'bundle-A',
      revision: workers[0].folds()[0].revision,
      phases: new Float64Array(),
      error: 'invalid period',
    });
    await failed;
    const good = client.request(2);
    flushFrame();
    workers[0].complete(workers[0].folds()[1]);
    await expect(good).resolves.toHaveLength(3);
    expect(workers).toHaveLength(1);
  });

  it('disposes pending animation frames and ignores callbacks from a previous target', async () => {
    const { client, workers } = setup();
    const pending = client.request(2);
    workers[0].ready();
    expect(frames.size).toBe(1);
    client.dispose();
    await expect(pending).resolves.toBeNull();
    expect(frames.size).toBe(0);
    expect(workers[0].terminated).toBe(true);
    workers[0].ready();
    flushFrame();
    expect(workers[0].folds()).toHaveLength(0);
    await expect(client.request(3)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
