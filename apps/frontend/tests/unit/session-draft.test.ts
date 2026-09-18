import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readSavedDraft,
  type SavedAnalysisDraft,
} from "../../src/features/analysis/session-draft";

const draft: SavedAnalysisDraft = {
  schema: 1,
  identity: "context-and-rules",
  periodDays: 11.73461633238643,
  sourcePeakGridIndex: null,
  range: { phaseStart: -0.005, phaseEnd: 0.005 },
  judgment: {
    userJudgment: "UNSURE",
    evidenceChecks: ["oddeven"],
    memo: "🌌".repeat(201),
  },
};
test("session draft keeps full precision and over-limit text for editing, without trusting derived values", () => {
  assert.deepEqual(
    readSavedDraft(JSON.stringify(draft), draft.identity),
    draft,
  );
});
test("session draft rejects stale identities, malformed values and unsupported judgments or evidence", () => {
  assert.throws(() =>
    readSavedDraft(JSON.stringify(draft), "new-data-or-rules"),
  );
  for (const value of [
    null,
    {},
    { ...draft, schema: 2 },
    { ...draft, periodDays: 0 },
    { ...draft, sourcePeakGridIndex: -1 },
    { ...draft, range: { phaseStart: -1, phaseEnd: 1 } },
    { ...draft, judgment: { ...draft.judgment, userJudgment: "OTHER" } },
    { ...draft, judgment: { ...draft.judgment, evidenceChecks: ["centroid"] } },
  ])
    assert.throws(() => readSavedDraft(JSON.stringify(value), draft.identity));
  assert.throws(() => readSavedDraft("{broken", draft.identity));
});
