import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emitAnalysis,
  resetAnalysisBridge,
  type AnalysisOutcome,
} from "../../src/cinema/analysis/bridge";
import {
  createNoopSceneController,
  type SceneController,
  type TransitRequest,
} from "../../src/cinema/scene/contract";
import {
  SequenceDirector,
  planetLabel,
} from "../../src/cinema/shell/sequences";
import { cinemaTitle } from "../../src/cinema/shell/stage";
import { cinemaDateTime } from "../../src/shared/cinema-wording";

// Shell UX before the review: the discovery can be skipped, tabs are named,
// dates carry no seconds.

function outcome(): AnalysisOutcome {
  return {
    kind: "matched",
    ticId: "900000010",
    submissionId: "s-skip",
    historyId: "h-skip",
    submissionKind: "candidate",
    matchStatus: "matched",
    evaluation: "AGREES",
    userJudgment: "LIKELY_PLANET",
    firstView: true,
    created: true,
    planet: {
      candidateId: "9007199254741101",
      disposition: "CONFIRMED",
      isPlanet: true,
      periodDays: 11.7346,
      depthPpm: 8000,
      durationHours: 2,
      epochBtjd: 1325.5,
      harmonicMultiplier: null,
    },
    revealsPlanet: true,
    submitted: {
      periodDays: 11.73,
      phaseStart: 0.99,
      phaseEnd: 1.01,
      durationHours: 2,
    },
    achievement: {
      result: "recognized",
      newlyRecognized: true,
      unlockedTicIds: [],
      starCount: 0,
      grade: null,
    },
    skyVersion: "u-skip:1",
    progress: {
      stage: "in_progress",
      remainingDiscoverableCount: 1,
      matchedCandidateIds: ["9007199254741101"],
    },
    nextActions: [],
  };
}

/** A scene whose transit and reveal run until their end, like the engine. */
function slowScene() {
  const base = createNoopSceneController();
  const seen = { transitAborted: false, revealed: false, revealDone: false };
  const scene: SceneController = {
    ...base,
    playTransit(request: TransitRequest) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        request.signal?.addEventListener("abort", () => {
          seen.transitAborted = true;
          clearTimeout(timer);
          resolve();
        });
      });
    },
    revealPlanet() {
      seen.revealed = true;
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          seen.revealDone = true;
          resolve();
        }, 300),
      );
    },
  };
  return { scene, seen };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("건너뛰기 ends the transit and brings the card without waiting for the reveal", async () => {
  resetAnalysisBridge();
  const { scene, seen } = slowScene();
  const d = new SequenceDirector({
    scene: () => scene,
    memberId: "u-skip",
    analysisTic: () => "900000010",
    planetLabel: (o) =>
      o.planet ? planetLabel([], o.planet.candidateId) : null,
  });
  const stop = d.start();
  // Nothing to skip before a transit.
  assert.doesNotThrow(() => d.skip());
  emitAnalysis("outcome", outcome());
  await tick();
  assert.equal(d.getState().phase, "transit");
  d.skip();
  await tick();
  await tick();
  assert.ok(seen.transitAborted, "the transit got its abort");
  assert.ok(seen.revealed, "the planet still takes its place");
  assert.equal(seen.revealDone, false, "the card did not wait for the reveal");
  assert.equal(d.getState().phase, "card");
  // The card's copy is the discovery card's own (sequences.ts); it is there.
  assert.ok(d.getState().card?.revealed);
  // A second skip after the card is harmless.
  d.skip();
  assert.equal(d.getState().phase, "card");
  d.dismiss();
  stop();
  await tick(320);
});

test("leaving the analysis during a transit still cancels it (no card)", async () => {
  resetAnalysisBridge();
  const { scene, seen } = slowScene();
  let tic: string | null = "900000010";
  const d = new SequenceDirector({
    scene: () => scene,
    memberId: "u-skip",
    analysisTic: () => tic,
    planetLabel: () => "행성 1",
  });
  const stop = d.start();
  emitAnalysis("outcome", { ...outcome(), submissionId: "s-leave" });
  await tick();
  assert.equal(d.getState().phase, "transit");
  tic = null;
  d.leaveAnalysis();
  await tick();
  assert.ok(seen.transitAborted);
  assert.equal(seen.revealed, false);
  assert.equal(d.getState().phase, "idle");
  d.skip();
  assert.equal(d.getState().phase, "idle");
  stop();
});

test("each main screen names the browser tab", () => {
  assert.equal(cinemaTitle("/sky"), "나의 은하 · Planetory");
  assert.equal(
    cinemaTitle("/sky", "?star=149603524"),
    "TIC 149603524 · 나의 은하 · Planetory",
  );
  assert.equal(cinemaTitle("/sky", "?star=../x"), "나의 은하 · Planetory");
  assert.equal(
    cinemaTitle("/analysis/149603524"),
    "TIC 149603524 분석 · Planetory",
  );
  assert.equal(cinemaTitle("/results/1"), "TIC 1 분석 결과 · Planetory");
  assert.equal(cinemaTitle("/community"), "커뮤니티 · Planetory");
  assert.equal(cinemaTitle("/community/hot-topics"), "커뮤니티 · Planetory");
  assert.equal(cinemaTitle("/posts/p-1"), "커뮤니티 · Planetory");
  assert.equal(cinemaTitle("/signal-threads/t-1"), "커뮤니티 · Planetory");
  assert.equal(cinemaTitle("/me"), "마이페이지 · Planetory");
  assert.equal(cinemaTitle("/settings"), "설정 · Planetory");
  assert.equal(cinemaTitle("/members/u-211"), "탐사자 프로필 · Planetory");
  assert.equal(
    cinemaTitle("/members/u-211/sky"),
    "다른 탐사자의 은하 · Planetory",
  );
  assert.equal(cinemaTitle("/history/h-1"), "분석 기록 · Planetory");
  assert.equal(cinemaTitle("/login"), "로그인 · Planetory");
  assert.equal(cinemaTitle("/nope"), "Planetory");
  for (const path of ["/sky", "/community", "/me"])
    assert.doesNotMatch(cinemaTitle(path), /별지도|SYSTEM/);
});

test("cinema dates have no seconds", () => {
  const text = cinemaDateTime("2026-09-18T01:00:05Z");
  assert.equal(text, "2026년 9월 18일 오전 10:00");
  assert.equal(cinemaDateTime("not a date"), "not a date");
});
