import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/client";
import { acceptedOnOlderBundle } from "../../src/features/analysis/submission-data";
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

    remaining: () => steps.length,
    run: (signal = new AbortController().signal) =>
      submitAnalysis({
        request,
        ticId: TIC,
        input,
        requestId: REQUEST_ID,
        signal,
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
  details: Record<string, unknown> = {},
) => new ApiError(status, code, code, fieldErrors, null, null, false, details);

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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
});

test("a changed bundle releases the id and prefers the plate the body names", async () => {
  const body = harness([
    {
      error: refused(409, "BUNDLE_CHANGED", [], {
        currentBundleId: "9007199254748888",
      }),
      status: 409,
      bundle: "9007199254749999",
    },
  ]);
  const result = await body.run();
  assert.equal(result.state, "bundle-changed");
  if (result.state !== "bundle-changed") throw new Error("expected changed");
  // 2.3절의 정본은 본문이다. 헤더와 다르면 본문을 쓴다.
  assert.equal(result.currentBundleId, "9007199254748888");
  // 새 ID는 사용자가 [최신 자료 불러오기]를 누른 뒤에 만든다. 사다리는
  // 여기서 ID를 버리지 않는다(2.2절).

  // 제출 응답에 본문 값이 없으면 헤더로 메운다(D-5).
  const header = harness([
    {
      error: refused(409, "BUNDLE_CHANGED"),
      status: 409,
      bundle: "9007199254749999",
    },
  ]);
  const fallback = await header.run();
  assert.equal(
    fallback.state === "bundle-changed" ? fallback.currentBundleId : "없음",
    "9007199254749999",
  );

  // 둘 다 없으면 null이다. 분석 진입을 다시 조회해 확인한다.
  const neither = harness([{ error: refused(409, "BUNDLE_CHANGED") }]);
  const unknown = await neither.run();
  assert.equal(
    unknown.state === "bundle-changed" ? unknown.currentBundleId : "없음",
    null,
  );
});

test("no refusal spends the request id inside the ladder", async () => {
  // 2.2절은 ID 폐기를 사용자의 선택으로 정했다. 사다리는 어떤 거절에서도
  // 버리지 않고, 화면이 [최신 자료 불러오기]나 [별도 제출로 보내기]를 받은
  // 순간에만 버린다.
  await Promise.all(
    (
      [
        [409, "IDEMPOTENCY_CONFLICT", "conflict"],
        [409, "STAR_ALREADY_COMPLETED", "denied"],
        [409, "SKIP_NOT_AVAILABLE", "denied"],
        [403, "STAR_LOCKED", "denied"],
        [404, "STAR_NOT_PUBLISHED", "denied"],
        [409, "BUNDLE_CHANGED", "bundle-changed"],
      ] as const
    ).map(async ([status, code, state]) => {
      const stub = harness([{ error: refused(status, code), status }]);
      const result = await stub.run();
      assert.equal(result.state, state, code);
      // 한 번만 보낸다. 거절을 자동으로 다시 두드리지 않는다.
      assert.equal(stub.calls.length, 1, code);
    }),
  );
});

test("a conflict keeps the id so the accepted body can be looked up", async () => {
  const stub = harness([
    { error: refused(409, "IDEMPOTENCY_CONFLICT"), status: 409 },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "conflict");
  // 이 ID로 무엇이 접수됐는지 조회해야 하므로 결과가 ID를 들고 나온다.
  assert.equal(result.state === "conflict" && result.requestId, REQUEST_ID);
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

  const session = harness([{ error: refused(401, "UNAUTHORIZED") }]);
  assert.equal((await session.run()).state, "expired");
});

test("an accepted body that cannot be read is not turned into a refusal", async () => {
  // 접수는 됐는데 본문을 읽을 수 없다. 거절로 바꾸면 사용자가 다시 제출한다.
  const stub = harness([{ status: 201, body: { submissionId: "sub-1" } }]);
  await assert.rejects(stub.run(), /제출 응답의/);
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
});

test("cancelling stops the ladder and keeps the id", async () => {
  const controller = new AbortController();
  controller.abort();
  const stub = harness([{ error: lost(0, "REQUEST_CANCELLED") }]);
  await assert.rejects(stub.run(controller.signal));
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
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

test("a not-ready residual refuses without spending the request id", async () => {
  const stub = harness([
    {
      error: refused(409, "SUBMISSION_CONTEXT_NOT_READY", [], {
        residual: { status: "QUEUED", jobId: "job-7701", computedAt: null },
      }),
      status: 409,
    },
  ]);
  const result = await stub.run();
  assert.equal(result.state, "context-not-ready");
  assert.equal(
    result.state === "context-not-ready" && result.residual?.status,
    "QUEUED",
  );
  // 미접수이고 같은 ID로 재전송한다. 버리면 명세가 말하는 복구가 불가능해진다.
  // 사다리는 ID를 버리지 않는다. 버리는 일은 사용자의 선택이다(2.2절).
  // 한 번만 보낸다. 잔차는 기다리는 것이지 다시 두드릴 일이 아니다.
  assert.equal(stub.calls.length, 1);
});

test("a success carries the plate the response says is current", async () => {
  const fresh = harness([
    { status: 201, body: receiptBody(), bundle: "9007199254741093" },
  ]);
  const accepted = await fresh.run();
  assert.equal(accepted.state, "accepted");
  if (accepted.state !== "accepted") throw new Error("expected accepted");
  // 접수 당시 판과 같다. 알릴 것이 없다.
  assert.equal(
    acceptedOnOlderBundle(accepted.receipt, accepted.currentBundleId),
    false,
  );

  // D-5: 재전송 200이 돌아오는 사이 판이 바뀌었다.
  const stale = harness([
    { status: 200, body: receiptBody(), bundle: "9007199254749999" },
  ]);
  const replayed = await stale.run();
  if (replayed.state !== "accepted") throw new Error("expected accepted");
  // 성공을 취소하지도, 다시 보내지도 않는다. 표시만 갈린다.
  assert.equal(replayed.receipt.outcome, "replayed");
  assert.equal(stale.calls.length, 1);
  assert.equal(
    acceptedOnOlderBundle(replayed.receipt, replayed.currentBundleId),
    true,
  );

  // 헤더가 아직 없는 응답도 있다(D-5). 모르는 것을 다르다고 하지 않는다.
  const silent = harness([{ status: 200, body: receiptBody() }]);
  const quiet = await silent.run();
  if (quiet.state !== "accepted") throw new Error("expected accepted");
  assert.equal(quiet.currentBundleId, null);
  assert.equal(
    acceptedOnOlderBundle(quiet.receipt, quiet.currentBundleId),
    false,
  );
});
