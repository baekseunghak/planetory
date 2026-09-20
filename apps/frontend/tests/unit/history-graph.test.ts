import assert from "node:assert/strict";
import { test } from "node:test";
import {
  historyGraphPath,
  readHistoryGraphView,
  snapshotPhase,
  wrapPhaseWindow,
} from "../../src/features/analysis/history-graph";

// 두 모드는 서로의 빈칸이다. 당시 값을 현재 기준으로 옮기지 않는지,
// 버전이 없을 때 정렬을 보장한다고 말하지 않는지 본다.

const ID = "h-501";
const TIC = "259377024";
const reproduction = {
  submittedBundleId: "b-2",
  currentBundleId: "b-3",
  isPreviousSubmission: true,
  residualReproducible: false,
  fallbackReason: "RETIRED_CANDIDATE",
  currentFoldReferenceTimeBtjd: 1683.4231,
};
const selection = {
  userPeriodDays: 11.802,
  correctedPeriodDays: 23.604,
  harmonicMultiplier: 2,
  epochBtjd: 1683.4231,
  durationHours: 2.83,
  currentPhaseStart: 0.9874,
  currentPhaseEnd: 0.9974,
};
const array = (value: number) => Array.from({ length: 150 }, () => value);
const current = (patch: Record<string, unknown> = {}) => ({
  historyId: ID,
  reproduction,
  selection,
  curve: {
    ticId: TIC,
    bundleId: "b-3",
    segments: [],
    residual: { status: null, jobId: null },
    curveContext: { bundleId: "b-3" },
  },
  snapshot: null,
  snapshotVersion: "folded-mad-v1",
  ...patch,
});
const submitted = (patch: Record<string, unknown> = {}) => ({
  historyId: ID,
  reproduction,
  selection: { ...selection, currentPhaseStart: null, currentPhaseEnd: null },
  curve: null,
  snapshot: { bins: 150, foldedFlux: array(1), foldedError: array(0.01) },
  snapshotVersion: "folded-mad-v1",
  ...patch,
});
const read = (value: unknown, mode: "CURRENT" | "SUBMITTED") =>
  readHistoryGraphView(value, ID, TIC, mode);

test("the request names the mode it wants", () => {
  assert.equal(
    historyGraphPath(ID, "SUBMITTED"),
    "/v1/histories/h-501/graph?mode=SUBMITTED",
  );
});

test("the current mode carries the converted window, the stored one does not", () => {
  const now = read(current(), "CURRENT");
  assert.equal(now.selection.currentPhaseStart, 0.9874);
  assert.equal(now.dto.snapshot, null);

  const then = read(submitted(), "SUBMITTED");
  assert.equal(then.selection.currentPhaseStart, null);
  assert.equal(then.dto.curve, null);
  // 당시에도 절대 시각·주기는 보존된다.
  assert.equal(then.selection.epochBtjd, 1683.4231);
  assert.equal(then.selection.userPeriodDays, 11.802);
});

test("a converted window cannot appear on the stored mode", () => {
  // 현재 T로 환산한 값이라 당시 모드에는 올 수 없다.
  assert.throws(
    () =>
      read(
        submitted({ selection: { ...selection, currentPhaseEnd: null } }),
        "SUBMITTED",
      ),
    /currentPhase/,
  );
  // 한쪽 끝만 오는 창도 창이 아니다.
  assert.throws(
    () =>
      read(
        current({ selection: { ...selection, currentPhaseEnd: null } }),
        "CURRENT",
      ),
    /currentPhase/,
  );
});

test("a multiplier without its corrected period is refused", () => {
  assert.throws(
    () =>
      read(
        current({
          selection: { ...selection, correctedPeriodDays: null },
        }),
        "CURRENT",
      ),
    /correctedPeriodDays/,
  );
});

test("a special submission keeps the box and empties the inside", () => {
  // 8.3절: 주기·절대 구간·현재 위상이 null이고 selection 객체는 유지된다.
  const value = read(
    submitted({
      selection: {
        userPeriodDays: null,
        correctedPeriodDays: null,
        harmonicMultiplier: null,
        epochBtjd: null,
        durationHours: null,
        currentPhaseStart: null,
        currentPhaseEnd: null,
      },
      snapshot: null,
    }),
    "SUBMITTED",
  );
  assert.equal(value.selection.userPeriodDays, null);
  assert.equal(value.dto.snapshot, null);
  assert.equal(value.alignmentUnknown, false);
});

test("an array without a version is drawn but not promised", () => {
  const known = read(submitted(), "SUBMITTED");
  assert.equal(known.alignmentUnknown, false);
  assert.equal(known.snapshotVersion, "folded-mad-v1");

  // 구기록이다. 배열은 그대로 그리되 정렬을 보장하지 않는다.
  const unknown = read(submitted({ snapshotVersion: null }), "SUBMITTED");
  assert.equal(unknown.alignmentUnknown, true);
  assert.equal(unknown.snapshotVersion, null);
  assert.equal(unknown.dto.snapshot?.bins, 150);

  // 배열이 없으면 정렬을 말할 것도 없다.
  assert.equal(
    read(submitted({ snapshot: null, snapshotVersion: null }), "SUBMITTED")
      .alignmentUnknown,
    false,
  );
});

test("the stored phase is the middle of the bin, not its start", () => {
  // 시작을 쓰면 반 칸씩 밀린 자리에 선택 영역을 그리게 된다.
  assert.equal(snapshotPhase(0, 150), -0.5 + 0.5 / 150);
  assert.equal(snapshotPhase(149, 150), -0.5 + 149.5 / 150);
  // 가운데 칸은 0 근처다.
  assert.ok(Math.abs(snapshotPhase(75, 150)) < 1 / 150);
});

test("a window across the seam is split, not stretched", () => {
  assert.deepEqual(wrapPhaseWindow(0.1, 0.2), [{ from: 0.1, to: 0.2 }]);
  // 1.0을 넘는 것은 경계를 넘는 것이 아니다. 옮기면 -0.05~0.05로 이어진다.
  const around = wrapPhaseWindow(0.95, 1.05);
  assert.equal(around.length, 1);
  assert.ok(Math.abs(around[0].from - -0.05) < 1e-9);
  assert.ok(Math.abs(around[0].to - 0.05) < 1e-9);

  // 쪼개지는 것은 ±0.5를 넘는 창이다. 한 구간으로 이으면 고르지 않은
  // 가운데가 전부 칠해진다.
  const split = wrapPhaseWindow(0.4, 0.6);
  assert.equal(split.length, 2);
  assert.ok(Math.abs(split[0].from - 0.4) < 1e-9);
  assert.equal(split[0].to, 0.5);
  assert.equal(split[1].from, -0.5);
  assert.ok(Math.abs(split[1].to - -0.4) < 1e-9);
  // 고른 것이 없으면 그릴 창도 없다.
  assert.deepEqual(wrapPhaseWindow(null, null), []);
});
