import assert from "node:assert/strict";
import { fineRangeFor, selectionPreview } from "../src/analysis-state.mjs";

const data = { referenceTime: 100, time: [95, 110] };
const result = selectionPreview(data, 5, [-0.02, 0.03]);
assert.ok(Math.abs(result.start - 0.98) < 1e-12);
assert.ok(Math.abs(result.end - 1.03) < 1e-12);
assert.ok(
  Math.abs(result.epoch - 100.025) < 1e-12,
  "Phase wrapping must not move epoch forward one period",
);
assert.ok(Math.abs(result.durationHours - 6) < 1e-12);
const repeat = selectionPreview(data, 5, [0.98, 1.03]);
assert.ok(
  Math.abs(result.epoch - repeat.epoch) < 1e-12,
  "Selecting the repeated band must preserve epoch",
);
assert.equal(
  selectionPreview(data, 2, [0.4, 0.6]).epoch,
  99,
  "An exact epoch tie chooses the earlier transit",
);
assert.equal(
  selectionPreview(
    { referenceTime: 1341, time: [1291, 1391] },
    5.660333,
    [0.45, 0.55],
  ).epoch,
  1338.1698335,
  "An epoch tie at large BTJD values still chooses the earlier transit",
);
assert.equal(
  selectionPreview({ referenceTime: 100, time: [100.1, 100.2] }, 2, [0.4, 0.6]),
  null,
  "No epoch in observation bounds is not submittable",
);
assert.equal(selectionPreview(data, 5, [0, 1]), null);
assert.equal(selectionPreview(data, 5, [0.2, 0.1]), null);
assert.equal(selectionPreview(data, Infinity, [0.2, 0.3]), null);
const fine = fineRangeFor([1, 1.1, 1.2, 1.3, 1.4, 1.5], 1.3);
assert.equal(fine.origin, 1.3);
assert.equal(fine.min, 1);
assert.equal(fine.max, 1.5);
assert.ok(
  Math.abs(fine.step - 0.002) < 1e-12,
  "Fine step is derived from saved BLS spacing",
);
console.log(
  "Analysis state: wrapped interval, repeated band, nearest epoch, tie, bounds, invalid values, BLS-derived fine controls passed.",
);
