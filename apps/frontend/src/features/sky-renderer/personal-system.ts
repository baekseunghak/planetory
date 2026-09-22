export interface PersonalPlanet {
  id: string;
  label: string;
  candidate: boolean;
  period: number;
  seed: number;
}
export interface SystemView {
  body: string;
  zoom: number;
  yaw: number;
  tilt: number;
}
export const INITIAL_SYSTEM: SystemView = {
  body: "system",
  zoom: 1,
  yaw: -0.28,
  tilt: 0.67,
};
export interface FocusRequest {
  id: string;
  planets: PersonalPlanet[];
  view: SystemView;
}
export interface BodyPoint {
  id: string;
  x: number;
  y: number;
  radius: number;
  depth: number;
  seed: number;
  star: boolean;
  candidate: boolean;
}
export const ease = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export function signalSeed(id: string) {
  let seed = 2166136261;
  for (const c of id) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
  return ((seed >>> 0) % 10000) / 10000;
}
export function focusCenter(w: number, h: number) {
  return {
    x: w < 768 ? w * 0.5 : Math.max(w * 0.65, 350 + (w - 350) / 2),
    y: w < 768 ? Math.max(225, (h - 170) * 0.5) : h * 0.46,
  };
}
export function systemGeometry(
  planets: PersonalPlanet[],
  view: SystemView,
  w: number,
  h: number,
  center: { x: number; y: number },
  entry: number,
  bodyBlend: number,
  orbitSeconds = 0,
) {
  const maxOrbit = 180 + Math.max(0, planets.length - 1) * 85;
  const fit =
    Math.min(
      w < 768 ? w * 0.44 : (w - 350) * 0.46,
      w < 768 ? Math.max(110, (h - 380) * 0.43) : h * 0.43,
    ) / Math.max(220, maxOrbit);
  const cy = Math.cos(view.yaw),
    sy = Math.sin(view.yaw),
    ct = Math.cos(view.tilt),
    st = Math.sin(view.tilt);
  const rotate = (x: number, y: number) => ({
    x: x * cy - y * sy,
    y: (x * sy + y * cy) * ct,
    z: (x * sy + y * cy) * st,
  });
  const local = planets.map((p, i) => {
    const r = 180 + i * 85,
      phase =
        0.75 +
        i * 2.13 +
        p.seed * 0.7 +
        (orbitSeconds * 0.32) / Math.sqrt(Math.max(0.4, p.period));
    return {
      ...rotate(Math.cos(phase) * r, Math.sin(phase) * r),
      radius: 18 + p.seed * 9,
      planet: p,
    };
  });
  const chosen = local.find((p) => p.planet.id === view.body);
  const isStar = view.body === "star" || !planets.length;
  const selectedRadius = chosen?.radius ?? 56;
  const closeRadius = Math.min(
    w < 768 ? w * 0.37 : (w - 360) * 0.43,
    w < 768 ? Math.max(95, (h - 390) * 0.5) : h * 0.43,
  );
  const blend = isStar ? 1 : chosen ? bodyBlend : 0;
  const scale =
    mix(fit, closeRadius / selectedRadius, blend) * view.zoom * entry;
  const tx = (chosen?.x ?? 0) * blend,
    ty = (chosen?.y ?? 0) * blend;
  const point = (x: number, y: number) => ({
    x: center.x + (x - tx) * scale,
    y: center.y + (y - ty) * scale,
  });
  const bodies: BodyPoint[] = [
    {
      id: "star",
      ...point(0, 0),
      radius: Math.max(1, 56 * scale),
      depth: 0,
      seed: 0.4,
      star: true,
      candidate: false,
    },
    ...local.map((p) => ({
      id: p.planet.id,
      ...point(p.x, p.y),
      radius: Math.max(1, p.radius * scale),
      depth: p.z,
      seed: p.planet.seed,
      star: false,
      candidate: p.planet.candidate,
    })),
  ];
  const lines: number[] = [];
  if (blend < 0.98)
    for (let i = 0; i < planets.length; i++) {
      const r = 180 + i * 85;
      for (let j = 0; j < 128; j++) {
        if (planets[i].candidate && j % 4 >= 2) continue;
        for (const k of [j, j + 1]) {
          const a = (k / 128) * Math.PI * 2,
            p = rotate(Math.cos(a) * r, Math.sin(a) * r),
            q = point(p.x, p.y);
          lines.push(q.x, q.y);
        }
      }
    }
  return {
    bodies: bodies.sort((a, b) => b.depth - a.depth),
    lines,
    orbitOpacity: 1 - blend,
  };
}
