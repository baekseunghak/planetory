import assert from "node:assert/strict";
import { test } from "node:test";
import { createNoopSceneController } from "../../src/cinema/scene/contract";
import { readStage } from "../../src/cinema/shell/stage";
import { directStage } from "../../src/cinema/shell/useStageDirector";

// Another member's galaxy is a stage of the one scene only when the cinema
// public view is on; otherwise it stays a page over the backdrop.
test("/members/:id/sky is the public stage only with the cinema view", () => {
  assert.deepEqual(readStage("/members/u-301/sky", ""), {
    stage: "backdrop",
    ticId: null,
  });
  assert.deepEqual(
    readStage("/members/u-301/sky", "?star=1", { publicGalaxy: true }),
    { stage: "public", ticId: null, memberId: "u-301" },
  );
  assert.deepEqual(
    readStage("/members/%E0%A4%A/sky", "", { publicGalaxy: true }).stage,
    "backdrop",
  );
  assert.equal(
    readStage("/members/u-301", "", { publicGalaxy: true }).stage,
    "backdrop",
  );
});

test("the director leaves my star for the public galaxy and flies nowhere else", async () => {
  const scene = createNoopSceneController();
  const calls: string[] = [];
  const wrapped = new Proxy(scene, {
    get(target, key: keyof typeof scene) {
      const value = target[key];
      return typeof value === "function"
        ? (...args: unknown[]) => {
            if (key !== "getState") calls.push(String(key));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          }
        : value;
    },
  });
  await scene.focusStar("900000008");
  const flight = { current: { ticId: "900000008", loaded: true } };
  let arrived = 0;
  await directStage(
    wrapped,
    { stage: "public", ticId: null, memberId: "u-301" },
    {
      starLoaded: false,
      flight,
      current: () => true,
      onGalaxy: () => arrived++,
    },
  );
  assert.deepEqual(calls, ["returnToGalaxy", "setSystem"]);
  assert.equal(scene.getState().mode, "galaxy");
  assert.equal(flight.current, null);
  assert.equal(arrived, 0, "no ignitions on someone else's galaxy");
});
