import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/client";
import {
  checkSubmission,
  MAX_SENDS,
  RECOVERY_DELAYS_MS,
  submitAnalysis,
} from "../../src/features/analysis/submit-analysis";

const TIC = "259377024";
const REQUEST_ID = "6f0b3a1e-548a-4a52-897a-135729468abc";
const BUNDLE = "9007199254741093";
const curveContext = {
  bundleId: BUNDLE,
  curveStep: 0,
  removedCandidateIds: [],
  residualModelVersion: "rm-fixture-183",
  periodogramConfigVersion: "pg-synthetic-184-v2",
};
const input = {
  submissionKind: "candidate",
  curveContext,
  selection: { periodDays: 11.7346, phaseStart: 0.49, phaseEnd: 0.51 },
  userJudgment: "LIKELY_PLANET",
  evidenceChecks: [],
  memo: "",
  retryOfSubmissionId: null,
};
const receiptBody = (patch: Record<string, unknown> = {}) => ({
  submissionId: "sub-7001",
  historyId: "h-501",
  requestId: REQUEST_ID,
  ticId: TIC,
  bundleId: BUNDLE,
  submittedAt: "2026-09-19T02:30:00Z",
  submissionKind: "candidate",
  curveContext,
  match: { status: "not_matched" },
  skyVersion: "u-187:1",
  progress: {
    stage: "in_progress",
    completionReason: null,
    reopenPending: false,
    currentCurveStep: 0,
    remainingDiscoverableCount: 1,
  },
  nextActions: ["NEXT_CURVE"],
  ...patch,
});

type Step =
  | { status: number; body: unknown; bundle?: string }
  | { error: ApiError; status?: number; bundle?: string };
type Call = { path: string; method: string; body?: unknown };

function harness(steps: Step[]) {
  const calls: Call[] = [];
  const waits: number[] = [];
  let released = 0;
  const request = (async (path: string, options: Record<string, any> = {}) => {
    const step = steps.shift();
    if (!step) throw new Error(`대본에 없는 요청: ${path}`);
    calls.push({ path, method: options.method ?? "GET", body: options.json });
    options.onResponse?.({
      status: "error" in step ? (step.status ?? 0) : step.status,
      headers: new Headers(
        step.bundle ? { "X-Current-Bundle": step.bundle } : {},
      ),
    });
    if ("error" in step) throw step.error;
    return step.body;
  }) as never;
  return {
    calls,
    waits,
    released: () => released,
    remaining: () => steps.length,
    run: (signal = new AbortController().signal) =>
      submitAnalysis({
        request,
        ticId: TIC,
        input,
        requestId: REQUEST_ID,
        signal,
        releaseRequestId: () => {
          released += 1;
        },
        wait: async (ms) => void waits.push(ms),
      }),
    check: (signal = new AbortController().signal) =>
      checkSubmission({ request, ticId: TIC, requestId: REQUEST_ID, signal }),
  };
}
const lost = (status = 0, code = "TIMEOUT") =>
  new ApiError(status, code, code, [], null, null, true);
const refused = (
  status: number,
  code: string,
  fieldErrors: { field: string; reason: string }[] = [],
) => new ApiError(status, code, code, fieldErrors, null, null, false);

test("a straight-through submission sends once and is not marked recovered", async () => {
  const stub = harness([{ status: 201, body: receiptBody(), bundle: BUNDLE }]);
  const result = await stub.run();
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") throw new Error("expected accepted");
  assert.equal(result.recovered, false);
  assert.equal(result.receipt.outcome, "created");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].method, "POST");
  // 예약한 ID가 본문에 실린다.
  assert.deepEqual(stub.calls[0].body, { requestId: REQUEST_ID, ...input });
  assert.equal(stub.released(), 0);
});

