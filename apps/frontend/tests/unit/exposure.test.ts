import test from "node:test";
import assert from "node:assert/strict";
import { galaxyExposure } from "../../src/features/sky-renderer/exposure.ts";

test("dense overview is gentle, approach restores light without exceeding original exposure", () => {
  for (const count of [2501, 10000, 50000]) {
    const samples = [0.1, 0.5, 1, 2, 4, 6, 100].map((zoom) =>
      galaxyExposure(count, zoom),
    );
    assert.ok(samples[0] < 1);
    assert.ok(
      samples.every(
        (value, i) =>
          value > 0 && value <= 1 && (i === 0 || value >= samples[i - 1]),
      ),
    );
    assert.equal(samples.at(-1), 1);
  }
  for (const count of [0, 1, 10, 100, 1000]) {
    for (const zoom of [0.1, 1, 6])
      assert.equal(galaxyExposure(count, zoom), 1);
  }
});
