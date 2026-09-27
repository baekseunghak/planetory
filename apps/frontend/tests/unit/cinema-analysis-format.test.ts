// Cinema copy for analyses and results (src/cinema/analysis/format.ts), the
// peak-label placement of the cinema periodogram and the discovery card's
// words for known planets and candidates.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisOutcome } from "../../src/cinema/analysis/bridge";
import * as f from "../../src/cinema/analysis/format";
import { discoveryCard } from "../../src/cinema/shell/sequences";
import {
  periodAt,
  type CandidatePeaks,
  type Periodogram,
} from "../../src/features/analysis/periodogram-data";
import {
  buildPeriodPlot,
  drawPeriodogram,
  FULL_PERIOD_VIEW,
  placeRankLabels,
  rankLabelBox,
} from "../../src/features/analysis/periodogram-view";

test("numbers follow the glossary: period 2-3 decimals, hours 1, phase 3, depth %", () => {
  assert.equal(f.periodDays(11.73461), "11.73일");
  assert.equal(f.periodDays(4.412289682436812, 3), "4.412일");
  assert.equal(f.periodDays(null), null);
  assert.equal(f.periodDays(Number.NaN), null);
  assert.equal(f.hours(2.04), "2.0시간");
  assert.equal(f.hours(3.0149), "3.0시간");
  assert.equal(f.phase(0.690123), "0.690");
  assert.equal(f.phaseRange(0.69, 0.7449), "0.690–0.745");
  assert.equal(f.phaseRange(0.69, null), null);
  // ppm never shows: 8000 ppm is 0.80%.
  assert.equal(f.depthPercent(8000), "0.80%");
  assert.equal(f.depthPercent(13249), "1.32%");
  assert.equal(f.days(2.14), "2.1일");
  assert.equal(f.flux(0.99912345), "0.9991");
  // No "-0.000".
  assert.equal(f.fixed(-0.0001, 3), "0.000");
  assert.equal(f.count(12345), "12,345");
});

test("BTJD shows only as 기준 시각: 2 decimals, no thousands separator", () => {
  assert.equal(f.referenceTime(3264.52349), "3264.52");
  assert.equal(f.referenceTime(2459123.456), "2459123.46");
  assert.equal(f.referenceTime(null), null);
});

test("periodogram power reads as 세기 0..1; negatives are 0", () => {
  assert.equal(f.maxPower([-3, 1.5, 6, 2]), 6);
  assert.equal(f.maxPower([-3, -1]), 0);
  assert.deepEqual(f.strengths([-0.4, 3, 6]), [0, 0.5, 1]);
  assert.deepEqual(f.strengths([-2, -1]), [0, 0]);
  assert.equal(f.strength(9, 6), 1);
  assert.equal(f.strength(Number.NaN, 6), 0);
  assert.equal(f.strengthText(0.8349), "0.83");
  assert.equal(f.strengthText(-0.2), "0.00");
  assert.equal(f.periodTick(3.16227766), "3.16");
  assert.equal(f.periodTick(40), "40");
  assert.equal(f.phaseTick(0.5), "0.5");
  assert.equal(f.phaseTick(0.123456), "0.123");
});

test("words: 섹터, flux units, dates, statuses, curve steps", () => {
  assert.equal(f.sector(5), "섹터 5");
  assert.equal(f.sectors([2, 3]), "섹터 2·3");
  assert.equal(f.fluxUnit("normalized"), "");
  assert.equal(f.fluxUnit("e-/s"), "e-/s");
  assert.equal(f.when("2026-09-27T06:12:40Z"), "2026년 9월 27일 오후 3:12");
  assert.equal(f.when("not a date"), null);
  assert.equal(f.explorationStatus("unexplored"), "미탐사");
  assert.equal(f.explorationStatus("in_progress"), "탐사 중");
  assert.equal(f.explorationStatus("completed"), "탐사 완료");
  assert.equal(f.curveStepName(0), "원본 곡선");
  assert.equal(f.curveStepName(2), "곡선 단계 2");
});

test("dispositions and catalog codes read in Korean; unknown codes as sent", () => {
  assert.equal(f.dispositionLabel("CONFIRMED"), "확정 행성");
  assert.equal(f.dispositionLabel("CP"), "확정 행성");
  assert.equal(f.dispositionLabel("KP"), "확정 행성");
  assert.equal(f.dispositionLabel("UNCONFIRMED"), "행성 후보");
  assert.equal(f.dispositionLabel("PC"), "행성 후보");
  assert.equal(f.dispositionLabel("FP"), "행성 아님(오탐)");
  assert.equal(f.dispositionLabel("EB"), "식쌍성");
  assert.equal(f.dispositionLabel("XYZ"), "XYZ");
});

