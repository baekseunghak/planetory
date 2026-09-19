import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/client";
import {
  byRequestPath,
  classifySubmissionError,
  decodeSubmissionReceipt,
  submissionsPath,
} from "../../src/features/analysis/submission-data";

const REQUEST_ID = "6f0b3a1e-548a-4a52-897a-135729468abc";
const TIC = "259377024";
const curveContext = {
  bundleId: "9007199254741093",
  curveStep: 1,
  removedCandidateIds: ["9007199254741094"],
  residualModelVersion: "rm-fixture-183",
  periodogramConfigVersion: "pg-synthetic-184-v2",
};
// 6.4절 본문에서 #187이 읽는 부분. 나머지 필드는 일부러 함께 두어
// 파서가 결과 해설용 값을 가져오지 않는지 확인한다.
const result = (patch: Record<string, unknown> = {}) => ({
  submissionId: "sub-7001",
  historyId: "h-501",
  requestId: REQUEST_ID,
  ticId: TIC,
  bundleId: curveContext.bundleId,
  ruleVersion: "rule-3",
  submittedAt: "2026-09-19T02:30:00Z",
  submissionKind: "candidate",
  curveContext,
  original: { periodDays: 11.802 },
  serverDerived: { epochBtjd: 1683.4231 },
  match: { status: "matched_harmonic", candidateId: "c-402" },
  signal: { candidateId: "c-402", disposition: "UNCONFIRMED" },
  judgment: { value: "LIKELY_PLANET", evaluation: "UNSCORED" },
  skyVersion: "u-101:58",
  achievement: { result: "pending_publish", newlyRecognized: true },
  progress: {
    stage: "in_progress",
    completionReason: null,
    reopenPending: false,
    currentCurveStep: 1,
    matchedCandidateIds: ["c-401"],
    remainingDiscoverableCount: 1,
  },
  judgmentStatistics: { participantCount: 15 },
  nextActions: ["NEXT_CURVE", "PUBLISH_ANALYSIS"],
  ...patch,
});
const expected = { ticId: TIC, requestId: REQUEST_ID };
const decode = (patch?: Record<string, unknown>, status = 201) =>
  decodeSubmissionReceipt(result(patch), expected, status);

test("paths escape their identifiers and keep ids as opaque strings", () => {
  assert.equal(submissionsPath(TIC), `/v1/stars/${TIC}/submissions`);
  assert.equal(
    byRequestPath(REQUEST_ID),
    `/v1/submissions/by-request/${REQUEST_ID}`,
  );
  assert.equal(submissionsPath("a/b"), "/v1/stars/a%2Fb/submissions");
});

test("a receipt keeps only the handover fields and never copies the answer", () => {
  const receipt = decode();
  assert.equal(receipt.submissionId, "sub-7001");
  assert.equal(receipt.historyId, "h-501");
  assert.equal(receipt.matchStatus, "matched_harmonic");
  assert.equal(receipt.skyVersion, "u-101:58");
  assert.deepEqual(receipt.curveContext, curveContext);
  // 후보 정답·성과·통계는 결과 해설(A06-2)의 몫이라 가져오지 않는다.
  for (const field of [
    "signal",
    "achievement",
    "judgmentStatistics",
    "original",
  ])
    assert.equal(field in receipt, false, `${field}를 복사하면 안 된다`);
});

test("created and replayed are told apart by status, not by the body", () => {
  // 재현 본문은 접수 당시 값을 그대로 담으므로 본문만으로는 구분할 수 없다.
  assert.equal(decode(undefined, 201).outcome, "created");
  assert.equal(decode(undefined, 200).outcome, "replayed");
  assert.throws(() => decode(undefined, 202), /status/);
});

test("a receipt for another star or another request is refused", () => {
  // by-request 복구에서 남의 결과를 내 제출로 착각하면 중복 제출을 놓친다.
  assert.throws(() => decode({ ticId: "259377017" }), /ticId/);
  assert.throws(
    () => decode({ requestId: "11111111-1111-4111-8111-111111111111" }),
    /requestId/,
  );
  assert.throws(() => decode({ bundleId: "9007199254740993" }), /bundleId/);
});

test("a match status that cannot belong to the submitted kind is refused", () => {
  assert.equal(
    decode({
      submissionKind: "no_candidate",
      match: { status: "none_wrong" },
    }).matchStatus,
    "none_wrong",
  );
  // 더 없음 제출에 후보 매칭 결과가 실려 오면 응답을 잘못 읽은 것이다.
  assert.throws(
    () =>
      decode({ submissionKind: "no_candidate", match: { status: "matched" } }),
    /match.status/,
  );
  assert.throws(
    () => decode({ submissionKind: "candidate", match: { status: "skipped" } }),
    /match.status/,
  );
});

