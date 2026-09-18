import test from "node:test";
import assert from "node:assert/strict";
import { exampleStar } from "../../dev/sky-reference/reference.mjs";
import { ProjectedStarIndex } from "../../src/features/sky-renderer/star-index.ts";
import {
  HitGrid,
  starTargets,
} from "../../src/features/sky-renderer/interaction.ts";
import {
  cameraMatrix,
  INITIAL_CAMERA,
} from "../../src/features/sky-renderer/model.ts";

test("world quadtree candidates preserve visible screen-grid hits across cameras, DPR, selection and overlap", () => {
  const stars = Array.from({ length: 2501 }, (_, i) => exampleStar(i));
  stars.push({ ...stars[30], ticId: "000000001" });
  for (const dpr of [1, 2])
    for (const camera of [
      INITIAL_CAMERA,
      { ...INITIAL_CAMERA, zoom: 0.18, yaw: 2.3, tilt: -1.3, x: 400, y: -500 },
      { ...INITIAL_CAMERA, zoom: 6, yaw: -0.8, roll: 1.2, x: 240, y: 85 },
    ]) {
      const matrix = cameraMatrix(camera, 1440, 900);
      const targets = starTargets(
        stars,
        matrix,
        1440,
        900,
        camera.zoom,
        stars[0].ticId,
        null,
        dpr,
      );
      const old = new HitGrid(targets),
        index = new ProjectedStarIndex(
          stars,
          matrix,
          1440,
          900,
          camera.zoom,
          stars[0].ticId,
          null,
          dpr,
        );
      assert.deepEqual(
        index.targets.map((t) => t.id),
        targets.map((t) => t.id),
      );
      for (const t of targets.filter((_, i) => i % 19 === 0))
        for (const delta of [0, 7.5, 17]) {
          assert.equal(
            index.hit(t.x + delta, t.y)?.id,
            old.hit(t.x + delta, t.y)?.id,
          );
          assert.deepEqual(index.byId.get(t.id), t);
        }
      for (let x = -80; x < 1520; x += 80)
        for (let y = -80; y < 980; y += 100)
          assert.equal(index.hit(x, y)?.id, old.hit(x, y)?.id);
    }
});
test("empty/coincident points and selected large body do not disappear or recurse forever", () => {
  const m = cameraMatrix(INITIAL_CAMERA, 1024, 768);
  assert.equal(
    new ProjectedStarIndex([], m, 1024, 768, 1, null, null).hit(0, 0),
    null,
  );
  const stars = Array.from({ length: 100 }, (_, i) => ({
    ...exampleStar(0),
    ticId: String(i),
  }));
  const selected = stars[50].ticId,
    system = { ticId: selected } as never;
  const targets = starTargets(stars, m, 1024, 768, 1, selected, system, 2);
  const expected = new HitGrid(targets),
    actual = new ProjectedStarIndex(
      stars,
      m,
      1024,
      768,
      1,
      selected,
      system,
      2,
    );
  const t = actual.byId.get(selected)!;
  assert.equal(actual.hit(t.x + 20, t.y)?.id, expected.hit(t.x + 20, t.y)?.id);
});