test("a confirmed planet's published name, never a TOI candidate number", () => {
  assert.equal(
    f.knownPlanetName([
      {
        source: "NASA Exoplanet Archive",
        externalId: "WASP-62 b",
        disposition: "CP",
      },
    ]),
    "WASP-62 b",
  );
  assert.equal(
    f.knownPlanetName([
      { source: "TOI", externalId: "TOI-184.01", disposition: "FP" },
    ]),
    null,
  );
  assert.equal(
    f.knownPlanetName([
      { source: "TOI", externalId: "TOI-9001.01", disposition: "CP" },
    ]),
    null,
  );
  assert.equal(f.knownPlanetName(undefined), null);
});

test("signals are 행성 N among the member's planets, else 신호 N, never an id", () => {
  assert.equal(f.orderOf(["b", "a"], "c"), 3);
  assert.equal(f.orderOf(["a", "c"], "b"), 2);
  assert.equal(
    f.withPeriod(
      f.signalName({ planet: true, order: 1, name: "WASP-62 b" }),
      4.4122,
    ),
    "행성 1 · WASP-62 b (주기 4.41일)",
  );
  assert.equal(
    f.withPeriod(f.signalName({ planet: false, order: 2 }), null),
    "신호 2",
  );
  const labels = f.signalLabels(
    ["9007199254760103", "9007199254760101", "9007199254760102"],
    ["9007199254760102"],
    new Map([["9007199254760102", "L 98-59 d"]]),
  );
  assert.equal(labels.get("9007199254760102"), "행성 1 · L 98-59 d");
  assert.equal(labels.get("9007199254760101"), "신호 1");
  assert.equal(labels.get("9007199254760103"), "신호 2");
  for (const label of labels.values()) assert.doesNotMatch(label, /9007/);
});

test("object particle after Korean, numbers and Latin names", () => {
  assert.equal(f.objectParticle("행성 1"), "을");
  assert.equal(f.objectParticle("행성 2"), "를");
  assert.equal(f.objectParticle("후보"), "를");
  assert.equal(f.objectParticle("WASP-62 b"), "를");
  assert.equal(f.objectParticle("TOI-270 c"), "를");
  assert.equal(f.objectParticle("Kepler-90 l"), "을");
});

test("result titles: a missed window, known planets, candidates, not planets", () => {
  assert.equal(
    f.resultTitle({
      matchStatus: "not_matched",
      achievement: "none",
      disposition: null,
    }),
    "이번 구간에서는 신호를 찾지 못했습니다",
  );
  assert.equal(
    f.resultTitle({
      matchStatus: "matched",
      achievement: "recognized",
      disposition: "CONFIRMED",
      knownName: "WASP-62 b",
    }),
    "알려진 행성 WASP-62 b를 직접 찾아냈습니다",
  );
  assert.equal(
    f.resultTitle({
      matchStatus: "matched",
      achievement: "recognized",
      disposition: "CONFIRMED",
    }),
    "확정된 행성을 직접 찾아냈습니다",
  );
  assert.equal(
    f.resultTitle({
      matchStatus: "matched_harmonic",
      achievement: "pending_publish",
      disposition: "UNCONFIRMED",
    }),
    "새 행성 후보를 발견했습니다",
  );
  assert.equal(
    f.resultTitle({
      matchStatus: "matched",
      achievement: "recognized",
      disposition: "FP",
    }),
    "행성이 아닌 신호를 가려냈습니다",
  );
  assert.equal(
    f.resultTitle({
      matchStatus: "matched",
      achievement: "judgment_mismatch",
      disposition: "CONFIRMED",
    }),
    "구간은 맞았고, 판단은 달랐습니다",
  );
  assert.equal(
    f.resultTitle({
      matchStatus: "duplicate",
      achievement: "already_recognized",
      disposition: "CONFIRMED",
    }),
    "이미 찾은 신호입니다",
  );
  // The hint says only what a not_matched receipt says.
  assert.match(f.NOT_MATCHED_HINT, /맞는 신호가 없었습니다/);
  assert.doesNotMatch(f.NOT_MATCHED_HINT, /주기가 틀|정답/);
});

test("AI only when the model ran; statistics in whole percents", () => {
  assert.equal(f.aiLine({ status: "not_evaluated" }), null);
  assert.equal(f.aiLine({ status: "error" }), null);
  assert.equal(
    f.aiLine({ status: "completed", score: 0.873, verdict: "approved" }),
    "행성일 가능성 높음 · 87점",
  );
  assert.equal(
    f.matchSentence("matched_harmonic", 2),
    "고른 주기의 2배가 신호와 맞았습니다.",
  );
  assert.equal(
    f.statisticsLine({
      kind: "graded",
      matchedMemberCount: 1234,
      agreementPercent: 66.66,
    }),
    "이 신호를 처음 찾은 1,234명 중 67%가 같은 판단이었습니다.",
  );
  assert.equal(
    f.statisticsLine({
      kind: "public_analyses",
      participantCount: 0,
      percentages: null,
    }),
    "아직 공개된 분석이 없습니다.",
  );
});

