import { test } from "node:test";
import assert from "node:assert/strict";
import { starResultFixture } from "../../dev/star-result-fixtures.ts";
import { readStarResult } from "../../src/features/analysis/star-result.ts";
const ticId = "259377024";
test("star aggregate distinguishes duplicate submissions from signals and preserves server achievement", () => {
  const result = readStarResult(starResultFixture(), ticId);
  assert.equal(result.signals.length, 1);
  assert.equal(result.submissionCount, 3);
  assert.equal(result.achievement.grade, "A");
  assert.equal(result.progress.stage, "completed");
  assert.equal(result.unpublishedSignalCount, 1);
  assert.equal(result.signals[0].statistics?.kind, "public_analyses");
});
test("wrong TIC and duplicate submissions cannot become another star's result", () => {
  assert.throws(() => readStarResult(starResultFixture("other"), ticId));
  const body = starResultFixture();
  body.unmatchedSubmissions[0].submissionId = "sub-7001";
  assert.throws(() => readStarResult(body, ticId));
});
test("nullable current bundle and unknown future actions keep old results readable", () => {
  const result = readStarResult(
    { ...starResultFixture(), bundle: null, nextActions: ["FUTURE_ACTION"] },
    ticId,
  );
  assert.equal(result.bundle, null);
  assert.equal(result.nextActions[0], "FUTURE_ACTION");
});
test("invalid residual context and mismatched private thread lists are rejected", () => {
  const body = starResultFixture();
  body.curveSteps[1].removedCandidateIds = [];
  assert.throws(() => readStarResult(body, ticId));
  assert.throws(() =>
    readStarResult(
      {
        ...starResultFixture(),
        links: { boardOpen: true, threadIds: ["other"] },
      },
      ticId,
    ),
  );
});