test("progress enums, the completion pair and the submitted step are checked", () => {
  const done = decode({
    submissionKind: "skipped",
    match: { status: "skipped" },
    progress: {
      stage: "completed",
      completionReason: "skipped",
      reopenPending: false,
      currentCurveStep: 1,
      remainingDiscoverableCount: 0,
    },
  });
  assert.equal(done.progress.completionReason, "skipped");
  // 완료 사유는 완료한 별에만 있다.
  const pair = (stage: string, completionReason: unknown) => () =>
    decode({
      progress: {
        stage,
        completionReason,
        reopenPending: false,
        currentCurveStep: 1,
        remainingDiscoverableCount: 0,
      },
    });
  assert.throws(pair("in_progress", "all_found"), /completionReason/);
  assert.throws(pair("completed", null), /completionReason/);
  assert.throws(pair("finished", null), /progress.stage/);
  // 제출한 곡선 단계와 진행 단계가 어긋나면 다른 제출의 결과다.
  assert.throws(
    () =>
      decode({
        progress: {
          stage: "in_progress",
          completionReason: null,
          reopenPending: false,
          currentCurveStep: 2,
          remainingDiscoverableCount: 1,
        },
      }),
    /currentCurveStep/,
  );
});

test("an unknown next action is dropped but a missing list is refused", () => {
  // 모르는 힌트 하나 때문에 되살릴 수 없는 접수 결과를 잃으면 안 된다.
  assert.deepEqual(
    decode({ nextActions: ["NEXT_CURVE", "TELEPORT", "LATER"] }).nextActions,
    ["NEXT_CURVE", "LATER"],
  );
  assert.deepEqual(decode({ nextActions: [] }).nextActions, []);
  assert.throws(() => decode({ nextActions: null }), /nextActions/);
});

test("activity times are read as UTC instants only", () => {
  assert.equal(decode().submittedAt, "2026-09-19T02:30:00Z");
  // BTJD 과학 시각이나 시간대 없는 문자열을 활동 시각으로 받지 않는다.
  assert.throws(
    () => decode({ submittedAt: "2026-09-19T02:30:00" }),
    /submittedAt/,
  );
  assert.throws(() => decode({ submittedAt: "1683.4231" }), /submittedAt/);
});

const apiError = (
  status: number,
  code: string,
  outcomeUnknown = false,
  fieldErrors: { field: string; reason: string }[] = [],
  details: Record<string, unknown> = {},
) =>
  new ApiError(
    status,
    code,
    code,
    fieldErrors,
    null,
    null,
    outcomeUnknown,
    details,
  );

test("an unknown outcome keeps the request id whatever the transport said", () => {
  // 타임아웃·취소·5xx·본문 파손은 모두 「저장됐는지 모름」이다. 새 ID를 만들면
  // 이미 접수된 제출 위에 두 번째 제출을 만든다.
  for (const [status, code] of [
    [0, "TIMEOUT"],
    [0, "NETWORK_ERROR"],
    [0, "REQUEST_CANCELLED"],
    [503, "DEPENDENCY_UNAVAILABLE"],
    [200, "INVALID_RESPONSE"],
  ] as const) {
    const failure = classifySubmissionError(apiError(status, code, true));
    assert.equal(failure.kind, "unknown-outcome");
    assert.equal(failure.requestId, "keep");
  }
});

test("each refusal decides the request id exactly once", () => {
  const cases: [number, string, string, string][] = [
    [409, "REQUEST_IN_PROGRESS", "in-progress", "keep"],
    // 2.2절: 자동 재전송 안 함. 기존 ID·원본을 보존하고 조회로 확인한다.
    [409, "IDEMPOTENCY_CONFLICT", "conflict-body", "keep"],
    [409, "BUNDLE_CHANGED", "bundle-changed", "renew"],
    // 미접수이고 잔차를 준비한 뒤 같은 ID로 재전송한다. 버리면 복구가 끊긴다.
    [409, "SUBMISSION_CONTEXT_NOT_READY", "context-not-ready", "keep"],
    // 거절이어도 ID는 남긴다. 앞선 전송이 응답만 잃고 접수됐을 수 있고
    // (그래서 이 별이 완료됐을 수도 있다) 확인할 길이 그 ID뿐이다.
    [409, "STAR_ALREADY_COMPLETED", "denied", "keep"],
    [409, "SKIP_NOT_AVAILABLE", "denied", "keep"],
    [403, "STAR_LOCKED", "denied", "keep"],
    [404, "STAR_NOT_PUBLISHED", "denied", "keep"],
    [401, "UNAUTHORIZED", "expired", "keep"],
    [400, "VALIDATION_FAILED", "rejected", "keep"],
  ];
  for (const [status, code, kind, requestId] of cases) {
    const failure = classifySubmissionError(apiError(status, code));
    assert.equal(failure.kind, kind, `${code} 종류`);
    assert.equal(failure.requestId, requestId, `${code} 요청 ID`);
  }
});

