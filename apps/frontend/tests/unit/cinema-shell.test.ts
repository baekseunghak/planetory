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
} from "../../src/cinema/scene/contract";
import {
  SequenceDirector,
  discoveryCard,
  objectParticle,
  outcomeChips,
  planetLabel,
} from "../../src/cinema/shell/sequences";
import {
  fullSkyView,
  galaxySearch,
  legacyMainClass,
  readStage,
  starSearch,
} from "../../src/cinema/shell/stage";
import { directStage } from "../../src/cinema/shell/useStageDirector";
import { subscribeSkyChange } from "../../src/features/sky-data/events";
import type { SkyMeta } from "../../src/features/sky-data/contracts";

type Call = [string, ...unknown[]];
function recording(): { scene: SceneController; calls: Call[] } {
  const base = createNoopSceneController();
  const calls: Call[] = [];
  const scene = new Proxy(base, {
    get(target, key: string) {
      const value = target[key as keyof SceneController];
      if (
        typeof value !== "function" ||
        key === "getState" ||
        key === "subscribe"
      )
        return value;
      return (...args: unknown[]) => {
        calls.push([key, ...args]);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
  return { scene, calls };
}
const names = (calls: Call[]) => calls.map(([name]) => name);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function outcome(patch: Partial<AnalysisOutcome> = {}): AnalysisOutcome {
  return {
    kind: "matched",
    ticId: "900000010",
    submissionId: "s-1",
    historyId: "h-1",
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
      unlockedTicIds: ["900001001"],
      starCount: 1,
      grade: null,
    },
    skyVersion: "u-209:2",
    progress: {
      stage: "in_progress",
      remainingDiscoverableCount: 1,
      matchedCandidateIds: ["9007199254741101"],
    },
    nextActions: [],
    ...patch,
  };
}

test("routes map to scene stages; bad TICs never reach the scene", () => {
  assert.deepEqual(readStage("/sky", ""), { stage: "galaxy", ticId: null });
  assert.deepEqual(readStage("/sky", "?star=900000008"), {
    stage: "system",
    ticId: "900000008",
  });
  assert.deepEqual(readStage("/sky", "?focus=259377017"), {
    stage: "system",
    ticId: "259377017",
  });
  assert.deepEqual(readStage("/sky", "?star=abc"), {
    stage: "galaxy",
    ticId: null,
  });
  assert.deepEqual(readStage("/sky", "?star=1", { skyOverride: true }), {
    stage: "backdrop",
    ticId: null,
  });
  assert.deepEqual(readStage("/analysis/900000010", "?returnTo=%2Fsky"), {
    stage: "analysis",
    ticId: "900000010",
  });
  assert.deepEqual(readStage("/analysis/%E0%A4%A", ""), {
    stage: "analysis",
    ticId: null,
  });
  for (const path of ["/community", "/me", "/settings", "/history/h-1"])
    assert.equal(readStage(path, "").stage, "backdrop");
  assert.equal(galaxySearch("?star=1&filterTic=2&view=list"), "?filterTic=2");
  assert.equal(
    starSearch("?focus=3&filterStage=completed", "7"),
    "?filterStage=completed&star=7",
  );
  assert.equal(legacyMainClass("/community/hot-topics"), "page service-page");
  assert.equal(legacyMainClass("/settings"), "page");
});

test("the persistent store loads the whole stored galaxy at the coarsest level", () => {
  const meta = {
    bounds: { minX: -420, maxX: 380, minY: -300, maxY: 310 },
    tileSize: 256,
    zoomLevels: [
      { level: 0, scale: 0.25 },
      { level: 1, scale: 1 },
    ],
  } as SkyMeta;
  assert.deepEqual(fullSkyView(meta), {
    level: 0,
    box: { x: -420, y: -300, w: 800, h: 610 },
  });
  const point = { ...meta, bounds: { minX: 5, maxX: 5, minY: 7, maxY: 7 } };
  assert.deepEqual(fullSkyView(point).box, { x: 5, y: 7, w: 256, h: 256 });
});

test("card copy comes from the reported outcome only", () => {
  assert.equal(objectParticle("행성 1"), "을");
  assert.equal(objectParticle("행성 2"), "를");
  assert.equal(objectParticle("행성 10"), "을");
  assert.equal(objectParticle("별"), "을");
  assert.equal(objectParticle("후보"), "를");
  assert.equal(
    planetLabel([{ candidateId: "fixture-204-p-0" }], "9007199254741101"),
    "행성 1",
  );
  assert.equal(
    planetLabel([{ candidateId: "a" }, { candidateId: "c" }], "b"),
    "행성 2",
  );

  // A confirmed planet is a known planet found, not a new discovery; the
  // star panel's name leads the numbers.
  const matched = discoveryCard(outcome(), "행성 2");
  assert.equal(matched.title, "확정된 행성을 직접 찾아냈습니다");
  assert.equal(
    matched.facts,
    "행성 2 · 주기 11.735일 · 지속 2.0시간 · 깊이 0.80%",
  );
  // Success first; the star's progress last. The chip says what opened, so
  // no note repeats it.
  assert.deepEqual(
    matched.chips.map((chip) => [chip.label, chip.tone]),
    [
      ["판단 일치", "good"],
      ["성과 인정", "good"],
      ["새 별 1개", "new"],
      ["탐사 중", "neutral"],
    ],
  );
  assert.equal(matched.note, null);
  const mismatch = discoveryCard(
    outcome({
      kind: "judgmentMismatch",
      evaluation: "DISAGREES",
      userJudgment: "UNLIKELY_PLANET",
      achievement: {
        result: "judgment_mismatch",
        newlyRecognized: false,
        unlockedTicIds: [],
        starCount: 0,
        grade: null,
      },
      progress: {
        stage: "completed",
        remainingDiscoverableCount: 0,
        matchedCandidateIds: [],
      },
    }),
    "행성 1",
  );
  assert.equal(mismatch.title, "구간은 맞았고, 판단은 달랐습니다");
  assert.deepEqual(
    mismatch.chips.map((chip) => chip.tone),
    ["warn", "warn", "good"],
  );
  const fp = discoveryCard(
    outcome({
      revealsPlanet: false,
      planet: { ...outcome().planet!, disposition: "FP", isPlanet: false },
    }),
    null,
  );
  assert.equal(fp.title, "행성이 아닌 신호를 가려냈습니다");
  assert.equal(fp.revealed, false);
  assert.deepEqual(
    outcomeChips(outcome({ matchStatus: "matched_harmonic" })).map(
      (chip) => chip.label,
    ),
    ["판단 일치", "성과 인정", "새 별 1개", "배수 주기로 일치", "탐사 중"],
  );
});

function director(scene: SceneController, tic: { current: string | null }) {
  return new SequenceDirector({
    scene: () => scene,
    memberId: "u-test",
    analysisTic: () => tic.current,
    planetLabel: (o) =>
      o.planet ? planetLabel([], o.planet.candidateId) : null,
  });
}

test("bridge hints drive the ghost orbit only for the star on stage", () => {
  resetAnalysisBridge();
  const { scene, calls } = recording();
  const tic = { current: "900000010" as string | null };
  const d = director(scene, tic);
  const stop = d.start();
  emitAnalysis("periodChanged", {
    ticId: "900000099",
    periodDays: 3,
    strength: 0.9,
    sourcePeakGridIndex: null,
    operation: "reselect",
  });
  assert.equal(calls.length, 0, "another star's period is ignored");
  emitAnalysis("periodChanged", {
    ticId: "900000010",
    periodDays: 11.7346,
    strength: 1.4,
    sourcePeakGridIndex: 3600,
    operation: "reselect",
  });
  assert.deepEqual(calls.at(-1), [
    "setAnalysisHint",
    { periodDays: 11.7346, strength: 1, selection: null },
  ]);
  emitAnalysis("selectionChanged", {
    ticId: "900000010",
    selection: {
      periodDays: 11.7346,
      startPhase: 0.98,
      endPhase: 1.02,
      durationHours: 2,
      confirmed: false,
    },
  });
  assert.deepEqual(calls.at(-1), [
    "setAnalysisHint",
    {
      periodDays: 11.7346,
      strength: 1,
      selection: { startPhase: 0.98, endPhase: 1.02, durationHours: 2 },
    },
  ]);
  emitAnalysis("selectionChanged", { ticId: "900000010", selection: null });
  assert.deepEqual(calls.at(-1), [
    "setAnalysisHint",
    { periodDays: 11.7346, strength: 1, selection: null },
  ]);
  d.leaveAnalysis();
  assert.deepEqual(calls.at(-1), ["setAnalysisHint", null]);
  stop();
});

test("a late-mounting shell catches up with an active session, never with an outcome", () => {
  resetAnalysisBridge();
  emitAnalysis("sessionChanged", { ticId: "900000010", active: true });
  emitAnalysis("periodChanged", {
    ticId: "900000010",
    periodDays: 5,
    strength: 0.5,
    sourcePeakGridIndex: 2500,
    operation: "reselect",
  });
  emitAnalysis("outcome", outcome());
  const { scene, calls } = recording();
  const d = director(scene, { current: "900000010" });
  const stop = d.start();
  d.enterAnalysis();
  assert.deepEqual(calls.at(-1), [
    "setAnalysisHint",
    { periodDays: 5, strength: 0.5, selection: null },
  ]);
  assert.ok(!names(calls).includes("playTransit"));
  assert.equal(d.getState().phase, "idle");
  stop();
});

test("re-entering a star's analysis never brings back the previous session's ghost", () => {
  resetAnalysisBridge();
  const { scene, calls } = recording();
  const tic = { current: "900000010" as string | null };
  const d = director(scene, tic);
  const stop = d.start();
  // Session 1: a period and a window, then the member leaves.
  emitAnalysis("sessionChanged", { ticId: "900000010", active: true });
  d.enterAnalysis();
  emitAnalysis("periodChanged", {
    ticId: "900000010",
    periodDays: 11.73,
    strength: 1,
    sourcePeakGridIndex: 3600,
    operation: "reselect",
  });
  emitAnalysis("selectionChanged", {
    ticId: "900000010",
    selection: {
      periodDays: 11.73,
      startPhase: 0.994,
      endPhase: 1.006,
      durationHours: 2,
      confirmed: true,
    },
  });
  emitAnalysis("sessionChanged", { ticId: "900000010", active: false });
  d.leaveAnalysis();
  // Session 2 on the same star: nothing chosen yet (production order: the
  // variant opens its session before the shell's effect runs).
  calls.length = 0;
  emitAnalysis("sessionChanged", { ticId: "900000010", active: true });
  d.enterAnalysis();
  assert.deepEqual(calls.at(-1), ["setAnalysisHint", null]);
  // A period restored in this session (after it opened) is replayed.
  emitAnalysis("periodChanged", {
    ticId: "900000010",
    periodDays: 4.47,
    strength: 0.6,
    sourcePeakGridIndex: 2500,
    operation: "reselect",
  });
  d.leaveAnalysis();
  calls.length = 0;
  d.enterAnalysis();
  assert.deepEqual(calls.at(-1), [
    "setAnalysisHint",
    { periodDays: 4.47, strength: 0.6, selection: null },
  ]);
  stop();
});

test("the top bar holds its counts until the planet appears and the star ignites", async () => {
  resetAnalysisBridge();
  const { scene } = recording();
  const d = director(scene, { current: "900000010" });
  const stop = d.start();
  const holds: string[] = [];
  d.subscribeHold(() =>
    holds.push(
      `${d.getHold().planets ? "P" : "-"}${d.getHold().stars ? "S" : "-"}`,
    ),
  );
  emitAnalysis("outcome", outcome());
  // Held before the sky refresh (published in the same call) can land.
  assert.deepEqual(d.getHold(), { planets: true, stars: true });
  await tick();
  await tick();
  assert.equal(d.getState().phase, "card");
  assert.deepEqual(d.getHold(), { planets: false, stars: true });
  d.dismiss();
  d.releaseStars();
  assert.deepEqual(d.getHold(), { planets: false, stars: false });
  assert.deepEqual(holds, ["PS", "-S", "--"]);

  // A replay (already seen) or a numeric mismatch never holds anything.
  emitAnalysis("outcome", outcome({ firstView: false, created: false }));
  emitAnalysis(
    "outcome",
    outcome({
      kind: "numericMismatch",
      matchStatus: "not_matched",
      planet: null,
      revealsPlanet: false,
    }),
  );
  assert.deepEqual(d.getHold(), { planets: false, stars: false });
  // Judgment mismatch: the planet is added (HOME-05), no star opens.
  emitAnalysis(
    "outcome",
    outcome({
      kind: "judgmentMismatch",
      evaluation: "DISAGREES",
      achievement: {
        result: "judgment_mismatch",
        newlyRecognized: false,
        unlockedTicIds: [],
        starCount: 0,
        grade: null,
      },
    }),
  );
  assert.deepEqual(d.getHold(), { planets: true, stars: false });
  d.leaveAnalysis();
  assert.deepEqual(d.getHold(), { planets: false, stars: false });
  stop();
});

test("a first matched outcome plays transit, reveal and card; unlocks wait for the galaxy", async () => {
  resetAnalysisBridge();
  const { scene, calls } = recording();
  const d = director(scene, { current: "900000010" });
  const stop = d.start();
  const published: string[] = [];
  const off = subscribeSkyChange("u-test", (change) =>
    published.push(change.skyVersion),
  );
  const phases: string[] = [];
  d.subscribe(() => phases.push(d.getState().phase));
  emitAnalysis("outcome", outcome());
  await tick();
  await tick();
  assert.deepEqual(published, ["u-209:2"]);
  const transit = calls.find(([name]) => name === "playTransit")!;
  assert.equal((transit[1] as { depth: number }).depth, 0.008);
  assert.equal((transit[1] as { periodDays: number }).periodDays, 11.7346);
  const reveal = calls.find(([name]) => name === "revealPlanet")!;
  assert.deepEqual(
    {
      ...(reveal[1] as object),
      seed: undefined,
    },
    {
      candidateId: "9007199254741101",
      kind: "confirmed",
      periodDays: 11.7346,
      depthPpm: 8000,
      ticId: "900000010",
      seed: undefined,
    },
  );
  assert.deepEqual(phases, ["transit", "card"]);
  assert.equal(d.getState().card?.title, "확정된 행성을 직접 찾아냈습니다");
  assert.ok(d.hasIgnitions());
  assert.deepEqual(d.takeIgnitions(), ["900001001"]);
  assert.deepEqual(d.takeIgnitions(), []);
  d.dismiss();
  assert.equal(d.getState().phase, "idle");
  off();
  stop();
});

test("unlocked stars are held hidden from before the sky refresh until they ignite", async () => {
  resetAnalysisBridge();
  const { scene, calls } = recording();
  const d = director(scene, { current: "900000010" });
  const stop = d.start();
  // What the scene had been told when the refreshed sky was announced.
  let heldAtRefresh: unknown[] | null = null;
  const off = subscribeSkyChange("u-test", () => {
    heldAtRefresh = calls
      .filter(([name]) => name === "holdStars")
      .map(([, ids]) => ids);
  });
  emitAnalysis("outcome", outcome());
  await tick();
  await tick();
  assert.deepEqual(heldAtRefresh, [["900001001"]]);
  assert.deepEqual(d.takeIgnitions(), ["900001001"]);
  // The shell ignites it later (scene.ignite takes it off the held set).
  // A replayed receipt holds nothing; nor does a judgment mismatch.
  calls.length = 0;
  emitAnalysis(
    "outcome",
    outcome({ submissionId: "s-2", firstView: false, created: false }),
  );
  emitAnalysis(
    "outcome",
    outcome({
      submissionId: "s-3",
      kind: "judgmentMismatch",
      achievement: {
        result: "judgment_mismatch",
        newlyRecognized: false,
        unlockedTicIds: ["900001002"],
        starCount: 0,
        grade: null,
      },
    }),
  );
  await tick();
  await tick();
  assert.equal(names(calls).includes("holdStars"), false);
  off();
  stop();
  // Signed out before the galaxy came back: nobody will ignite them.
  assert.deepEqual(calls.at(-1), ["holdStars", null]);
});

test("a recognized outcome that opened no star: no hold, no ignition, and the card says so plainly", async () => {
  // Production today: a tutorial achievement often carries unlockedStars: [].
  resetAnalysisBridge();
  const { scene, calls } = recording();
  const d = director(scene, { current: "900000010" });
  const stop = d.start();
  const none = outcome({
    achievement: {
      result: "recognized",
      newlyRecognized: true,
      unlockedTicIds: [],
      starCount: 1,
      grade: null,
    },
    progress: {
      stage: "completed",
      remainingDiscoverableCount: 0,
      matchedCandidateIds: ["9007199254741101"],
    },
  });
  emitAnalysis("outcome", none);
  assert.deepEqual(d.getHold(), { planets: true, stars: false });
  await tick();
  await tick();
  assert.equal(names(calls).includes("holdStars"), false);
  assert.ok(names(calls).includes("revealPlanet"));
  const card = d.getState().card!;
  assert.equal(card.title, "확정된 행성을 직접 찾아냈습니다");
  assert.deepEqual(card.unlockedTicIds, []);
  assert.deepEqual(
    card.chips.map((chip) => [chip.label, chip.tone]),
    [
      ["판단 일치", "good"],
      ["성과 인정", "good"],
      ["탐사 완료", "good"],
    ],
  );
  // Said plainly in the note, not as a missing reward.
  assert.equal(card.note, "이번에는 새로 열린 별이 없습니다.");
  assert.equal(
    card.chips.some((chip) => chip.label.startsWith("새 별")),
    false,
  );
  // 은하로 돌아가기: nothing to ignite.
  assert.equal(d.hasIgnitions(), false);
  assert.deepEqual(d.takeIgnitions(), []);
  d.dismiss();
  // Only a recognized result mentions stars at all.
  for (const result of [
    "judgment_mismatch",
    "pending_publish",
    "already_recognized",
  ] as const)
    assert.equal(
      outcomeChips(
        outcome({
          achievement: { ...none.achievement, result },
        }),
      ).some((chip) => chip.label.includes("별")),
      false,
      result,
    );
  stop();
});

test("judgment mismatch reveals without ignition; numeric mismatch only pulses; replays stay quiet", async () => {
  resetAnalysisBridge();
  const { scene, calls } = recording();
  const tic = { current: "900000012" as string | null };
  const d = director(scene, tic);
  const stop = d.start();
  emitAnalysis(
    "outcome",
    outcome({
      ticId: "900000012",
      kind: "judgmentMismatch",
      evaluation: "DISAGREES",
      achievement: {
        result: "judgment_mismatch",
        newlyRecognized: false,
        unlockedTicIds: ["900001002"],
        starCount: 0,
        grade: null,
      },
    }),
  );
  await tick();
  await tick();
  assert.ok(names(calls).includes("revealPlanet"));
  assert.equal(d.getState().phase, "card");
  assert.equal(d.hasIgnitions(), false);
  d.dismiss();

  calls.length = 0;
  tic.current = "900000011";
  emitAnalysis(
    "outcome",
    outcome({
      ticId: "900000011",
      kind: "numericMismatch",
      matchStatus: "not_matched",
      planet: null,
      revealsPlanet: false,
    }),
  );
  await tick();
  assert.deepEqual(names(calls), ["playMismatch"]);
  assert.equal(d.getState().phase, "idle");

  calls.length = 0;
  const published: string[] = [];
  const off = subscribeSkyChange("u-test", (c) => published.push(c.skyVersion));
  emitAnalysis(
    "outcome",
    outcome({ ticId: "900000011", firstView: false, created: false }),
  );
  await tick();
  assert.deepEqual(calls, []);
  assert.deepEqual(published, [], "an already seen replay keeps the sky as is");
  off();
  stop();
});

test("no flight to a star the loaded sky does not have (locked or unknown TIC)", async () => {
  const { scene, calls } = recording();
  const flight = { current: null as { ticId: string; loaded: boolean } | null };
  const intro: boolean[] = [];
  const run = (stage: Parameters<typeof directStage>[1]) =>
    directStage(scene, stage, {
      starLoaded: false,
      starMissing: true,
      flight,
      current: () => true,
      onGalaxy: () => {},
      onIntro: (playing) => intro.push(playing),
    });
  await run({ stage: "analysis", ticId: "123456" });
  assert.deepEqual(calls, [["setMode", "backdrop"]]);
  calls.length = 0;
  scene.setMode("intro");
  calls.length = 0;
  await run({ stage: "system", ticId: "123456" });
  assert.ok(!names(calls).includes("focusStar"));
  assert.deepEqual(names(calls), ["playIntro"]);
  assert.deepEqual(intro, [true, false], "the HUD waits for the fly-in");
  assert.equal(scene.getState().focusedTicId, null);
});

test("the director flies intro -> galaxy -> star -> analysis and back", async () => {
  const { scene, calls } = recording();
  const flight = { current: null as { ticId: string; loaded: boolean } | null };
  let arrived = 0;
  const run = (stage: Parameters<typeof directStage>[1], starLoaded = true) =>
    directStage(scene, stage, {
      starLoaded,
      flight,
      current: () => true,
      onGalaxy: () => arrived++,
    });
  scene.setMode("intro");
  calls.length = 0;
  await run({ stage: "galaxy", ticId: null });
  assert.deepEqual(names(calls), ["playIntro", "setSystem"]);
  assert.equal(arrived, 1);
  calls.length = 0;
  await run({ stage: "system", ticId: "900000008" }, false);
  assert.deepEqual(names(calls), ["focusStar"]);
  calls.length = 0;
  await run({ stage: "system", ticId: "900000008" }, true);
  assert.deepEqual(names(calls), ["focusStar"], "re-flies once the star loads");
  calls.length = 0;
  await run({ stage: "analysis", ticId: "900000008" });
  assert.deepEqual(names(calls), ["setMode"]);
  assert.equal(scene.getState().mode, "analysis");
  calls.length = 0;
  await run({ stage: "backdrop", ticId: null });
  assert.deepEqual(calls, [["setMode", "backdrop"]]);
  calls.length = 0;
  await run({ stage: "galaxy", ticId: null });
  assert.deepEqual(names(calls), ["returnToGalaxy", "setSystem"]);
  assert.equal(scene.getState().focusedTicId, null);
  assert.equal(arrived, 2);
});

test("the first-login story holds the galaxy far away; its end starts the fly-in", async () => {
  const { scene, calls } = recording();
  const flight = { current: null as { ticId: string; loaded: boolean } | null };
  let arrived = 0;
  const intro: boolean[] = [];
  const run = (holdIntro: boolean) =>
    directStage(
      scene,
      { stage: "galaxy", ticId: null },
      {
        starLoaded: false,
        flight,
        current: () => true,
        onGalaxy: () => arrived++,
        onIntro: (playing) => intro.push(playing),
        holdIntro,
      },
    );
  // Right after login: already far away, nothing moves, nobody arrives.
  scene.setMode("intro");
  calls.length = 0;
  await run(true);
  assert.deepEqual(calls, []);
  assert.equal(scene.getState().mode, "intro");
  assert.equal(arrived, 0, "no first-visit flight while the story is on");
  assert.deepEqual(intro, []);
  // 시작하기: the fly-in, then the galaxy (and the first-visit flight).
  await run(false);
  assert.deepEqual(names(calls), ["playIntro", "setSystem"]);
  assert.equal(arrived, 1);
  assert.deepEqual(intro, [true, false]);
  // A newcomer already on the galaxy (no login fly-in pending) is taken
  // back out for the story.
  calls.length = 0;
  await run(true);
  assert.deepEqual(calls, [["setMode", "intro"]]);
  assert.equal(scene.getState().mode, "intro");
});
