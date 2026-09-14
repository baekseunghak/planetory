import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  chartDomain,
  estimateDip,
  findPeaks,
  moveBoundary,
  normalizeView,
  panBy,
  phaseAt,
  pointerMode,
  repeatedRangeShifts,
  selectionFromDrag,
  stepZoom,
  visibleDomain,
  zoomAt,
} from "../src/graph-math.mjs";

const data = JSON.parse(
  await readFile(
    new URL("../public/observations/toi270.json", import.meta.url),
    "utf8",
  ),
);
const near = (actual, expected) =>
  assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("phase background drag selects by default", () => {
  assert.equal(pointerMode("phase", false, null, true), "selection");
});

test("Shift changes phase background drag into panning", () => {
  assert.equal(pointerMode("phase", true, null, true), "pan");
});

test("both boundary handles take priority over Shift panning", () => {
  for (const boundary of [0, 1]) {
    for (const shiftKey of [false, true]) {
      assert.equal(pointerMode("phase", shiftKey, boundary, true), "boundary");
    }
  }
});

test("disabled selection cannot create or edit a range but still allows Shift panning", () => {
  assert.equal(pointerMode("phase", false, null, false), null);
  assert.equal(pointerMode("phase", false, 0, false), null);
  assert.equal(pointerMode("phase", true, 1, false), null);
  assert.equal(pointerMode("phase", true, null, false), "pan");
});

test("time and period background drags pan regardless of Shift or selection callback", () => {
  for (const kind of ["time", "period"]) {
    for (const shiftKey of [false, true]) {
      for (const canSelect of [false, true]) {
        assert.equal(pointerMode(kind, shiftKey, null, canSelect), "pan");
      }
    }
  }
});

test("phase default is exactly two periods around the supplied folding center", () => {
  const domain = chartDomain("phase", data, 0.13);
  const view = normalizeView(null, domain);
  near(view.center, 0.13);
  const [initialMin, initialMax] = visibleDomain(view, domain);
  near(initialMin, -0.87);
  near(initialMax, 1.13);
  for (const zoom of [1, 2, 4, 8, 16, 20]) {
    const [min, max] = visibleDomain({ ...view, zoom }, domain);
    near(max - min, 2 / zoom);
  }
});

test("every real observation has two phase copies in a two-period half-open window", () => {
  const center = estimateDip(data, data.seedPeriod);
  const min = center - 1,
    max = center + 1;
  let copies = 0;
  data.time.forEach((time) => {
    const phase = phaseAt(time, data.referenceTime, data.seedPeriod);
    assert(phase >= 0 && phase < 1);
    let count = 0;
    for (let shift = Math.ceil(min - phase); phase + shift < max; shift++)
      count++;
    assert.equal(count, 2);
    copies += count;
  });
  assert.equal(copies, data.pointCount * 2);
});

test("wheel zoom preserves the phase value underneath an off-center pointer", () => {
  const domain = chartDomain("phase", data, 0.2);
  const start = { zoom: 1, center: 0.2 };
  const fraction = 0.73;
  const [min, max] = visibleDomain(start, domain);
  const anchor = min + fraction * (max - min);
  for (const requestedZoom of [3.25, 16, 20, 80]) {
    const next = zoomAt(start, domain, requestedZoom, anchor);
    const [nextMin, nextMax] = visibleDomain(next, domain);
    near((anchor - nextMin) / (nextMax - nextMin), fraction);
    assert.equal(next.zoom, Math.min(requestedZoom, 20));
    near(zoomAt(next, domain, 1, anchor).center, start.center);
  }
});

test("only the phase chart accepts zoom above eight and clamps at twenty", () => {
  for (const kind of ["phase", "time", "period"]) {
    const domain = chartDomain(kind, data, 0.2);
    const maximum = kind === "phase" ? 20 : 8;
    const initial = normalizeView(null, domain);
    assert.equal(domain.maxZoom, maximum);
    assert.equal(normalizeView({ ...initial, zoom: 80 }, domain).zoom, maximum);
    assert.equal(zoomAt(initial, domain, 80).zoom, maximum);
    assert.equal(normalizeView({ ...initial, zoom: -1 }, domain).zoom, 1);
    const maximumView = normalizeView({ ...initial, zoom: maximum }, domain);
    near(
      visibleDomain(maximumView, domain)[1] -
        visibleDomain(maximumView, domain)[0],
      (domain.max - domain.min) / maximum,
    );
    assert.equal(panBy(maximumView, domain, 0.1).zoom, maximum);
  }
});

