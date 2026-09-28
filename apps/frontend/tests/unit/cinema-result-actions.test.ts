import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ResultActions } from "../../src/cinema/analysis-new/ResultActions";
import type { SubmissionReceipt } from "../../src/features/analysis/submission-data";

function render(nextActions: string[], stage = "in_progress") {
  const receipt = {ticId:"123", nextActions, progress:{stage}} as SubmissionReceipt;
  return renderToStaticMarkup(createElement(MemoryRouter, {initialEntries:["/analysis/123?returnTo=%2Fsky"]},
    createElement(ResultActions, {receipt, kind:"matched", nextCurve:()=>{}, onDetails:()=>{}, onAgain:()=>{}})));
}
test("next curve is primary and publication keeps the star and return path", () => {
  const html = render(["NEXT_CURVE", "PUBLISH_ANALYSIS"]);
  assert.match(html, /class="cx-primary"[^>]*>다음 곡선 단계로/);
  assert.match(html, /class="cx-secondary"[^>]*href="([^"]+)"[^>]*>공개 검토/);
  const href = html.match(/href="([^"]*publication[^"]*)"/)![1].replaceAll("&amp;", "&");
  const url = new URL(href, "https://test.invalid");
  assert.equal(url.pathname, "/publication");
  assert.equal(url.searchParams.get("ticId"), "123");
  assert.equal(url.searchParams.get("returnTo"), "/analysis/123?returnTo=%2Fsky");
});
test("completed star prioritizes publication and suppresses next curve", () => {
  const html = render(["NEXT_CURVE", "PUBLISH_ANALYSIS"], "completed");
  assert.match(html, /class="cx-primary"[^>]*>이 별의 분석 공개 검토/);
  assert.doesNotMatch(html, /다음 곡선 단계로/);
});
test("without publication or next curve, details appears only once", () => {
  const html = render([]);
  assert.equal((html.match(/이번 제출 결과/g) ?? []).length, 1);
  assert.match(html, /class="cx-primary"[^>]*>이번 제출 결과/);
});
