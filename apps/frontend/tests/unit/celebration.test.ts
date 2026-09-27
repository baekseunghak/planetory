import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, beforeEach } from "node:test";
import {
  celebrationText,
  developCelebrationText,
  earnsCelebration,
  hasCelebrated,
  markCelebrated,
} from "../../src/features/analysis/celebration";
import { decodeSubmissionReceipt } from "../../src/features/analysis/submission-data";
import {
  PERIODOGRAM_FIXTURE_TICS,
  candidatePeaksFixture,
  periodContextFixture,
  periodogramFixtureResponse,
} from "../../dev/periodogram-fixtures";
import {
  SUBMISSION_FIXTURE_CSRF,
  submissionFixtureResponse,
  type SubmissionOutcomeKind,
} from "../../dev/submission-fixtures";

// 2.2절: 연출은 HTTP 상태가 아니라 회원·submissionId별 표시 이력으로 가른다.

const store = new Map<string, string>();
beforeEach(() => store.clear());
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

test("a submission celebrates once per member", () => {
  assert.equal(hasCelebrated("u-209", "sub-7000"), false);
  markCelebrated("u-209", "sub-7000");
  assert.equal(hasCelebrated("u-209", "sub-7000"), true);
  // 다른 제출은 별개다.
  assert.equal(hasCelebrated("u-209", "sub-7001"), false);
  // 다른 회원도 별개다. 같은 기기를 나눠 써도 남의 이력을 물려받지 않는다.
  assert.equal(hasCelebrated("u-777", "sub-7000"), false);
});

test("marking twice does not grow the history", () => {
  markCelebrated("u-209", "sub-7000");
  markCelebrated("u-209", "sub-7000");
  const saved = JSON.parse(store.get("planetory:analysis-celebrated")!);
  assert.deepEqual(saved["u-209"], ["sub-7000"]);
});

test("the history is capped so storage cannot fill up", () => {
  for (let i = 0; i < 260; i++) markCelebrated("u-209", `sub-${i}`);
  const saved = JSON.parse(store.get("planetory:analysis-celebrated")!);
  assert.equal(saved["u-209"].length, 200);
  // 최근 것을 남긴다. 오래된 제출의 연출이 다시 나오는 쪽이 덜 나쁘다.
  assert.equal(saved["u-209"].at(-1), "sub-259");
  assert.equal(hasCelebrated("u-209", "sub-0"), false);
});

test("a broken store is read as no history, not as an error", () => {
  store.set("planetory:analysis-celebrated", "not json");
  assert.doesNotThrow(() => hasCelebrated("u-209", "sub-7000"));
  assert.equal(hasCelebrated("u-209", "sub-7000"), false);
  // 배열이 아닌 값도 마찬가지다.
  store.set("planetory:analysis-celebrated", JSON.stringify({ "u-209": 7 }));
  assert.equal(hasCelebrated("u-209", "sub-7000"), false);
});

// 「축하합니다!」는 성과가 실제로 인정된 제출에만 붙는다. 처음 보는 결과라도
// 판단 불일치·공개 대기·미매칭·이미 인정됨에는 붙이지 않는다. 기존형과 새
// 분석은 같은 결과 설명(AnalysisResult의 ResultExplanationView)을 쓴다.

test("only a recognized achievement earns the celebration", () => {
  assert.equal(earnsCelebration("recognized"), true);
  for (const result of [
    "judgment_mismatch",
    "pending_publish",
    "already_recognized",
    "none",
    "unknown",
    "",
    null,
    undefined,
  ])
    assert.equal(earnsCelebration(result), false, String(result));
});

const TIC = PERIODOGRAM_FIXTURE_TICS.normal;
const peaks = candidatePeaksFixture(TIC).peaks;
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
  return decodeSubmissionReceipt(
    reply.body,
    { ticId: TIC, requestId },
    reply.status,
  );
}
const candidate = (
  rank: number | null,
  userJudgment: "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE",
) => ({
  submissionKind: "candidate",
  curveContext: periodContextFixture(TIC).currentCurveContext,
  selection: {
    periodDays: rank === null ? 5 : peaks[rank - 1].periodDays,
    sourcePeakGridIndex: rank === null ? null : peaks[rank - 1].gridIndex,
    phaseStart: 0.995,
    phaseEnd: 1.005,
  },
  userJudgment,
  evidenceChecks: [],
  memo: "",
});

test("a first view of real receipts celebrates a recognized result only", () => {
  const cases: [string, ReturnType<typeof submit>, string, boolean][] = [
    [
      "rank-1 + 행성 같음",
      submit(candidate(1, "LIKELY_PLANET")),
      "recognized",
      true,
    ],
    [
      "FP judged 아닌 것 같음",
      submit(candidate(3, "UNLIKELY_PLANET")),
      "recognized",
      true,
    ],
    [
      "judgment mismatch",
      submit(candidate(1, "UNLIKELY_PLANET")),
      "judgment_mismatch",
      false,
    ],
    [
      "pending publish",
      submit(candidate(2, "UNSURE")),
      "pending_publish",
      false,
    ],
    [
      "numeric mismatch",
      submit(candidate(null, "LIKELY_PLANET")),
      "none",
      false,
    ],
    [
      "duplicate",
      submit(candidate(1, "LIKELY_PLANET"), "duplicate"),
      "already_recognized",
      false,
    ],
  ];
  for (const [name, receipt, result, celebrates] of cases) {
    const achieved = receipt.explanation.achievement.result;
    assert.equal(achieved, result, name);
    assert.equal(
      celebrationText(true, achieved),
      celebrates ? "축하합니다!" : null,
      name,
    );
    // A repeated view never celebrates, not even a recognized result.
    assert.equal(celebrationText(false, achieved), null, name);
  }
});

test("the result view takes its celebration from the rule, never on its own", () => {
  // Both variants render ResultExplanationView; the line that decides the
  // cheer must go through celebrationText (the develop bug celebrated every
  // first view that had any achievement, mismatches included).
  const source = readFileSync(
    new URL("../../src/features/analysis/AnalysisResult.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("축하합니다"), false);
  assert.match(source, /celebrationText\(celebrate, achievement\.result\)/);
});

test("develop's screen (production default) keeps today's rule; the cinema shell opts into the strict one", () => {
  // Default build = develop's app: any first view celebrates, as in
  // production today. Only the cinema app provides StrictCelebration.
  assert.equal(developCelebrationText(true), "축하합니다!");
  assert.equal(developCelebrationText(false), null);
  const result = readFileSync(
    new URL("../../src/features/analysis/AnalysisResult.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    result,
    /strict\s*\?\s*celebrationText\(celebrate, achievement\.result\)\s*:\s*developCelebrationText\(celebrate\)/,
  );
  const cinema = readFileSync(
    new URL("../../src/main-cinema.tsx", import.meta.url),
    "utf8",
  );
  assert.match(cinema, /<StrictCelebration\.Provider value=\{true\}>/);
  const legacy = readFileSync(
    new URL("../../src/legacy/main.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(legacy.includes("StrictCelebration"), false);
});
