import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  FoldClient,
  type FoldWorker,
} from "../../src/features/analysis/fold-client";
import type {
  FoldRequest,
  WorkerRequest,
  WorkerResponse,
} from "../../src/features/analysis/fold-worker-core";

class FakeWorker implements FoldWorker {
  onmessage: FoldWorker["onmessage"] = null;
  onerror: FoldWorker["onerror"] = null;
  onmessageerror: FoldWorker["onmessageerror"] = null;
  messages: WorkerRequest[] = [];
  terminated = false;
  postMessage(message: WorkerRequest) {
    this.messages.push(structuredClone(message));
  }
  terminate() {
    this.terminated = true;
  }
  send(data: WorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<WorkerResponse>);
  }
  ready(dataId = "A") {
    this.send({ type: "ready", dataId });
  }
  folds() {
    return this.messages.filter((m): m is FoldRequest => m.type === "fold");
  }
  complete(job: FoldRequest, phases = [0, 0.5, 0]) {
    this.send({
      type: "folded",
      dataId: job.dataId,
      revision: job.revision,
      phases: new Float64Array(phases),
    });
  }
}
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workers: FakeWorker[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const times = new Float64Array([0, 1, 2]);
  const client = new FoldClient(
    { dataId: "A", reference: 0, times },
    {
      timeoutMs: 100, // Test clock only, not a production limit.
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      requestFrame: (callback) => {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelFrame: (id) => {
        frames.delete(id);
      },
    },
  );
  t.after(() => client.dispose());
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((cb) => cb(0));
  };
  return { client, workers, frames, flush, times };
}

test("initialization is sent once; one frame emits only the latest input and does not resend times", async (t) => {
  const { client, workers, flush, times } = setup(t);
  const first = client.request(2),
    second = client.request(3),
    last = client.request(4);
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(workers.length, 1);
  times.fill(999);
  workers[0].ready();
  flush();
  assert.deepEqual(
    workers[0].folds().map((j) => j.period),
    [4],
  );
  workers[0].complete(workers[0].folds()[0]);
  const result = await last;
  assert.equal(result?.periodDays, 4);
  assert.ok(client.isCurrent(result!));
  const next = client.request(5);
  flush();
  assert.equal(client.isCurrent(result!), false);
  workers[0].complete(workers[0].folds()[1]);
  await next;
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.filter((m) => m.type === "init").length, 1);
  const init = workers[0].messages[0];
  assert.ok(init.type === "init");
  assert.deepEqual([...init.times], [0, 1, 2]);
  for (const message of workers[0].folds())
    assert.equal("times" in message, false);
});

test("100 rapid inputs retain one running job and the latest queued input; stale replies cannot settle it", async (t) => {
  const { client, workers, flush } = setup(t);
  const first = client.request(2);
  workers[0].ready();
  flush();
  const pending = Array.from({ length: 100 }, (_, i) => client.request(i + 3));
  flush();
  assert.equal(workers[0].folds().length, 1);
  assert.equal(await first, null);
  assert.ok((await Promise.all(pending.slice(0, -1))).every((v) => v === null));
  workers[0].complete(workers[0].folds()[0]);
  flush();
  assert.deepEqual(
    workers[0].folds().map((j) => j.period),
    [2, 102],
  );
  let settled = false;
  void pending.at(-1)!.then(() => {
    settled = true;
  });
  workers[0].complete(workers[0].folds()[0]);
  workers[0].complete({ ...workers[0].folds()[1], dataId: "old-star" });
  workers[0].complete({ ...workers[0].folds()[1], revision: 999 });
  await Promise.resolve();
  assert.equal(settled, false);
  workers[0].complete(workers[0].folds()[1]);
  assert.equal((await pending.at(-1))?.periodDays, 102);
});

test("invalid period leaves an already valid in-flight input intact", async (t) => {
  const { client, workers, flush } = setup(t);
  const valid = client.request(2);
  workers[0].ready();
  flush();
  await assert.rejects(client.request(NaN));
  workers[0].complete(workers[0].folds()[0]);
  assert.ok(client.isCurrent((await valid)!));
});

