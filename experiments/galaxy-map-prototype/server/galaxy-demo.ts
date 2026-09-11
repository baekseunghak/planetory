import { catalogue, TUTORIALS, correct } from "./fixtures";
import type { Store } from "./store";
import type { GalaxyData, GalaxyStar } from "../shared/galaxy";

export const GALAXY_COUNT = 50000;
function randomFor(index: number) {
  let seed = Math.imul(index + 71, 2654435761) >>> 0;
  return () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function galaxyPosition(index: number) {
  const rand = randomFor(index);
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(Math.max(0.00001, rand()))) *
    Math.cos(2 * Math.PI * rand());
  const core = index % 10 < 2;
  let x: number, y: number, z: number;
  if (core) {
    x = gaussian() * 122;
    y = gaussian() * 112;
    z = gaussian() * 45;
  } else {
    const r = 85 + Math.pow(rand(), 0.72) * 1140;
    const arm = index % 4;
    const theta =
      index % 7 === 0
        ? rand() * Math.PI * 2
        : (arm * Math.PI) / 2 +
          Math.pow(r / 1200, 0.7) * 5.6 +
          gaussian() * (0.075 + r / 17000);
    const spread = gaussian() * (index % 9 === 0 ? 115 : 26);
    x = Math.cos(theta) * (r + spread);
    y = Math.sin(theta) * (r + spread);
    z = gaussian() * (10 + 19 * (1 - r / 1350));
  }
  // Deliberate demonstration locations, independent of the specification's tree.
  const examples = [
    [760, 430, 18],
    [-380, -255, 15],
    [135, 350, -12],
    [-650, 315, 25],
    [400, -360, 22],
    [-200, -540, 8],
  ];
  if (index < examples.length) [x, y, z] = examples[index];
  const r = Math.hypot(x, y);
  return {
    x: +x.toFixed(3),
    y: +y.toFixed(3),
    z: +z.toFixed(3),
    warmth: Math.max(0, Math.min(1, 1 - r / 420)),
    size: index < 6 ? 6.5 : 1.4 + Math.pow(rand(), 6) * 5.5,
  };
}

/** Only called by the copied demo server, before it accepts requests. */
export function prepareGalaxyDemo(store: Store) {
  store.catalogue = catalogue(GALAXY_COUNT - 6);
  const indexed = new Map(store.catalogue.map((s) => [s.id, s]));
  const originalStar = store.star.bind(store);
  store.star = (id) => indexed.get(id) || originalStar(id);
  // The known names are identifiers; all signals remain explicitly synthetic.
  const first = store.catalogue[0];
  first.signals = [0, 1, 2].map((j) => ({
    ...structuredClone(first.signals[0]),
    id: first.id + ":s" + (j + 1),
    period: 3.6 + j * 4.7,
    epoch: 1500.8 + j,
  }));
  store.addUser("seojin", "서진");
  const user = store.user("seojin");
  user.member.firstVisit = false;
  if (Object.keys(user.stars).length < GALAXY_COUNT) {
    if (!Object.keys(user.stars[first.id].matches).length) {
      for (let j = 0; j < 2; j++) {
        const s = first.signals[j];
        const center = ((((s.epoch - 1500) / s.period) % 1) + 1) % 1;
        store.submit("seojin", {
          starId: first.id,
          period: s.period,
          phaseStart: center - s.duration / s.period / 2,
          phaseEnd: center + s.duration / s.period / 2,
          judgment: correct(s),
          evidence: ["홀짝 깊이"],
          memo: "은하 화면을 위한 합성 시연 기록",
          requestId: "galaxy-intro-" + j,
        });
      }
    }
    store.catalogue.forEach((s, i) => {
      const tutorial = TUTORIALS.some((t) => t.id === s.id);
      const source = tutorial
        ? "tutorial"
        : s.id === store.state.challengeId
          ? "challenge"
          : "achievement";
      const n = store.unlock("seojin", s.id, source, null, null);
      const p = galaxyPosition(i);
      n.x = p.x;
      n.y = p.y;
      n.angle = Math.atan2(p.y, p.x);
    });
  }
}

const cache = new WeakMap<Store, Map<string, GalaxyData>>();
export function galaxyData(store: Store, uid: string): GalaxyData {
  let users = cache.get(store);
  if (!users) {
    users = new Map();
    cache.set(store, users);
  }
  const cached = users.get(uid);
  if (cached?.revision === store.state.version) return cached;
  const positions = new Map(store.catalogue.map((s, i) => [s.id, i]));
  const stars: GalaxyStar[] = Object.keys(store.user(uid).stars).map((id) => {
    const s = store.dto(uid, id);
    return {
      id,
      ...galaxyPosition(positions.get(id) || 0),
      planetCount: s.planetCount,
      status: s.status,
      tutorial: s.tutorial,
      challenge: s.challenge,
    };
  });
  const result: GalaxyData = {
    mode: "galaxy-demo",
    count: stars.length,
    revision: store.state.version,
    stars,
  };
  users.set(uid, result);
  return result;
}
