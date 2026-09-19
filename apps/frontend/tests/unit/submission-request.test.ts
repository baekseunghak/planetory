import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newRequestId,
  readPendingSubmission,
  releaseRequestId,
  reserveRequestId,
  submissionFingerprint,
  submissionStorageKey,
  type Store,
} from "../../src/features/analysis/submission-request";

const KEY = submissionStorageKey("u-209", "259377024");
function fakeStore(initial: Record<string, string> = {}): Store & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}
const brokenStore = (): Store => ({
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
});

const body = (patch: Record<string, unknown> = {}) => ({
  submissionKind: "candidate",
  curveContext: {
    bundleId: "9007199254741093",
    curveStep: 0,
    removedCandidateIds: [],
  },
  selection: { periodDays: 11.7346, phaseStart: 0.49, phaseEnd: 0.51 },
  userJudgment: "LIKELY_PLANET",
  evidenceChecks: ["oddeven"],
  memo: "확인",
  ...patch,
});

test("the storage key shares the draft prefix so logout clears it too", () => {
  // 공용 파일을 고치지 않고도 clearSessionDrafts가 함께 지우게 하는 전제다.
  assert.equal(KEY.startsWith("planetory:analysis-draft:"), true);
  assert.notEqual(KEY, submissionStorageKey("u-209", "259377017"));
  assert.notEqual(KEY, submissionStorageKey("u-210", "259377024"));
});

test("generated ids are UUID v4 and never repeat", () => {
  const ids = new Set(Array.from({ length: 200 }, newRequestId));
  assert.equal(ids.size, 200);
  for (const id of ids)
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});

test("the fingerprint ignores key order and the request id itself", () => {
  const ordered = submissionFingerprint(body());
  const shuffled = submissionFingerprint({
    memo: "확인",
    evidenceChecks: ["oddeven"],
    userJudgment: "LIKELY_PLANET",
    selection: { phaseEnd: 0.51, periodDays: 11.7346, phaseStart: 0.49 },
    curveContext: {
      removedCandidateIds: [],
      curveStep: 0,
      bundleId: "9007199254741093",
    },
    submissionKind: "candidate",
  });
  assert.equal(shuffled, ordered);
  // 지금 정하려는 값이 requestId이므로 지문에 넣지 않는다.
  assert.equal(
    submissionFingerprint(body({ requestId: newRequestId() })),
    ordered,
  );
});

test("any real change to the body changes the fingerprint", () => {
  const base = submissionFingerprint(body());
  for (const patch of [
    { memo: "확인 " },
    { userJudgment: "UNSURE" },
    { evidenceChecks: [] },
    { evidenceChecks: ["ushape", "oddeven"] },
    { selection: { periodDays: 11.7347, phaseStart: 0.49, phaseEnd: 0.51 } },
    { submissionKind: "no_candidate" },
  ])
    assert.notEqual(
      submissionFingerprint(body(patch)),
      base,
      JSON.stringify(patch),
    );
  // 배열 순서는 서버가 보는 본문의 일부이므로 다른 본문으로 센다.
  assert.notEqual(
    submissionFingerprint(body({ evidenceChecks: ["oddeven", "ushape"] })),
    submissionFingerprint(body({ evidenceChecks: ["ushape", "oddeven"] })),
  );
});

test("values JSON cannot tell apart are kept apart", () => {
  // JSON.stringify는 NaN·Infinity를 모두 null로 만든다. 같은 지문이 되면
  // 서로 다른 본문을 같은 요청 ID로 보내 IDEMPOTENCY_CONFLICT가 된다.
  const seen = new Set(
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map(
      (periodDays) => submissionFingerprint({ selection: { periodDays } }),
    ),
  );
  assert.equal(seen.size, 4);
});

test("the same body keeps its id across reloads; a changed body gets a new one", () => {
  const store = fakeStore();
  const first = reserveRequestId(KEY, submissionFingerprint(body()), store);
  assert.equal(first.reused, false);
  assert.equal(first.volatile, false);

  // 새로고침: 같은 본문이면 저장된 ID를 그대로 쓴다.
  const again = reserveRequestId(KEY, submissionFingerprint(body()), store);
  assert.equal(again.requestId, first.requestId);
  assert.equal(again.reused, true);

  // 사용자가 판단을 바꿨다. 의도적인 재제출이므로 새 ID다.
  const edited = reserveRequestId(
    KEY,
    submissionFingerprint(body({ userJudgment: "UNSURE" })),
    store,
  );
  assert.notEqual(edited.requestId, first.requestId);
  assert.equal(edited.reused, false);

  // 바꾼 본문도 그다음부터는 보존된다.
  assert.equal(
    reserveRequestId(
      KEY,
      submissionFingerprint(body({ userJudgment: "UNSURE" })),
      store,
    ).requestId,
    edited.requestId,
  );
});

test("releasing is the only way a kept id is thrown away", () => {
  const store = fakeStore();
  const kept = reserveRequestId(KEY, submissionFingerprint(body()), store);
  releaseRequestId(KEY, store);
  assert.equal(readPendingSubmission(KEY, store), null);
  const fresh = reserveRequestId(KEY, submissionFingerprint(body()), store);
  assert.notEqual(fresh.requestId, kept.requestId);
});

test("stars and members do not share a kept id", () => {
  const store = fakeStore();
  const mine = reserveRequestId(KEY, submissionFingerprint(body()), store);
  const other = reserveRequestId(
    submissionStorageKey("u-209", "259377017"),
    submissionFingerprint(body()),
    store,
  );
  assert.notEqual(other.requestId, mine.requestId);
});

test("unusable storage still submits, and says the id will not survive a reload", () => {
  for (const store of [null, brokenStore()]) {
    const reserved = reserveRequestId(
      KEY,
      submissionFingerprint(body()),
      store,
    );
    assert.match(reserved.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(reserved.reused, false);
    // 제출은 막지 않는다. 잃는 것은 새로고침 뒤의 복구뿐이다.
    assert.equal(reserved.volatile, true);
    assert.doesNotThrow(() => releaseRequestId(KEY, store));
  }
});

test("a damaged record is discarded rather than used to claim someone else's result", () => {
  for (const raw of [
    "not json",
    JSON.stringify({ schema: 2, requestId: newRequestId(), fingerprint: "x" }),
    JSON.stringify({ schema: 1, requestId: "not-a-uuid", fingerprint: "x" }),
    JSON.stringify({ schema: 1, requestId: newRequestId(), fingerprint: "" }),
    JSON.stringify(null),
  ]) {
    const store = fakeStore({ [KEY]: raw });
    assert.equal(readPendingSubmission(KEY, store), null, raw);
    assert.equal(store.map.has(KEY), false, `${raw} 는 지워져야 한다`);
  }
});