test("initialization and active-work watchdogs expire even if newer inputs keep arriving", async (t) => {
  const { client, workers, flush } = setup(t);
  const initial = assert.rejects(client.request(2), /응답/);
  t.mock.timers.tick(100);
  await initial;
  assert.equal(workers[0].terminated, true);
  const next = client.request(3);
  workers[1].ready();
  flush();
  t.mock.timers.tick(99);
  const last = assert.rejects(client.request(4), /응답/);
  assert.equal(await next, null);
  t.mock.timers.tick(1);
  await last;
  assert.equal(workers[1].terminated, true);
});

test("Worker crash rejects latest queued job and retry ignores replies from the old instance", async (t) => {
  const { client, workers, flush } = setup(t);
  const first = client.request(2);
  workers[0].ready();
  flush();
  const failure = assert.rejects(client.request(3), /Worker/);
  await first;
  workers[0].onerror?.({ preventDefault() {} } as ErrorEvent);
  await failure;
  assert.ok(workers[0].terminated);
  const retry = client.request(3);
  workers[0].ready();
  workers[0].complete(workers[0].folds()[0]);
  flush();
  assert.equal(workers[1].folds().length, 0);
  workers[1].ready();
  flush();
  workers[1].complete(workers[1].folds()[0]);
  assert.equal((await retry)?.periodDays, 3);
});

test("decode and init errors terminate Worker and reject the request", async (t) => {
  const { client, workers } = setup(t);
  const first = assert.rejects(client.request(2), /초기화/);
  workers[0].send({ type: "init-error", dataId: "A", error: "초기화 실패" });
  await first;
  const next = assert.rejects(client.request(3), /읽지/);
  workers[1].onmessageerror?.({} as MessageEvent);
  await next;
  assert.ok(workers.every((w) => w.terminated));
});

test("invalid result values/count and calculation errors reject without losing the reusable cache", async (t) => {
  const { client, workers, flush } = setup(t);
  for (const phases of [[0], [NaN, 0, 0], [-0.1, 0, 0], [1, 0, 0]]) {
    const failed = assert.rejects(client.request(2), /관측점/);
    workers[0].ready();
    flush();
    workers[0].complete(workers[0].folds().at(-1)!, phases);
    await failed;
  }
  const failed = assert.rejects(client.request(2), /계산 실패/);
  flush();
  const job = workers[0].folds().at(-1)!;
  workers[0].send({
    type: "fold-error",
    dataId: "A",
    revision: job.revision,
    error: "계산 실패",
  });
  await failed;
  const good = client.request(2);
  flush();
  workers[0].complete(workers[0].folds().at(-1)!);
  await good;
  assert.equal(workers.length, 1);
});

test("cancel/dispose clear pending frames and results and allow retry only after cancel", async (t) => {
  const { client, workers, flush, frames } = setup(t);
  const pending = client.request(2);
  workers[0].ready();
  assert.equal(frames.size, 1);
  client.cancel();
  assert.equal(await pending, null);
  assert.equal(frames.size, 0);
  workers[0].ready();
  flush();
  assert.equal(workers[0].folds().length, 0);
  const retry = client.request(3);
  workers[1].ready();
  flush();
  workers[1].complete(workers[1].folds()[0]);
  const result = (await retry)!;
  client.dispose();
  assert.equal(client.isCurrent(result), false);
  assert.equal(await client.request(4), null);
  t.mock.timers.tick(1000);
  assert.ok(workers.every((w) => w.terminated));
});

test("Worker construction/postMessage failures reject instead of leaving pending requests", async () => {
  for (const createWorker of [
    () => {
      throw new Error("construction");
    },
    () => {
      const worker = new FakeWorker();
      worker.postMessage = () => {
        throw new Error("postMessage");
      };
      return worker;
    },
  ]) {
    const client = new FoldClient(
      { dataId: "A", times: new Float64Array([0]), reference: 0 },
      { timeoutMs: 100, createWorker },
    );
    try {
      await assert.rejects(client.request(2), /construction|postMessage/);
    } finally {
      client.dispose();
    }
  }
});
