// DEV harness data only. Synthetic stars in the personal-spiral-v1 shape with
// the fixture's TIC naming (900000001 + index); never used by the app.
import {
  LAYOUT_VERSION,
  PRESENTATION_VERSION,
  type SkyMeta,
  type Star,
} from "../../../features/sky-data/contracts";
import { scenePlanet, type SceneSystem } from "../contract";
import { decorativeStar } from "../procedural";

export const ticOf = (index: number) => String(900000001 + index);

export function harnessStar(index: number): Star {
  const planetCount = index === 0 ? 5 : index === 7 ? 2 : 0;
  return {
    ticId: ticOf(index),
    ...decorativeStar(index),
    planetCount,
    progressStage:
      index < 2 ? "completed" : index === 7 ? "in_progress" : "unexplored",
    completedWithoutPlanets: index === 1,
    marker:
      index >= 2 && index <= 4
        ? { type: "tutorial", seq: index + 1 }
        : index === 5
          ? { type: "challenge" }
          : null,
    reopened: false,
  };
}

export function harnessSky(count: number, extra: readonly Star[] = []) {
  const stars = [
    ...Array.from({ length: count }, (_, i) => harnessStar(i)),
    ...extra,
  ];
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const s of stars) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
  }
  const meta: SkyMeta = {
    representation: "individual-stars",
    layoutVersion: LAYOUT_VERSION,
    presentationVersion: PRESENTATION_VERSION,
    version: `harness:${count}:${extra.length}`,
    starCount: stars.length,
    bounds: { minX, maxX, minY, maxY },
    tileSize: 512,
    zoomLevels: [0.25, 1, 4].map((scale, level) => ({ scale, level })),
    centerTicIds: [stars[0].ticId],
    firstVisit: false,
  };
  return { stars, meta };
}

const planets: Record<string, SceneSystem["planets"]> = {
  "900000001": [
    scenePlanet({
      candidateId: "fixture-204-p-0",
      kind: "confirmed",
      periodDays: 3.21,
      depthPpm: 5200,
    }),
    scenePlanet({
      candidateId: "fixture-204-p-1",
      kind: "unconfirmed",
      periodDays: 6.8,
      depthPpm: 1800,
    }),
    scenePlanet({
      candidateId: "fixture-204-p-2",
      kind: "confirmed",
      periodDays: 11.4,
      depthPpm: 7400,
    }),
    scenePlanet({
      candidateId: "fixture-204-p-3",
      kind: "unconfirmed",
      periodDays: null,
      depthPpm: null,
    }),
    scenePlanet({
      candidateId: "fixture-204-p-4",
      kind: "confirmed",
      periodDays: 27.9,
      depthPpm: 3100,
    }),
  ],
  "900000008": [
    scenePlanet({
      candidateId: "fixture-204-p-0",
      kind: "confirmed",
      periodDays: 4.4,
      depthPpm: 6100,
    }),
    scenePlanet({
      candidateId: "fixture-204-p-1",
      kind: "unconfirmed",
      periodDays: 9.2,
      depthPpm: 2400,
    }),
  ],
};

export function harnessSystem(star: Star): SceneSystem {
  return {
    ticId: star.ticId,
    version: "harness",
    position: {
      x: star.x,
      y: star.y,
      depthZ: star.depthZ,
      layoutOrdinal: star.layoutOrdinal,
    },
    planets: planets[star.ticId] ?? [],
  };
}
