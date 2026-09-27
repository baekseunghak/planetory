import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  emitAnalysis,
  lastAnalysis,
  onAnalysis,
  outcomeFromReceipt,
  periodStrength,
  resetAnalysisBridge,
} from "../../src/cinema/analysis/bridge";
import {
  createNoopSceneController,
  sceneSystemFrom,
} from "../../src/cinema/scene/contract";
import type { ReadyPeriodogram } from "../../src/features/analysis/period-selection";
import { decodeSubmissionReceipt } from "../../src/features/analysis/submission-data";
import {
  FOLD_SAMPLE,
  PERIODOGRAM_FIXTURE_TICS,
  candidatePeaksFixture,
  periodContextFixture,
  periodogramFixture,
  periodogramFixtureResponse,
} from "../../dev/periodogram-fixtures";
import {
  SUBMISSION_FIXTURE_CSRF,
  submissionFixtureResponse,
  type SubmissionOutcomeKind,
} from "../../dev/submission-fixtures";

// The frozen contract reads real receipts. These go through the dev fixture and
// the production decoder, so a change in either shows up here first.
const TIC = PERIODOGRAM_FIXTURE_TICS.normal;
const peaks = candidatePeaksFixture(TIC).peaks;
const peak = (rank: number) => peaks[rank - 1];

function submit(
  body: Record<string, unknown>,
  outcome: SubmissionOutcomeKind | null = null,
) {
  const requestId = randomUUID();
  const reply = submissionFixtureResponse({
    method: "POST",
    url: new URL(`http://fixture.invalid/v1/stars/${TIC}/submissions`),
    csrf: SUBMISSION_FIXTURE_CSRF,
    scenario: null,
    outcome,
    body: { requestId, ...body },
    contextFor: (tic) =>
      periodogramFixtureResponse(
        new URL(`http://fixture.invalid/v1/stars/${tic}/analysis-context`),
      ),
  });
  assert.ok(reply && reply.kind === "json", "fixture replied");
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return decodeSubmissionReceipt(reply.body, { ticId: TIC, requestId }, 201);
}
const candidate = (
  grid: number | null,
  userJudgment: "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE",
  periodDays = grid === null
    ? 5
    : peaks.find((p) => p.gridIndex === grid)!.periodDays,
) => ({
  submissionKind: "candidate",
  curveContext: periodContextFixture(TIC).currentCurveContext,
  selection: {
    periodDays,
    sourcePeakGridIndex: grid,
    phaseStart: 0.995,
    phaseEnd: 1.005,
  },
  userJudgment,
  evidenceChecks: [],
  memo: "",
});

test("rank-1 + 행성 같음 is matched, reveals a planet and unlocks a star", () => {
  const receipt = submit(candidate(peak(1).gridIndex, "LIKELY_PLANET"));
  const outcome = outcomeFromReceipt(receipt, {
    firstView: true,
    userJudgment: "LIKELY_PLANET",
  });
  assert.equal(outcome.kind, "matched");
  assert.equal(outcome.planet?.disposition, "CONFIRMED");
  assert.equal(outcome.planet?.isPlanet, true);
  assert.equal(outcome.revealsPlanet, true);
  assert.deepEqual(outcome.achievement.unlockedTicIds, ["259377031"]);
  assert.equal(outcome.achievement.result, "recognized");
  assert.equal(outcome.created, true);
  assert.equal(typeof outcome.skyVersion, "string");
});

test("a confirmed signal judged wrongly is a judgment mismatch that still shows the planet", () => {
  const receipt = submit(candidate(peak(1).gridIndex, "UNLIKELY_PLANET"));
  const outcome = outcomeFromReceipt(receipt, {
    firstView: true,
    userJudgment: "UNLIKELY_PLANET",
  });
  assert.equal(outcome.kind, "judgmentMismatch");
  assert.equal(outcome.revealsPlanet, true);
  assert.deepEqual(outcome.achievement.unlockedTicIds, []);
});

test("unconfirmed harmonic waits for publication and needs 행성 같음 to show", () => {
  const unsure = outcomeFromReceipt(
    submit(candidate(peak(2).gridIndex, "UNSURE")),
    { firstView: true, userJudgment: "UNSURE" },
  );
  assert.equal(unsure.kind, "pendingPublish");
  assert.equal(unsure.matchStatus, "matched_harmonic");
  assert.equal(unsure.planet?.harmonicMultiplier, 2);
  assert.equal(unsure.planet?.isPlanet, null);
  assert.equal(unsure.revealsPlanet, false);
  const likely = outcomeFromReceipt(
    submit(candidate(peak(2).gridIndex, "LIKELY_PLANET")),
    { firstView: true, userJudgment: "LIKELY_PLANET" },
  );
  assert.equal(likely.revealsPlanet, true);
});

