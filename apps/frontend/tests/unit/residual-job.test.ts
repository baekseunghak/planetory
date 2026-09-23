import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/client";
import {
  MIN_POLL_MS,
  requestResidualJob,
  runResidualJob,
  type ResidualProgress,
} from "../../src/features/analysis/residual-job";

// 7.1·7.2절. 요청 ID가 없고 목표 문맥이 멱등 단위다.

const TIC = "259377024";
const target = {
  bundleId: "9007199254741093",
  curveStep: 1,
  removedCandidateIds: ["c-401"],
  residualModelVersion: "rm-1",
  periodogramConfigVersion: "pg-1",
};
const resultContext = {
  bundleId: target.bundleId,
  curveStep: 1,
  removedCandidateIds: ["c-401"],
  residualModelVersion: "rm-1",
  periodogramConfigVersion: "pg-1",
};
type Step =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | { error: ApiError };
function harness(steps: Step[]) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const waits: number[] = [];
  const request = (async (path: string, options: Record<string, any> = {}) => {
    const step = steps.shift();
    if (!step) throw new Error(`대본에 없는 요청: ${path}`);
    calls.push({ path, method: options.method ?? "GET", body: options.json });
    options.onResponse?.({
      status: "error" in step ? 0 : (step.status ?? 200),
      headers: new Headers("error" in step ? {} : (step.headers ?? {})),
    });
    if ("error" in step) throw step.error;
    return step.body;
  }) as never;
  const progress: ResidualProgress[] = [];
  return {
    calls,
    waits,
    progress,
    run: (signal = new AbortController().signal, entryBundleId?: string) =>
      runResidualJob({
        request,
        ticId: TIC,
        target,
        signal,
        entryBundleId,
        onProgress: (value) => void progress.push(value),
        wait: async (ms) => void waits.push(ms),
      }),
    post: (signal = new AbortController().signal) =>
      requestResidualJob({ request, ticId: TIC, target, signal }),
  };
}
const refused = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
) => new ApiError(status, code, code, [], null, null, false, details);
const queued = (jobId = "rj-1", pollAfterSeconds = 2) => ({
  status: 202,
  body: { jobId, status: "QUEUED", cacheHit: false, pollAfterSeconds },
});

test("a cached target finishes without any polling", async () => {
  const stub = harness([
    {
      status: 200,
      body: {
        jobId: null,
        status: "COMPLETED",
        cacheHit: true,
        resultCurveContext: resultContext,
      },
    },
  ]);
  const outcome = await stub.run();
  assert.equal(outcome.state, "ready");
  assert.equal(outcome.state === "ready" && outcome.cacheHit, true);
  // 이미 계산돼 있으면 기다릴 것이 없다.
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.waits, []);
  // 요청 ID를 싣지 않는다. 목표 문맥이 멱등 단위다.
  assert.deepEqual(Object.keys(stub.calls[0].body as object), ["target"]);
});

test("the whole order is reported and the server sets the pace", async () => {
  const stub = harness([
    queued("rj-7", 2),
    {
      body: {
        jobId: "rj-7",
        status: "RESIDUAL_CALCULATING",
        pollAfterSeconds: 3,
      },
    },
    { body: { jobId: "rj-7", status: "RESIDUAL_READY", pollAfterSeconds: 1 } },
    {
      body: {
        jobId: "rj-7",
        status: "PERIODOGRAM_CALCULATING",
        pollAfterSeconds: 1,
      },
    },
    {
      body: {
        jobId: "rj-7",
        status: "COMPLETED",
        resultCurveContext: resultContext,
      },
    },
  ]);
  const outcome = await stub.run();
  assert.equal(outcome.state, "ready");
  // 2.4절 순서를 빠짐없이 알린다. 화면이 이것으로 진행을 그린다.
  assert.deepEqual(
    stub.progress.map((item) => item.status),
    [
      "QUEUED",
      "RESIDUAL_CALCULATING",
      "RESIDUAL_READY",
      "PERIODOGRAM_CALCULATING",
      "COMPLETED",
    ],
  );
  // 간격은 서버가 정한다. 우리가 고르지 않는다.
  assert.deepEqual(stub.waits, [2000, 3000, 1000, 1000]);
});

test("a server that says zero still does not get hammered", async () => {
  const stub = harness([
    queued("rj-8", 0),
    {
      body: {
        jobId: "rj-8",
        status: "COMPLETED",
        resultCurveContext: resultContext,
      },
    },
  ]);
  await stub.run();
  assert.deepEqual(stub.waits, [MIN_POLL_MS]);
});

test("a failure keeps its reason instead of becoming a generic error", async () => {
  const stub = harness([
    queued("rj-9", 1),
    {
      body: {
        jobId: "rj-9",
        status: "FAILED",
        failure: {
          code: "RESIDUAL_FAILED",
          message: "잔차 계산에 실패했습니다.",
        },
        resultCurveContext: null,
      },
    },
  ]);
  const outcome = await stub.run();
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.state === "failed" && outcome.code, "RESIDUAL_FAILED");
  // 실패해도 곡선을 바꾸지 않는다. 바꿀 문맥 자체를 돌려주지 않는다.
  assert.equal("curveContext" in outcome, false);
});

test("the two queue refusals are not the same thing", async () => {
  // 대기열이 찼다. 기다리면 된다.
  const full = harness([
    { error: refused(429, "RESIDUAL_QUEUE_FULL", { retryAfterSeconds: 12 }) },
  ]);
  const waiting = await full.post();
  assert.equal(waiting.state, "queue-full");
  assert.equal(waiting.state === "queue-full" && waiting.retryAfterSeconds, 12);
  assert.equal(waiting.state === "queue-full" && waiting.activeJobId, null);

  // 내가 이미 돌리고 있는 작업이다. 기다리라고 하면 안 된다(D-4).
  const mine = harness([
    {
      error: refused(429, "RESIDUAL_QUEUE_FULL", {
        retryAfterSeconds: 5,
        activeJobId: "rj-other",
      }),
    },
  ]);
  const active = await mine.post();
  assert.equal(active.state === "queue-full" && active.activeJobId, "rj-other");
});