test("validation failures carry their field errors through", () => {
  const failure = classifySubmissionError(
    apiError(400, "VALIDATION_FAILED", false, [
      { field: "selection.periodDays", reason: "Invalid input" },
    ]),
  );
  assert.equal(failure.kind, "rejected");
  if (failure.kind !== "rejected") throw new Error("expected rejected");
  assert.deepEqual(failure.fieldErrors, [
    { field: "selection.periodDays", reason: "Invalid input" },
  ]);
});

test("a lost outcome outranks the status code it arrived with", () => {
  // 5xx는 거절처럼 보이지만 쓰기 요청이 나간 뒤라면 저장됐을 수 있다.
  const failure = classifySubmissionError(apiError(500, "SERVER_ERROR", true));
  assert.equal(failure.kind, "unknown-outcome");
  assert.equal(failure.requestId, "keep");
});

test("errors that are not from the api client are rethrown untouched", () => {
  const boom = new Error("boom");
  assert.throws(() => classifySubmissionError(boom), boom);
});

test("a changed bundle reads the current plate from the body, not the header", () => {
  // 2.3절이 본문을 정본으로 적는다. X-Current-Bundle 헤더는 5.2·5.3부터 붙었고
  // 제출 응답에는 아직 없을 수 있다(D-5).
  const failure = classifySubmissionError(
    apiError(409, "BUNDLE_CHANGED", false, [], { currentBundleId: "b-3" }),
  );
  assert.equal(failure.kind, "bundle-changed");
  if (failure.kind !== "bundle-changed") throw new Error("expected changed");
  assert.equal(failure.currentBundleId, "b-3");
  assert.equal(failure.requestId, "renew");

  // 본문에 없으면 null이며 호출부가 헤더로 메운다.
  const bare = classifySubmissionError(apiError(409, "BUNDLE_CHANGED"));
  assert.equal(
    bare.kind === "bundle-changed" ? bare.currentBundleId : "없음",
    null,
  );
  // 숫자나 다른 형이 와도 문자열이 아니면 쓰지 않는다.
  const wrong = classifySubmissionError(
    apiError(409, "BUNDLE_CHANGED", false, [], { currentBundleId: 3 }),
  );
  assert.equal(
    wrong.kind === "bundle-changed" ? wrong.currentBundleId : "없음",
    null,
  );
});

test("a not-ready context keeps the id and carries the residual state", () => {
  const failure = classifySubmissionError(
    apiError(409, "SUBMISSION_CONTEXT_NOT_READY", false, [], {
      residual: { status: "QUEUED", jobId: "job-7701", computedAt: null },
    }),
  );
  assert.equal(failure.kind, "context-not-ready");
  // 이 ID로 다시 보내야 한다. 버리면 명세가 말하는 재전송을 할 수 없다.
  assert.equal(failure.requestId, "keep");
  assert.deepEqual(failure.kind === "context-not-ready" && failure.residual, {
    status: "QUEUED",
    jobId: "job-7701",
    computedAt: null,
  });
});

test("an unknown residual status is kept instead of being dropped", () => {
  // 계약이 아직 143 브랜치에만 있다. 모르는 값 하나로 복구를 끊지 않는다.
  const failure = classifySubmissionError(
    apiError(409, "SUBMISSION_CONTEXT_NOT_READY", false, [], {
      residual: { status: "RECOMPUTING", jobId: null, computedAt: null },
    }),
  );
  assert.equal(
    failure.kind === "context-not-ready" && failure.residual?.status,
    "RECOMPUTING",
  );
  // residual이 아예 없어도 거절로 바뀌지 않는다.
  const bare = classifySubmissionError(
    apiError(409, "SUBMISSION_CONTEXT_NOT_READY"),
  );
  assert.equal(bare.kind, "context-not-ready");
  assert.equal(bare.kind === "context-not-ready" && bare.residual, null);
});