test("a false positive judged correctly is recognized but never becomes a planet", () => {
  const outcome = outcomeFromReceipt(
    submit(candidate(peak(3).gridIndex, "UNLIKELY_PLANET")),
    { firstView: true, userJudgment: "UNLIKELY_PLANET" },
  );
  assert.equal(outcome.kind, "matched");
  assert.equal(outcome.planet?.isPlanet, false);
  assert.equal(outcome.revealsPlanet, false);
});

test("direct period, duplicate and 더 없음 map to their own kinds", () => {
  assert.equal(
    outcomeFromReceipt(submit(candidate(null, "LIKELY_PLANET")), {
      firstView: true,
      userJudgment: "LIKELY_PLANET",
    }).kind,
    "numericMismatch",
  );
  assert.equal(
    outcomeFromReceipt(
      submit(candidate(peak(1).gridIndex, "LIKELY_PLANET"), "duplicate"),
      { firstView: false, userJudgment: "LIKELY_PLANET" },
    ).kind,
    "duplicate",
  );
  const none = outcomeFromReceipt(
    submit({
      submissionKind: "no_candidate",
      curveContext: periodContextFixture(TIC).currentCurveContext,
    }),
    { firstView: true, userJudgment: null },
  );
  assert.equal(none.kind, "noCandidate");
  assert.equal(none.planet, null);
});

test("period strength follows the periodogram power", () => {
  const data = {
    periodogram: periodogramFixture(TIC),
  } as unknown as ReadyPeriodogram;
  assert.equal(
    Math.abs(periodStrength(data, FOLD_SAMPLE.periodDays) - 1) < 1e-9,
    true,
  );
  const second = periodStrength(data, peak(2).periodDays);
  assert.ok(second > 0.55 && second < 0.7, String(second));
  assert.ok(periodStrength(data, 1.3) < 0.05);
  assert.equal(periodStrength(data, 0.1), 0);
  assert.equal(periodStrength(data, Number.NaN), 0);
});

test("bridge listeners are isolated and the last payload is kept", () => {
  resetAnalysisBridge();
  const seen: number[] = [];
  const original = console.error;
  console.error = () => undefined;
  try {
    onAnalysis("periodChanged", () => {
      throw new Error("scene bug");
    });
    const off = onAnalysis("periodChanged", (event) =>
      seen.push(event.periodDays),
    );
    const payload = {
      ticId: TIC,
      periodDays: 11.7,
      strength: 1,
      sourcePeakGridIndex: 3600,
      operation: "reselect" as const,
    };
    emitAnalysis("periodChanged", payload);
    off();
    emitAnalysis("periodChanged", { ...payload, periodDays: 3 });
    assert.deepEqual(seen, [11.7]);
    assert.equal(lastAnalysis("periodChanged")?.periodDays, 3);
  } finally {
    console.error = original;
    resetAnalysisBridge();
  }
});

test("the no-op scene keeps the mode state machine without WebGL", async () => {
  const scene = createNoopSceneController();
  const first = scene.getState();
  assert.equal(scene.getState(), first, "stable snapshot");
  let changes = 0;
  const off = scene.subscribe(() => changes++);
  await scene.focusStar("900000010");
  assert.equal(scene.getState().mode, "system");
  assert.equal(scene.getState().focusedTicId, "900000010");
  scene.setMode("analysis");
  await scene.playMismatch();
  await scene.playTransit({ periodDays: 11.7, depth: 0.008, durationHours: 2 });
  await scene.returnToGalaxy();
  assert.equal(scene.getState().mode, "galaxy");
  assert.equal(scene.getState().focusedTicId, null);
  assert.equal(scene.projectStar("900000010"), null);
  off();
  assert.equal(changes, 3);
  assert.equal(scene.getState().ready, false);
});

test("scene systems carry the member's planets with their palette seed", () => {
  const system = sceneSystemFrom({
    ticId: "900000008",
    version: "v1",
    presentationVersion: "personal-galaxy-v1",
    position: {
      x: 1,
      y: 2,
      depthZ: 0.1,
      layoutOrdinal: 7,
      layoutVersion: "personal-spiral-v1",
    },
    items: [
      { candidateId: "a", kind: "confirmed", periodDays: 3, depthPpm: 400 },
      {
        candidateId: "b",
        kind: "unconfirmed",
        periodDays: null,
        depthPpm: null,
      },
    ],
  });
  assert.deepEqual(system.position, {
    x: 1,
    y: 2,
    depthZ: 0.1,
    layoutOrdinal: 7,
  });
  assert.equal(system.planets[1].kind, "unconfirmed");
  assert.ok(system.planets.every((p) => p.seed >= 0 && p.seed < 1));
});
