import assert from "node:assert/strict";
import { test } from "node:test";
import type { Star } from "../../src/features/sky-data/contracts";
import {
  FIRST_VISIT_KEY,
  TUTORIAL_GUIDES,
  TUTORIAL_GUIDE_KEY,
  closeGuide,
  firstVisitFlown,
  guideLineFor,
  guidesVersion,
  isGuideClosed,
  resetFirstVisitHere,
  resetGuidesHere,
  subscribeGuides,
  takeFirstVisitFlight,
  tutorialGuide,
  tutorialSeqOf,
} from "../../src/cinema/shell/tutorial-guide";

// Tutorial guide lines are keyed by the tutorial sequence the backend gives
// (sky star marker, else quests markers), never by TIC.

const star = (
  ticId: string,
  marker: Star["marker"],
  progressStage: Star["progressStage"] = "unexplored",
): Star => ({
  ticId,
  x: 0,
  y: 0,
  depthZ: 0,
  layoutOrdinal: 0,
  planetCount: 0,
  progressStage,
  completedWithoutPlanets: false,
  marker,
  reopened: false,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}
const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

test("the sequence comes from the star's marker, then the quests' markers", () => {
  const stars = [
    star("149603524", { type: "tutorial", seq: 1 }),
    star("900000002", { type: "tutorial", seq: 2 }),
    star("259377017", { type: "challenge" }),
    star("900000010", null),
  ];
  assert.equal(tutorialSeqOf("149603524", stars, null), 1);
  assert.equal(tutorialSeqOf("900000002", stars, null), 2);
  assert.equal(tutorialSeqOf("259377017", stars, null), null);
  assert.equal(tutorialSeqOf("900000010", stars, null), null);
  const markers = new Map([
    ["300871545", { seq: 4, completed: false, visible: true }],
  ]);
  assert.equal(tutorialSeqOf("300871545", [], markers), 4);
  // The star's own marker wins over the quests' copy.
  assert.equal(
    tutorialSeqOf(
      "149603524",
      stars,
      new Map([["149603524", { seq: 3, completed: false, visible: true }]]),
    ),
    1,
  );
  assert.equal(tutorialSeqOf("unknown", stars, markers), null);
});

// ---------------------------------------------------------------- copy rules

const lines = Object.entries(TUTORIAL_GUIDES).flatMap(([seq, byPlace]) =>
  Object.entries(byPlace).map(([place, line]) => ({ seq, place, line })),
);

test("lines exist for tutorials 1-5 in both places, with the key numbers", () => {
  assert.deepEqual(Object.keys(TUTORIAL_GUIDES).map(Number), [1, 2, 3, 4, 5]);
  for (const byPlace of Object.values(TUTORIAL_GUIDES))
    assert.deepEqual(Object.keys(byPlace).sort(), ["analysis", "star"]);
  assert.match(tutorialGuide(1)!, /추천 봉우리 1위\(약 4\.41일\).*행성 같음/);
  assert.match(
    tutorialGuide(2)!,
    /3\.69일.*행성 1.*'다음 곡선 단계로'.*행성 2\(약 7\.45일\).*행성 3\(약 2\.25일\)/,
  );
  assert.match(tutorialGuide(5)!, /5\.49일.*아닌 것 같음.*5\.67일/);
  assert.equal(tutorialGuide(1), tutorialGuide(1, "analysis"));
  assert.notEqual(tutorialGuide(1, "star"), tutorialGuide(1, "analysis"));
  for (const seq of [null, 0, 6, -1, 1.5])
    for (const place of ["star", "analysis"] as const)
      assert.equal(tutorialGuide(seq, place), null);
});

test("no jargon, no planet letters, no diagnostic tools that are not connected", () => {
  // Jargon a newcomer cannot read (the plain words are used instead) and the
  // 홀짝·2차 식·V/U tools, which the analysis screen still marks 연결 준비 중.
  const banned =
    /딥|주극소|부극소|잔차|식쌍성|홀짝|2차 식|V\/U|V·U|U형|V형|BLS|위상|transit|dip/i;
  for (const { seq, place, line } of lines) {
    assert.doesNotMatch(line, banned, `tutorial ${seq} ${place}: ${line}`);
    // Catalog letters (b, c, d) and pair labels (A, B) are not names the
    // screen shows; it says 행성 1/2/3 and 신호 1/2.
    assert.doesNotMatch(
      line,
      /(^|[^A-Za-z])[A-Za-z](?![A-Za-z])/,
      `tutorial ${seq} ${place}: a lone letter in "${line}"`,
    );
  }
});

test("tutorials 3 and 4 say what to look for in the folded curve and which judgment", () => {
  for (const seq of [3, 4]) {
    const line = tutorialGuide(seq, "analysis")!;
    assert.match(line, /두 곳 사이 한가운데/, `tutorial ${seq}`);
    assert.match(line, /얕은 감소/, `tutorial ${seq}`);
    assert.match(line, /'아닌 것 같음'을 고르세요/, `tutorial ${seq}`);
    assert.match(line, /두 별이 서로 가리는/, `tutorial ${seq}`);
  }
  assert.match(tutorialGuide(3, "analysis")!, /추천 봉우리 1위/);
  assert.match(tutorialGuide(4, "analysis")!, /확대/);
});

test("the names are the ones on screen, in the polite register", () => {
  const names =
    /추천 봉우리 1위|접힌 곡선|구간|'행성 같음'|'아닌 것 같음'|'다음 곡선 단계로'|'분석 시작'|행성 \d|신호 \d/;
  for (const { seq, place, line } of lines) {
    assert.match(line, names, `tutorial ${seq} ${place}`);
    // Every sentence ends politely: "~ㅂ니다." or "~세요.", never "~어요".
    for (const sentence of line.split(/(?<=\.)\s+/))
      assert.match(
        sentence,
        /(니다|세요)\.$/,
        `tutorial ${seq} ${place}: "${sentence}"`,
      );
    assert.doesNotMatch(line, /[어아]요\./);
  }
});

test("two lines at most at 1024px: short star lines, bounded analysis lines", () => {
  // Star panel text ~368px (about 28 characters a line at 13px) after the
  // "튜토리얼 N" label; the analysis strip ~790px (about 58 a line).
  for (const { seq, place, line } of lines)
    assert.ok(
      line.length <= (place === "star" ? 48 : 108),
      `tutorial ${seq} ${place} is ${line.length} characters`,
    );
});

// ---------------------------------------------------------------- showing

test("a completed star, a closed place or a non-tutorial star shows no line", () => {
  resetGuidesHere();
  const storage = memoryStorage();
  const stars = [
    star("149603524", { type: "tutorial", seq: 1 }),
    star("307210830", { type: "tutorial", seq: 2 }, "completed"),
    star("279569718", { type: "tutorial", seq: 3 }, "in_progress"),
    star("900000010", null),
  ];
  assert.deepEqual(guideLineFor("149603524", "star", stars, null, storage), {
    seq: 1,
    line: TUTORIAL_GUIDES[1].star,
  });
  assert.equal(
    guideLineFor("307210830", "analysis", stars, null, storage),
    null,
  );
  assert.equal(
    guideLineFor("279569718", "analysis", stars, null, storage)?.seq,
    3,
  );
  assert.equal(guideLineFor("900000010", "star", stars, null, storage), null);
  closeGuide(storage, "analysis", 3);
  assert.equal(
    guideLineFor("279569718", "analysis", stars, null, storage),
    null,
  );
  assert.equal(guideLineFor("279569718", "star", stars, null, storage)?.seq, 3);
});

test("closing is per place and per tutorial, heard at once; a broken store never throws", () => {
  resetGuidesHere();
  const storage = memoryStorage();
  let heard = 0;
  const off = subscribeGuides(() => heard++);
  const before = guidesVersion();
  assert.equal(isGuideClosed(storage, "analysis", 1), false);
  closeGuide(storage, "analysis", 1);
  assert.equal(heard, 1);
  assert.equal(guidesVersion(), before + 1);
  assert.equal(isGuideClosed(storage, "analysis", 1), true);
  assert.equal(isGuideClosed(storage, "star", 1), false);
  assert.equal(isGuideClosed(storage, "analysis", 2), false);
  closeGuide(storage, "analysis", 1);
  assert.deepEqual(JSON.parse(storage.data.get(TUTORIAL_GUIDE_KEY)!), [
    "analysis:1",
  ]);
  off();
  closeGuide(storage, "star", 2);
  assert.equal(heard, 2);
  // Another tab's store (or a reload) without this page's memory.
  resetGuidesHere();
  storage.data.set(TUTORIAL_GUIDE_KEY, "{not json");
  assert.equal(isGuideClosed(storage, "analysis", 1), false);
  // Blocked storage: closed for this page, and no throw.
  assert.equal(isGuideClosed(throwing, "star", 3), false);
  assert.doesNotThrow(() => closeGuide(throwing, "star", 3));
  assert.equal(isGuideClosed(throwing, "star", 3), true);
  assert.equal(isGuideClosed(null, "star", 4), false);
  resetGuidesHere();
});

// ---------------------------------------------------------------- first visit

test("the first-visit flight to tutorial 1 is taken once per member, across reloads", () => {
  resetFirstVisitHere();
  const storage = memoryStorage();
  assert.equal(firstVisitFlown(storage, "u-209"), false);
  assert.equal(takeFirstVisitFlight(storage, "u-209"), true);
  // "← 나의 은하" and any later galaxy visit: no second flight.
  assert.equal(takeFirstVisitFlight(storage, "u-209"), false);
  assert.equal(firstVisitFlown(storage, "u-209"), true);
  // A reload (a new page: nothing remembered in memory) reads the store.
  resetFirstVisitHere();
  assert.equal(takeFirstVisitFlight(storage, "u-209"), false);
  // Another member on this browser still gets theirs, and both are kept.
  assert.equal(takeFirstVisitFlight(storage, "u-300"), true);
  assert.deepEqual(JSON.parse(storage.data.get(FIRST_VISIT_KEY)!), [
    "u-209",
    "u-300",
  ]);
  assert.equal(takeFirstVisitFlight(storage, ""), false);
  resetFirstVisitHere();
});

test("a blocked or broken store still flies only once in the page", () => {
  resetFirstVisitHere();
  assert.equal(takeFirstVisitFlight(throwing, "u-209"), true);
  assert.equal(takeFirstVisitFlight(throwing, "u-209"), false);
  assert.equal(takeFirstVisitFlight(null, "u-209"), false);
  resetFirstVisitHere();
  const storage = memoryStorage();
  storage.data.set(FIRST_VISIT_KEY, '{"u-209":true}');
  assert.equal(firstVisitFlown(storage, "u-209"), false);
  assert.equal(takeFirstVisitFlight(storage, "u-209"), true);
  assert.deepEqual(JSON.parse(storage.data.get(FIRST_VISIT_KEY)!), ["u-209"]);
  resetFirstVisitHere();
});
