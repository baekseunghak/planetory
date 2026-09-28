import test from "node:test";
import assert from "node:assert/strict";
import { explorationOrigin, recordParent, starResultsLocation } from "../../src/cinema/analysis/results/navigation.ts";

const tic = "9900000001";
const wrap = (path: string, parent: string) => `${path}?returnTo=${encodeURIComponent(parent)}`;

test("old result-record-result chains return to the original filtered galaxy", () => {
  const origin = `/sky?filterStage=completed&star=${tic}`;
  const analysis = wrap(`/analysis/${tic}`, origin);
  const result = wrap(`/results/${tic}`, analysis);
  const history = wrap("/history/h-1", result);
  assert.equal(explorationOrigin(history, tic), origin);
  assert.equal(recordParent(result, tic), wrap(`/results/${tic}`, origin));
});

test("repeated result, record and retry visits keep a bounded return path", () => {
  const origin = "/history?result=matched&page=2#records";
  let result = starResultsLocation(tic, origin);
  const expected = result;
  for (let i = 0; i < 30; i++) {
    const record = wrap("/history/h-1", result);
    const retry = wrap(`/analysis/${tic}`, recordParent(result, tic));
    result = starResultsLocation(tic, i % 2 ? record : retry);
    assert.equal(result, expected);
  }
});

test("record parents preserve list filters and reject external return URLs", () => {
  assert.equal(recordParent("/me?tab=history&result=matched", tic), "/me?tab=history&result=matched");
  assert.equal(explorationOrigin("https://outside.invalid", tic), `/sky?star=${tic}`);
  assert.equal(explorationOrigin(wrap("/results/1", "//outside.invalid"), tic), `/sky?star=${tic}`);
});
