import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStarFilters,
  starSearchPath,
  searchWithFilters,
  filtersFromSearch,
  readStarLocation,
  LocateVersionChanged,
} from "../../src/features/sky-renderer/star-search.ts";
import type { SkyMeta } from "../../src/features/sky-data/contracts.ts";
const meta = {
  layoutVersion: "personal-spiral-v1",
  version: "v1",
  zoomLevels: [{ level: 2, scale: 4 }],
  bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
} as SkyMeta;
const location = {
  ticId: "123",
  x: 20,
  y: -20,
  depthZ: 0.4,
  layoutOrdinal: 7,
  layoutVersion: meta.layoutVersion,
  version: "v1",
  level: 2,
  bounds: { x: 0, y: -30, w: 50, h: 50 },
};
test("filters normalize TIC labels, encode cursors and keep discovery/submission scopes distinct", () => {
  const filters = normalizeStarFilters({
    ticId: " TIC 123 ",
    stage: "in_progress",
    grade: "S",
  });
  const path = new URL(
    starSearchPath(filters, "opaque&cursor", "submitted"),
    "http://local",
  );
  assert.equal(path.searchParams.get("scope"), "submitted");
  assert.equal(path.searchParams.get("ticId"), "123");
  assert.equal(path.searchParams.get("cursor"), "opaque&cursor");
  const search = searchWithFilters("star=45&view=list", filters);
  assert.equal(new URLSearchParams(search).has("star"), false);
  assert.equal(new URLSearchParams(search).get("view"), "list");
  assert.deepEqual(filtersFromSearch(search), filters);
  assert.equal(
    normalizeStarFilters({ ...filters, ticId: "9223372036854775807" }).ticId,
    "9223372036854775807",
  );
  for (const value of [
    { ...filters, ticId: "-1" },
    { ...filters, ticId: "9223372036854775808" },
    { ...filters, ticId: "9".repeat(100) },
    { ...filters, grade: "planet" },
    { ...filters, stage: "confirmed" },
  ])
    assert.throws(() => normalizeStarFilters(value));
});
test("locate rejects foreign IDs, versions, non-finite coordinates, invalid depth and wrong bounding boxes", () => {
  assert.equal(readStarLocation(location, "123", meta).zoom, 4);
  assert.throws(
    () => readStarLocation({ ...location, version: "v2" }, "123", meta),
    LocateVersionChanged,
  );
  for (const patch of [
    { ticId: "124" },
    { x: Infinity },
    { y: NaN },
    { depthZ: 2 },
    { level: 5 },
    { layoutOrdinal: -1 },
    { bounds: { x: 30, y: 30, w: 2, h: 2 } },
  ])
    assert.throws(() =>
      readStarLocation({ ...location, ...patch }, "123", meta),
    );
});
