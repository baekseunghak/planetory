import { test } from "node:test";
import assert from "node:assert/strict";
import { readVisibility } from "../../src/features/profile/settings.ts";
test("settings consume server PUBLIC and PRIVATE, never infer defaults from malformed data", () => {
  for (const value of ["PUBLIC", "PRIVATE"])
    assert.equal(
      readVisibility({ memberId: "u-1", starListVisibility: value }, "u-1"),
      value,
    );
  for (const row of [
    null,
    {},
    [],
    { starListVisibility: null },
    { starListVisibility: "public" },
    { starListVisibility: true },
  ])
    assert.throws(() => readVisibility(row));
  assert.throws(() =>
    readVisibility({ memberId: "u-2", starListVisibility: "PRIVATE" }, "u-1"),
  );
});
