import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldSessionReducer as reduce,
  initialFoldSession,
  canUseFold,
  type FoldSession,
} from "../../src/features/analysis/fold-session";
import { fullFoldView } from "../../src/features/analysis/folded-curve";
import type { PeriodSelectionChange } from "../../src/features/analysis/period-selection";

function change(
  revision: number,
  kind: PeriodSelectionChange["kind"] = "fine-tune",
): PeriodSelectionChange {
  return {
    kind,
    revision,
    context: {
      bundleId: "bundle",
      curveStep: 0,
      removedCandidateIds: [],
      residualModelVersion: "r1",
      periodogramConfigVersion: "p1",
    },
    selectionRulesVersion: "s1",
    peakRuleVersion: "p1",
    selection: {
      periodDays: 2 + revision / 100,
      anchorPeriodDays: 2,
      sourcePeakGridIndex: 1,
      minimum: 1.5,
      maximum: 2.5,
      step: 0.01,
    },
  };
}
function complete(state: FoldSession) {
  const request = state.request!;
  return reduce(state, {
    type: "success",
    request,
    result: {
      dataId: "curve",
      revision: request.change.revision,
      periodDays: request.change.selection.periodDays,
      phases: new Float64Array([0, 0.5]),
    },
  });
}
function successful() {
  const state = complete(
    reduce(initialFoldSession, {
      type: "begin",
      change: change(1, "reselect"),
    }),
  );
  return reduce(state, {
    type: "view",
    update: () => ({ zoom: 32, center: 1.01 }),
  });
}

test("latest failure atomically restores success selection, result and pre-edit view across a burst", () => {
  const before = successful();
  let state = reduce(before, { type: "begin", change: change(2) });
  assert.equal(canUseFold(state), false);
  state = reduce(state, {
    type: "view",
    update: () => ({ zoom: 8, center: 0.4 }),
  });
  state = reduce(state, { type: "begin", change: change(3, "reselect") });
  state = reduce(state, { type: "begin", change: change(4) });
  state = reduce(state, {
    type: "error",
    request: state.request!,
    message: "worker failure",
  });
  assert.equal(state.change, before.change);
  assert.equal(state.success, before.success);
  assert.deepEqual(state.view, before.view);
  assert.equal(state.request!.change.revision, 4);
  assert.equal(canUseFold(state), true);
});

test("a new selection queued before fine tuning still resets the successful viewport", () => {
  let state = reduce(successful(), {
    type: "begin",
    change: change(2, "reselect"),
  });
  state = reduce(state, { type: "begin", change: change(3) });
  state = complete(state);
  assert.deepEqual(state.view, fullFoldView);
  assert.equal(state.success!.change.revision, 3);
  assert.equal(canUseFold(state), true);
});

test("fine tune success keeps view changes made while pending", () => {
  let state = reduce(successful(), { type: "begin", change: change(2) });
  state = reduce(state, {
    type: "view",
    update: () => ({ zoom: 16, center: -0.1 }),
  });
  state = complete(state);
  assert.deepEqual(state.view, { zoom: 16, center: -0.1 });
});

test("cancel restores success; late success/error and superseded requests cannot modify it", () => {
  const before = successful();
  const pending = reduce(before, { type: "begin", change: change(2) });
  const cancelled = reduce(pending, { type: "cancel" });
  const result = complete(pending).success!.result;
  assert.equal(
    reduce(cancelled, { type: "success", request: pending.request!, result }),
    cancelled,
  );
  assert.equal(
    reduce(cancelled, {
      type: "error",
      request: pending.request!,
      message: "late",
    }),
    cancelled,
  );
  const newer = reduce(pending, { type: "begin", change: change(3) });
  assert.equal(
    reduce(newer, { type: "success", request: pending.request!, result }),
    newer,
  );
  assert.equal(
    reduce(newer, {
      type: "error",
      request: pending.request!,
      message: "late",
    }),
    newer,
  );
  assert.equal(cancelled.change, before.change);
  assert.deepEqual(cancelled.view, before.view);
});

test("first failure/cancel has no successful selection and retry stays locked until completion", () => {
  for (const outcome of ["error", "cancel"] as const) {
    let state = reduce(initialFoldSession, {
      type: "begin",
      change: change(1, "reselect"),
    });
    state =
      outcome === "error"
        ? reduce(state, {
            type: "error",
            request: state.request!,
            message: "failed",
          })
        : reduce(state, { type: "cancel" });
    assert.equal(state.change, null);
    assert.equal(state.success, null);
    assert.equal(canUseFold(state), false);
    state = reduce(state, {
      type: "begin",
      change: change(2),
      resetView: state.request!.resetView,
    });
    assert.equal(canUseFold(state), false);
    state = complete(state);
    assert.equal(canUseFold(state), true);
  }
});
