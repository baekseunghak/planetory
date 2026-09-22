import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicationDetail,
  publicationReceipt,
  createPublicationFixture,
  PUBLICATION_TIC,
} from "../../dev/publication-fixtures";
import {
  readPreview,
  readReceipt,
  readBatch,
  readCandidates,
  readVisibility,
  candidatesPath,
} from "../../src/features/publication/publication-data";

test("preview preserves original judgment, evidence and memo, verifies identities", () => {
  const source = publicationDetail("h-1951");
  const preview = readPreview(source, "h-1951", PUBLICATION_TIC, "c-1951");
  assert.equal(preview.memo, "통과 모양을 확인했습니다.");
  assert.deepEqual(preview.evidence, ["ushape"]);
  assert.throws(() => readPreview(source, "h-1952"));
  assert.throws(() => readPreview(source, "h-1951", "other"));
  assert.throws(() => readPreview(source, "h-1951", PUBLICATION_TIC, "other"));
});
test("missing submitted evidence and judgment cannot be fabricated", () => {
  const source = publicationDetail("h-1951");
  assert.throws(() =>
    readPreview(
      { ...source, submission: { ...source.submission, original: {} } },
      "h-1951",
    ),
  );
});
test("cancelled duplicate receipt stays not public and already recognized", () => {
  const receipt = readReceipt(
    publicationReceipt("h-1951", false, false),
    "h-1951",
  );
  assert.equal(receipt.isPublic, false);
  assert.equal(receipt.achievementGranted, true);
  assert.equal(receipt.newlyGranted, false);
});
test("receipt identity and independent achievement flags are validated", () => {
  const receipt = publicationReceipt("h-1951");
  assert.throws(() => readReceipt(receipt, "other"));
  assert.throws(() =>
    readReceipt({ ...receipt, achievementGranted: false }, "h-1951"),
  );
  assert.throws(() =>
    readReceipt({ ...receipt, newlyGranted: false }, "h-1951"),
  );
  assert.throws(() =>
    readReceipt({ ...receipt, achievementGranted: undefined }, "h-1951"),
  );
});
test("partial failure has no invented achievement flags", () => {
  const result = readBatch(
    {
      results: [
        { status: "PUBLISHED", ...publicationReceipt("h-1951") },
        {
          status: "FAILED",
          historyId: "h-1952",
          error: { code: "BUSY", message: "다시 시도" },
          retryable: true,
        },
      ],
    },
    ["h-1951", "h-1952"],
  );
  assert.equal(result[1].status, "FAILED");
  assert.equal("receipt" in result[1], false);
});
test("batch rejects omitted, duplicate, reordered and inconsistent results", () => {
  const item = { status: "PUBLISHED", ...publicationReceipt("h-1951") };
  assert.throws(() => readBatch({ results: [item] }, ["h-1951", "h-1952"]));
  assert.throws(() =>
    readBatch({ results: [item, item] }, ["h-1951", "h-1952"]),
  );
  assert.throws(() =>
    readBatch({ results: [{ ...item, isPublic: false }] }, ["h-1951"]),
  );
});
test("candidate page is scoped to TIC and one representative per signal", () => {
  const fixture = createPublicationFixture();
  const body = fixture(
    "GET",
    new URL(candidatesPath(PUBLICATION_TIC), "http://fixture.invalid"),
  )!.body;
  const page = readCandidates(body, PUBLICATION_TIC);
  assert.equal(page.items.length, 2);
  assert.throws(() => readCandidates(body, "other"));
  assert.throws(() =>
    readCandidates(
      { ...(body as object), items: [page.items[0], page.items[0]] },
      PUBLICATION_TIC,
    ),
  );
});
test("visibility checks current effective visibility, not just author setting", () => {
  const value = {
    analysisId: "pa-1",
    isPublic: false,
    isEffectivelyPublic: false,
    isPublicByAuthor: true,
    isModerationHidden: true,
  };
  assert.equal(readVisibility(value, "pa-1").isPublic, false);
  assert.throws(() => readVisibility({ ...value, isPublic: true }, "pa-1"));
  assert.throws(() => readVisibility(value, "pa-2"));
});