test("a changed plate is not retried here", async () => {
  const stub = harness([
    {
      error: refused(409, "BUNDLE_CHANGED", {
        currentBundleId: "9007199254749999",
      }),
    },
  ]);
  const outcome = await stub.run();
  assert.equal(outcome.state, "bundle-changed");
  assert.equal(
    outcome.state === "bundle-changed" && outcome.currentBundleId,
    "9007199254749999",
  );
  // 새 판으로 다시 두드리지 않는다. 최신 판 재조회는 화면의 몫이다.
  assert.equal(stub.calls.length, 1);
});

test("an unknown state is refused rather than drawn as progress", async () => {
  const stub = harness([
    { status: 202, body: { jobId: "rj-1", status: "THINKING" } },
  ]);
  await assert.rejects(() => stub.run(), /status/);
});

test("a job that vanished is asked for again, not reported as a failure", () => {
  // 7.2절: Redis 재시작으로 작업이 사라지면 404 RESOURCE_NOT_FOUND다. 실패가
  // 아니라 상태를 잃은 것이라 같은 목표로 7.1절을 다시 부른다(분석 프론트 8.1).
  const box = harness([
    queued("rj-1"),
    { error: refused(404, "RESOURCE_NOT_FOUND") },
    queued("rj-2"),
    {
      status: 200,
      body: {
        jobId: "rj-2",
        status: "COMPLETED",
        resultCurveContext: resultContext,
      },
    },
  ]);
  return box.run().then((outcome) => {
    assert.equal(outcome.state, "ready");
    // 사용자가 [다시 시도]를 누르지 않아도 스스로 복구한다.
    assert.deepEqual(
      box.calls.map((call) => call.method),
      ["POST", "GET", "POST", "GET"],
    );
    // 다시 부르는 것은 **같은 목표**다. 요청 ID가 없어 이것이 곧 복구다.
    assert.deepEqual(box.calls[2].body, box.calls[0].body);
    assert.equal(box.calls[2].path, box.calls[0].path);
  });
});

test("a job that keeps vanishing is told to the user instead of looping", () => {
  const box = harness([
    queued("rj-1"),
    { error: refused(404, "RESOURCE_NOT_FOUND") },
    queued("rj-2"),
    { error: refused(404, "RESOURCE_NOT_FOUND") },
  ]);
  return box.run().then((outcome) => {
    assert.equal(outcome.state, "failed");
    assert.equal(
      outcome.state === "failed" && outcome.code,
      "RESOURCE_NOT_FOUND",
    );
    // 두 번째부터는 다시 요청하지 않는다. 무한히 돌지 않는다.
    assert.equal(box.calls.length, 4);
  });
});

test("a failure says whether trying again is worth it", async () => {
  // 7.2절 `failure.retryable`. 눌러도 같은 결과인 버튼을 내지 않기 위해서다.
  const fail = (failure: Record<string, unknown>) =>
    harness([
      queued("rj-9", 1),
      {
        body: {
          jobId: "rj-9",
          status: "FAILED",
          failure: { code: "C", message: "m", ...failure },
          resultCurveContext: null,
        },
      },
    ]).run();

  const permanent = await fail({ retryable: false });
  assert.equal(permanent.state === "failed" && permanent.retryable, false);
  const transient = await fail({ retryable: true });
  assert.equal(transient.state === "failed" && transient.retryable, true);
  // 값이 없으면 참으로 둔다. 모르는 것 때문에 나갈 길을 막지 않는다.
  const unknown = await fail({});
  assert.equal(unknown.state === "failed" && unknown.retryable, true);
});

test("polling notices the plate changing under it", async () => {
  // D-5: 계산이 도는 동안의 판 교체를 잡는 유일한 길이다. 409는 POST에만
  // 오고 FAILED(BUNDLE_ARCHIVED)는 88번 몫이다.
  const stub = harness([
    queued("rj-9", 1),
    {
      headers: { "X-Current-Bundle": "9007199254749999" },
      body: {
        jobId: "rj-9",
        status: "COMPLETED",
        resultCurveContext: resultContext,
      },
    },
  ]);
  const outcome = await stub.run(undefined, target.bundleId);
  // COMPLETED여도 옛 판 결과라 쓰지 않는다.
  assert.equal(outcome.state, "bundle-changed");
  assert.equal(
    outcome.state === "bundle-changed" && outcome.currentBundleId,
    "9007199254749999",
  );
});

test("a missing header is unknown, not a changed plate", async () => {
  // 판을 못 읽으면 서버가 아예 붙이지 않는다. 빈 문자열로 주지 않는 이유다.
  const stub = harness([
    queued("rj-9", 1),
    {
      body: {
        jobId: "rj-9",
        status: "COMPLETED",
        resultCurveContext: resultContext,
      },
    },
  ]);
  const outcome = await stub.run(undefined, target.bundleId);
  assert.equal(outcome.state, "ready");

  // 같은 판이면 당연히 그대로 간다.
  const same = harness([
    queued("rj-9", 1),
    {
      headers: { "X-Current-Bundle": target.bundleId },
      body: {
        jobId: "rj-9",
        status: "COMPLETED",
        resultCurveContext: resultContext,
      },
    },
  ]);
  assert.equal((await same.run(undefined, target.bundleId)).state, "ready");
});
