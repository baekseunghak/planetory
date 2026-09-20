import assert from "node:assert/strict";
import { test } from "node:test";
import {
  needsResidual,
  originalContext,
  sameContext,
  stepMoves,
  stepName,
} from "../../src/features/analysis/curve-step";

const at = (removed: string[]) => ({
  bundleId: "b-2",
  curveStep: removed.length,
  removedCandidateIds: removed,
  residualModelVersion: "rm-1",
  periodogramConfigVersion: "pg-1",
});

test("two contexts are the same only when every part matches", () => {
  assert.equal(sameContext(at(["c-1"]), at(["c-1"])), true);
  assert.equal(sameContext(at(["c-1"]), at(["c-2"])), false);
  assert.equal(sameContext(at([]), at(["c-1"])), false);
  // 계산 버전이 다르면 같은 조합이어도 다른 곡선이다.
  assert.equal(
    sameContext(at(["c-1"]), { ...at(["c-1"]), residualModelVersion: "rm-2" }),
    false,
  );
});

test("the original keeps the plate and drops every removal", () => {
  const original = originalContext(at(["c-1", "c-2"]));
  assert.equal(original.curveStep, 0);
  assert.deepEqual(original.removedCandidateIds, []);
  assert.equal(original.bundleId, "b-2");
});

test("where we can go comes from the server and from where we have been", () => {
  const viewing = at(["c-1"]);
  const moves = stepMoves({
    viewing,
    next: at(["c-1", "c-2"]),
    visited: [at([])],
  });
  // 다음은 서버가 준 문맥 그대로다. 우리가 후보를 고르지 않는다.
  assert.deepEqual(moves.next?.removedCandidateIds, ["c-1", "c-2"]);
  // 이전은 내가 왔던 길이다.
  assert.deepEqual(moves.previous?.removedCandidateIds, []);
  assert.equal(moves.original?.curveStep, 0);

  // 이미 보고 있는 곳은 갈 곳이 아니다. 매칭이 없으면 다음이 지금과 같다.
  assert.equal(
    stepMoves({ viewing: at([]), next: at([]), visited: [] }).next,
    null,
  );
  // 원본에서는 원본으로 갈 곳이 없고, 온 길이 없으면 이전도 없다.
  const fresh = stepMoves({ viewing: at([]), next: at(["c-1"]), visited: [] });
  assert.equal(fresh.original, null);
  assert.equal(fresh.previous, null);
});

test("the original never needs a computation; the rest ask unless cached", () => {
  // 5.2절: curveStep=0이면 잔차는 COMPLETED 고정이다.
  assert.equal(needsResidual(at([]), null), false);
  assert.equal(needsResidual(at(["c-1"]), { status: "COMPLETED" }), false);
  assert.equal(needsResidual(at(["c-1"]), { status: "QUEUED" }), true);
  // 모르면 요청한다. 캐시가 있으면 200으로 곧바로 끝나므로 지레짐작보다 싸다.
  assert.equal(needsResidual(at(["c-1"]), null), true);
  assert.equal(needsResidual(at(["c-1"]), { status: null }), true);
});

test("the step is named the way the screen names it", () => {
  assert.equal(stepName(at([])), "원본 곡선");
  assert.equal(stepName(at(["c-1", "c-2"])), "곡선 단계 2");
});