type Box = [number, number, number, number];
const boxesOverlap = (a: Box, b: Box) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** Every label wholly inside the plot, no two overlapping. */
function assertTidy(
  labels: { rank: number; x: number; y: number }[],
  width: number,
  height: number,
) {
  const boxes = labels.map(rankLabelBox);
  for (const [index, box] of boxes.entries()) {
    assert.ok(
      box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height,
      `label ${labels[index].rank} ${JSON.stringify(box)} leaves ${width}x${height}`,
    );
    for (const other of boxes.slice(index + 1))
      assert.ok(
        !boxesOverlap(box, other),
        `labels overlap ${labels[index].rank}`,
      );
  }
}

test("rank labels: above the dot when it fits; a peak at the top goes beside, inside the plot", () => {
  // 1440x900 (104px) and 1024x768 (92px) cinema plots: the strongest peak
  // (세기 1) has its dot 8px from the top, where a label above would be cut.
  for (const [width, height] of [
    [388, 104],
    [251, 92],
  ]) {
    const peaks = [
      { rank: 1, x: width / 2, y: 8 },
      { rank: 2, x: width / 4, y: 60 },
    ];
    const placed = placeRankLabels(peaks, { width, height });
    assert.deepEqual(
      placed.map(({ rank }) => rank),
      [1, 2],
    );
    assertTidy(placed, width, height);
    const [top, low] = placed;
    // Beside its dot (right), level with it, off its spike and dot.
    const box = rankLabelBox(top);
    assert.ok(box[0] > width / 2 + 3, "right of the spike");
    assert.ok(box[1] >= 0 && box[1] < 8 && box[3] > 8, "level with the dot");
    // Room above: the label sits over its dot, centred.
    assert.equal(low.x, width / 4);
    assert.ok(rankLabelBox(low)[3] <= 60 - 3);
  }
  // At the right edge the label goes to the left of the dot instead.
  const [edge] = placeRankLabels([{ rank: 1, x: 297, y: 8 }], {
    width: 300,
    height: 92,
  });
  assert.ok(rankLabelBox(edge)[2] < 297 - 3);
  assertTidy([edge], 300, 92);
  // At the very bottom-left corner it still stays inside.
  assertTidy(
    placeRankLabels([{ rank: 10, x: 0, y: 92 }], { width: 300, height: 92 }),
    300,
    92,
  );
});

test("rank labels: clear of the selected period's line; crowded ones move or drop, rank 1 never", () => {
  // The selected peak's line would run through a centred label ("1" vanishes
  // in a vertical line): the label moves beside it.
  const [selected] = placeRankLabels([{ rank: 1, x: 100, y: 50 }], {
    width: 300,
    height: 104,
    avoidX: 100,
  });
  const box = rankLabelBox(selected);
  assert.ok(box[0] > 101.5 || box[2] < 98.5, JSON.stringify(box));
  // Without a selection it stays above its dot.
  assert.equal(
    placeRankLabels([{ rank: 1, x: 100, y: 50 }], {
      width: 300,
      height: 104,
    })[0].x,
    100,
  );
  // A crowd: stronger ranks first, nobody overlaps or leaves the plot.
  const crowd = [
    { rank: 4, x: 102, y: 50 },
    { rank: 2, x: 103, y: 52 },
    { rank: 1, x: 100, y: 50 },
    { rank: 3, x: 101, y: 50 },
    { rank: 5, x: 290, y: 5 },
  ];
  const placed = placeRankLabels(crowd, { width: 300, height: 104 });
  assert.equal(placed[0].rank, 1);
  assert.ok(placed.some(({ rank }) => rank === 5));
  assert.ok(placed.length >= 4 && placed.length <= 5);
  assertTidy(placed, 300, 104);
  // Random plots: always tidy, and rank 1 is always shown.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let trial = 0; trial < 300; trial++) {
    const width = 150 + random() * 400,
      height = 80 + random() * 60;
    const peaks = Array.from(
      { length: 1 + Math.floor(random() * 12) },
      (_, i) => ({
        rank: i + 1,
        x: random() * width,
        y: 8 + random() * (height - 16),
      }),
    );
    const labels = placeRankLabels(peaks, {
      width,
      height,
      avoidX: random() < 0.5 ? peaks[0].x : null,
    });
    assert.equal(labels[0]?.rank, 1);
    assertTidy(labels, width, height);
  }
});