test("a lost response is confirmed by request id without sending again", async () => {
  const stub = harness([
    { error: lost() },
    { status: 200, body: receiptBody() },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") throw new Error("expected accepted");
  assert.equal(result.recovered, true);
  assert.deepEqual(
    stub.calls.map((call) => call.method),
    ["POST", "GET"],
  );
  assert.equal(stub.calls[1].path, `/v1/submissions/by-request/${REQUEST_ID}`);
  // 결과를 확인했을 뿐이므로 보존한 ID를 버리지 않는다.
  assert.equal(stub.released(), 0);
});

test("a 404 leads to one resend with the same id, never a new one", async () => {
  const stub = harness([
    { error: lost() },
    { error: refused(404, "SUBMISSION_NOT_FOUND") },
    { status: 201, body: receiptBody() },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "accepted");
  const posts = stub.calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  // 같은 요청 ID로 다시 보내야 중복 접수가 생기지 않는다.
  for (const post of posts)
    assert.equal((post.body as { requestId: string }).requestId, REQUEST_ID);
  assert.equal(stub.released(), 0);
});

test("recovery stops after the send limit and hands the decision to the user", async () => {
  const stub = harness([
    { error: lost() },
    { error: refused(404, "SUBMISSION_NOT_FOUND") },
    { error: lost() },
    { error: refused(404, "SUBMISSION_NOT_FOUND") },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "unresolved");
  if (result.state !== "unresolved") throw new Error("expected unresolved");
  assert.equal(result.reason, "lost");
  assert.equal(result.requestId, REQUEST_ID);
  // 접수 여부를 모르므로 ID를 버리지 않는다. 버리면 다음 제출이 중복이 된다.
  assert.equal(stub.released(), 0);
  assert.equal(
    stub.calls.filter((call) => call.method === "POST").length,
    MAX_SENDS,
  );
  assert.equal(stub.remaining(), 0);
});

test("a request in progress is polled until the server settles it", async () => {
  const stub = harness([
    { error: refused(409, "REQUEST_IN_PROGRESS") },
    { error: refused(409, "REQUEST_IN_PROGRESS") },
    { status: 200, body: receiptBody() },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") throw new Error("expected accepted");
  assert.equal(result.recovered, true);
  assert.deepEqual(
    stub.calls.map((call) => call.method),
    ["POST", "GET", "GET"],
  );
  assert.deepEqual(stub.waits, [RECOVERY_DELAYS_MS[0], RECOVERY_DELAYS_MS[1]]);
  assert.equal(stub.released(), 0);
});

test("polling is bounded and says the server is still working", async () => {
  const stub = harness([
    { error: refused(409, "REQUEST_IN_PROGRESS") },
    ...RECOVERY_DELAYS_MS.map(() => ({
      error: refused(409, "REQUEST_IN_PROGRESS"),
    })),
  ]);
  const result = await stub.run();
  assert.equal(result.state, "unresolved");
  if (result.state !== "unresolved") throw new Error("expected unresolved");
  assert.equal(result.reason, "in-progress");
  assert.equal(stub.waits.length, RECOVERY_DELAYS_MS.length);
  assert.equal(stub.released(), 0);
});

test("a failed lookup is not read as 'not submitted'", async () => {
  const stub = harness([
    { error: lost() },
    { error: refused(503, "DEPENDENCY_UNAVAILABLE") },
    { error: refused(503, "DEPENDENCY_UNAVAILABLE") },
    { error: refused(503, "DEPENDENCY_UNAVAILABLE") },
  ]);
  const result = await stub.run();
  // 조회가 실패했을 뿐 접수 여부는 모른다. 재전송하지 않고 ID를 지킨다.
  assert.equal(result.state, "unresolved");
  assert.equal(stub.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(stub.released(), 0);
});

test("a changed bundle releases the id and reports the current one from the header", async () => {
  const stub = harness([
    {
      error: refused(409, "BUNDLE_CHANGED"),
      status: 409,
      bundle: "9007199254749999",
    },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "bundle-changed");
  if (result.state !== "bundle-changed") throw new Error("expected changed");
  // 본문이 아니라 헤더에서 읽는다.
  assert.equal(result.currentBundleId, "9007199254749999");
  assert.equal(stub.released(), 1);
});

test("refusals that require a new body release the id exactly once", async () => {
  for (const [status, code, state] of [
    [409, "IDEMPOTENCY_CONFLICT", "conflict"],
    [409, "STAR_ALREADY_COMPLETED", "denied"],
    [409, "SKIP_NOT_AVAILABLE", "denied"],
    [403, "STAR_LOCKED", "denied"],
    [404, "STAR_NOT_PUBLISHED", "denied"],
  ] as const) {
    const stub = harness([{ error: refused(status, code) }]);
    const result = await stub.run();
    assert.equal(result.state, state, code);
    assert.equal(stub.released(), 1, `${code} 는 ID를 버려야 한다`);
  }
});

test("refusals that keep the body keep the id", async () => {
  const invalid = harness([
    {
      error: refused(400, "VALIDATION_FAILED", [
        { field: "selection.periodDays", reason: "Invalid input" },
      ]),
    },
  ]);
  const rejected = await invalid.run();
  assert.equal(rejected.state, "rejected");
  if (rejected.state !== "rejected") throw new Error("expected rejected");
  assert.deepEqual(rejected.fieldErrors, [
    { field: "selection.periodDays", reason: "Invalid input" },
  ]);
  assert.equal(invalid.released(), 0);

  const session = harness([{ error: refused(401, "UNAUTHORIZED") }]);
  assert.equal((await session.run()).state, "expired");
  assert.equal(session.released(), 0);
});

test("an accepted body that cannot be read is not turned into a refusal", async () => {
  // 접수는 됐는데 본문을 읽을 수 없다. 거절로 바꾸면 사용자가 다시 제출한다.
  const stub = harness([{ status: 201, body: { submissionId: "sub-1" } }]);
  await assert.rejects(stub.run(), /제출 응답의/);
  assert.equal(stub.released(), 0);
});

test("a result for another request id is refused rather than accepted", async () => {
  const stub = harness([
    { error: lost() },
    {
      status: 200,
      body: receiptBody({
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    },
  ]);
  await assert.rejects(stub.run(), /requestId/);
  assert.equal(stub.released(), 0);
});

test("cancelling stops the ladder and keeps the id", async () => {
  const controller = new AbortController();
  controller.abort();
  const stub = harness([{ error: lost(0, "REQUEST_CANCELLED") }]);
  await assert.rejects(stub.run(controller.signal));
  assert.equal(stub.released(), 0);
});

test("checking alone never sends and never claims the submission is missing", async () => {
  const found = harness([{ status: 200, body: receiptBody() }]);
  const result = await found.check();
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") throw new Error("expected accepted");
  assert.equal(result.recovered, true);
  assert.equal(found.calls[0].method, "GET");

  const missing = harness([{ error: refused(404, "SUBMISSION_NOT_FOUND") }]);
  const unresolved = await missing.check();
  assert.equal(unresolved.state, "unresolved");
  if (unresolved.state !== "unresolved") throw new Error("expected unresolved");
  // 404를 근거로 "제출되지 않았습니다"라고 단정하지 않는다.
  assert.equal(/제출되지 않았/.test(unresolved.message), false);
  assert.equal(/중복 없이/.test(unresolved.message), true);

  const working = harness([{ error: refused(409, "REQUEST_IN_PROGRESS") }]);
  const pending = await working.check();
  assert.equal(pending.state, "unresolved");
  if (pending.state !== "unresolved") throw new Error("expected unresolved");
  assert.equal(pending.reason, "in-progress");
});
