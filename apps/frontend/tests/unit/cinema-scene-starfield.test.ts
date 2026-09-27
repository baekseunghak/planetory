import assert from "node:assert/strict";
import { test } from "node:test";
import type { BufferAttribute } from "three";
import { StarField } from "../../src/cinema/scene/galaxy-layer";
import { starWorld } from "../../src/cinema/scene/math";
import { harnessSky } from "../../src/cinema/scene/dev/fake-sky";
import { starStyle } from "../../src/features/sky-renderer/model";

// CPU side of the one-buffer star field (no WebGL needed).
test("an empty first setStars works, then the buffer grows and indexes every star", () => {
  const field = new StarField(30);
  field.setStars([]);
  assert.equal(field.count, 0);
  assert.equal(field.points.geometry.drawRange.count, 0);
  const { stars } = harnessSky(3000);
  field.setStars(stars);
  assert.equal(field.count, 3000);
  assert.equal(field.points.geometry.drawRange.count, 3000);
  const size = field.points.geometry.getAttribute("aSize") as BufferAttribute;
  assert.ok(size.count >= 3000, "capacity is a power of two above the count");
  const i = field.indexOf("900000011");
  assert.equal(i, 10);
  assert.deepEqual(
    Array.from(field.positions.subarray(i * 3, i * 3 + 3)),
    Array.from(
      new Float32Array(starWorld(stars[10].x, stars[10].y, stars[10].depthZ)),
    ),
  );
  assert.equal(field.baseSizes[i], Math.fround(starStyle(stars[10]).baseSize));
  field.dispose();
});

test("hidden and scaled stars change only their own size and are not pickable", () => {
  const field = new StarField(30);
  const { stars } = harnessSky(10);
  field.setStars(stars);
  const i = field.indexOf("900000003");
  assert.ok(field.visibleAt(i));
  field.setHidden("900000003", true);
  assert.equal(field.sizeAt(i), 0);
  assert.equal(field.visibleAt(i), false);
  assert.ok(field.visibleAt(i + 1));
  // hidden survives a new snapshot of the same sky
  field.setStars([...stars]);
  assert.equal(field.sizeAt(field.indexOf("900000003")), 0);
  field.setHidden("900000003", false);
  field.setScale("900000003", 2);
  near(field.sizeAt(i), field.baseSizes[i] * 2);
  field.setScale("900000003", null);
  near(field.sizeAt(i), field.baseSizes[i]);
  field.dispose();
});

test("the decorative spiral is not member data", () => {
  const field = new StarField(30);
  field.setDecorative(500);
  assert.equal(field.decorative, true);
  assert.equal(field.count, 500);
  const { stars } = harnessSky(20);
  field.setStars(stars);
  assert.equal(field.decorative, false);
  assert.equal(field.count, 20);
  field.dispose();
});

function near(a: number, b: number) {
  assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
}