test("time and log-period zoom stay within their observed domains", () => {
  for (const kind of ["time", "period"]) {
    const domain = chartDomain(kind, data);
    const next = normalizeView({ zoom: 80, center: domain.max + 1000 }, domain);
    assert.equal(next.zoom, 8);
    near(visibleDomain(next, domain)[1], domain.max);
    const reset = normalizeView(
      { zoom: -1, center: domain.min - 1000 },
      domain,
    );
    assert.equal(reset.zoom, 1);
    const [min, max] = visibleDomain(reset, domain);
    near(min, domain.min);
    near(max, domain.max);
  }
});

test("log-period zoom preserves pointer position in log coordinates", () => {
  const domain = chartDomain("period", data);
  const start = normalizeView(null, domain);
  const fraction = 0.6;
  const anchor = domain.min + fraction * (domain.max - domain.min);
  const [min, max] = visibleDomain(zoomAt(start, domain, 4, anchor), domain);
  near((anchor - min) / (max - min), fraction);
  near(
    10 ** anchor,
    data.periodogram.periods[0] *
      (data.periodogram.periods.at(-1) / data.periodogram.periods[0]) **
        fraction,
  );
});

test("panning returns only view state and does not mutate selection or period", () => {
  const state = {
    view: { zoom: 2, center: 0.7 },
    range: [0.96, 1.04],
    period: data.seedPeriod,
  };
  const before = structuredClone(state);
  const next = panBy(state.view, chartDomain("phase", data, 0.7), 0.2);
  near(next.center, 0.5);
  assert.deepEqual(state, before);
  assert.deepEqual(Object.keys(next).sort(), ["center", "zoom"]);
});

test("cross-zero selections remain unwrapped and repeat at one-period intervals", () => {
  const range = selectionFromDrag(0.96, 1.04);
  near(range[0], 0.96);
  near(range[1], 1.04);
  assert.deepEqual(repeatedRangeShifts(range, -0.5, 1.5), [-1, 0]);
  near(moveBoundary(range, 1, 1.06)[1] - range[0], 0.1);
});

test("boundary crossing and long selection drags preserve 0.002 to 0.98 width", () => {
  for (const range of [
    selectionFromDrag(-0.9, 1.9),
    selectionFromDrag(1.9, -0.9),
    selectionFromDrag(0.5, 0.5001),
    moveBoundary([0.4, 0.6], 0, 100),
    moveBoundary([0.4, 0.6], 1, -100),
    moveBoundary([0.4, 0.6], 0, -100),
    moveBoundary([0.4, 0.6], 1, 100),
  ]) {
    const width = range[1] - range[0];
    assert(width >= 0.002 - 1e-12 && width <= 0.98 + 1e-12);
    assert(width < 1);
  }
});

test("keyboard zoom chooses 1/2/4/8 after continuous wheel zoom", () => {
  assert.equal(stepZoom(1, 1), 2);
  assert.equal(stepZoom(2, 1), 4);
  assert.equal(stepZoom(4, 1), 8);
  assert.equal(stepZoom(8, 1), 8);
  assert.equal(stepZoom(3.25, 1), 4);
  assert.equal(stepZoom(3.25, -1), 2);
  assert.equal(stepZoom(1, -1), 1);
});

test("phase keyboard zoom reaches sixteen and twenty without changing other chart limits", () => {
  const maximum = chartDomain("phase", data).maxZoom;
  const levels = [1, 2, 4, 8, 16, 20];
  levels.forEach((zoom, i) => {
    assert.equal(
      stepZoom(zoom, 1, maximum),
      levels[Math.min(i + 1, levels.length - 1)],
    );
    assert.equal(stepZoom(zoom, -1, maximum), levels[Math.max(0, i - 1)]);
  });
  assert.equal(stepZoom(17.5, 1, maximum), 20);
  assert.equal(stepZoom(17.5, -1, maximum), 16);
  for (const kind of ["time", "period"]) {
    assert.equal(stepZoom(8, 1, chartDomain(kind, data).maxZoom), 8);
  }
});

test("existing observed-peak and dip helpers retain usable values", () => {
  const peaks = findPeaks(data.periodogram);
  assert.equal(peaks.length, 3);
  assert.equal(peaks[0].period, data.seedPeriod);
  const center = estimateDip(data, data.seedPeriod);
  assert(center >= 0 && center < 1);
  near(
    phaseAt(
      data.referenceTime - data.seedPeriod * 0.25,
      data.referenceTime,
      data.seedPeriod,
    ),
    0.75,
  );
});