test("cinema periodogram draws each rank label inside the plot, the top one off its spike", () => {
  const texts: { text: string; x: number; y: number }[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args: unknown[]) => {
          if (name === "fillText")
            texts.push({
              text: String(args[0]),
              x: Number(args[1]),
              y: Number(args[2]),
            });
        },
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  // A cinema plot: 세기 0..1, the strongest peak at 1 (its dot 8px from the top).
  const nPeriods = 400;
  const power = Array.from({ length: nPeriods }, (_, index) =>
    Math.max(
      0.05,
      Math.exp(-(((index - 200) / 3) ** 2)),
      0.45 * Math.exp(-(((index - 120) / 3) ** 2)),
      0.3 * Math.exp(-(((index - 395) / 3) ** 2)),
    ),
  );
  const grid = {
    periodMinDays: 0.5,
    periodMaxDays: 40,
    nPeriods,
    baselineHalfDays: 20,
    power,
  } as unknown as Periodogram;
  const peaks = [200, 120, 395].map((gridIndex, index) => ({
    rank: index + 1,
    gridIndex,
    periodDays: periodAt(grid, gridIndex),
    power: power[gridIndex],
  }));
  for (const [width, height] of [
    [388, 104],
    [251, 92],
  ]) {
    texts.length = 0;
    drawPeriodogram(
      ctx,
      { ...buildPeriodPlot(grid), yMin: 0, yMax: 1 },
      { peaks, matchedCandidates: [] } as unknown as CandidatePeaks,
      FULL_PERIOD_VIEW,
      width,
      height,
      false,
      "avoid",
      peaks[0].periodDays,
    );
    assert.deepEqual(
      texts.map(({ text }) => text),
      ["1", "2", "3"],
    );
    const labels = texts.map(({ text, x, y }) => ({
      rank: Number(text),
      x,
      y,
    }));
    assertTidy(labels, width, height);
    const spike = (200 / (nPeriods - 1)) * width;
    const top = rankLabelBox(labels[0]);
    assert.ok(top[0] > spike + 3 || top[2] < spike - 3, "off the spike");
  }
});

function outcome(patch: Partial<AnalysisOutcome> = {}): AnalysisOutcome {
  return {
    kind: "matched",
    ticId: "149603524",
    submissionId: "s-1",
    historyId: "h-1",
    submissionKind: "candidate",
    matchStatus: "matched",
    evaluation: "AGREES",
    userJudgment: "LIKELY_PLANET",
    firstView: true,
    created: true,
    planet: {
      candidateId: "9007199254760001",
      disposition: "CONFIRMED",
      isPlanet: true,
      periodDays: 4.4122,
      depthPpm: 13200,
      durationHours: 3.04,
      epochBtjd: 1356.2,
      harmonicMultiplier: null,
      knownName: "WASP-62 b",
    },
    revealsPlanet: true,
    submitted: {
      periodDays: 4.4118,
      phaseStart: 0.69,
      phaseEnd: 0.74,
      durationHours: 3,
    },
    achievement: {
      result: "recognized",
      newlyRecognized: true,
      unlockedTicIds: [],
      starCount: 1,
      grade: null,
    },
    skyVersion: "u-209:2",
    progress: {
      stage: "completed",
      remainingDiscoverableCount: 0,
      matchedCandidateIds: ["9007199254760001"],
    },
    nextActions: [],
    ...patch,
  };
}

test("discovery card: a known planet is found, not discovered; candidates are", () => {
  const known = discoveryCard(outcome(), "행성 1");
  assert.equal(known.eyebrow, "탐사 성공");
  assert.equal(known.title, "알려진 행성 WASP-62 b를 직접 찾아냈습니다");
  assert.equal(
    known.facts,
    "행성 1 · 주기 4.412일 · 지속 3.0시간 · 깊이 1.32%",
  );
  assert.equal(known.note, "이번에는 새로 열린 별이 없습니다.");
  assert.doesNotMatch(known.title, /발견/);

  const unnamed = discoveryCard(
    outcome({ planet: { ...outcome().planet!, knownName: null } }),
    "행성 1",
  );
  assert.equal(unnamed.title, "확정된 행성을 직접 찾아냈습니다");

  const candidate = discoveryCard(
    outcome({
      kind: "pendingPublish",
      evaluation: "UNSCORED",
      planet: {
        ...outcome().planet!,
        disposition: "UNCONFIRMED",
        isPlanet: null,
        knownName: null,
      },
      achievement: {
        result: "pending_publish",
        newlyRecognized: false,
        unlockedTicIds: [],
        starCount: 0,
        grade: null,
      },
    }),
    "행성 2",
  );
  assert.equal(candidate.eyebrow, "발견");
  assert.equal(candidate.title, "행성 2를 발견했습니다");
  // Not recognized: no word about stars.
  assert.equal(candidate.note, "이 분석을 공개하면 성과 판정을 받습니다.");
});
