/** Proposal-only, synthetic scene data. These coordinates are not RA/Dec. */
export interface GalaxyStar {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
  warmth: number;
  planetCount: number;
  status: "unexplored" | "in_progress" | "complete";
  tutorial: number | null;
  challenge: boolean;
}
export interface GalaxyData {
  count: number;
  revision: number;
  mode: "galaxy-demo";
  stars: GalaxyStar[];
}
export interface GalaxyCamera {
  x: number;
  y: number;
  zoom: number;
  yaw: number;
  tilt: number;
}
export const INITIAL_CAMERA: GalaxyCamera = {
  x: 0,
  y: 0,
  zoom: 1,
  yaw: 0.12,
  tilt: 1.0,
};
export const ROLL = -0.28;
// A finite range keeps GPU projection precise while spanning seven orders of magnitude.
export const MIN_ZOOM = 0.001;
export const MAX_ZOOM = 10_000;
export const DETAIL_ZOOM = 0.12;
const MAX_PAN = 1e12;
export const sceneCenterX = (width: number) =>
  width * (width < 1200 ? 0.39 : 0.46);
export function sceneScale(width: number, height: number, zoom: number) {
  return Math.min(width / 3100, height / 2020) * zoom;
}
export function project(
  p: { x: number; y: number; z: number },
  c: GalaxyCamera,
  w: number,
  h: number,
) {
  const a = p.x * Math.cos(c.yaw) - p.y * Math.sin(c.yaw);
  const b = p.x * Math.sin(c.yaw) + p.y * Math.cos(c.yaw);
  const v = b * Math.cos(c.tilt) - p.z * Math.sin(c.tilt);
  const depth = b * Math.sin(c.tilt) + p.z * Math.cos(c.tilt);
  const u = a * Math.cos(ROLL) - v * Math.sin(ROLL);
  const t = a * Math.sin(ROLL) + v * Math.cos(ROLL);
  const scale = sceneScale(w, h, c.zoom);
  return {
    x: (u - c.x) * scale + sceneCenterX(w),
    y: (t - c.y) * scale + h * 0.46,
    depth,
  };
}
export function readCamera(value: unknown): GalaxyCamera {
  if (!value || typeof value !== "object") return { ...INITIAL_CAMERA };
  const v = value as Record<string, unknown>;
  if (
    !["x", "y", "zoom", "yaw", "tilt"].every(
      (k) => typeof v[k] === "number" && Number.isFinite(v[k]),
    )
  )
    return { ...INITIAL_CAMERA };
  return {
    x: Math.max(-MAX_PAN, Math.min(MAX_PAN, v.x as number)),
    y: Math.max(-MAX_PAN, Math.min(MAX_PAN, v.y as number)),
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom as number)),
    yaw: (v.yaw as number) % (Math.PI * 2),
    tilt: Math.max(-1.42, Math.min(1.42, v.tilt as number)),
  };
}
/** Preserve the world point under the pointer, including when a limit is reached. */
export function zoomCamera(
  camera: GalaxyCamera,
  factor: number,
  width: number,
  height: number,
  px = sceneCenterX(width),
  py = height * 0.46,
): GalaxyCamera {
  if (
    ![factor, width, height, px, py].every(Number.isFinite) ||
    factor <= 0 ||
    width <= 0 ||
    height <= 0
  )
    return camera;
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  if (zoom === camera.zoom) return camera;
  const before = sceneScale(width, height, camera.zoom);
  const after = sceneScale(width, height, zoom);
  return readCamera({
    ...camera,
    zoom,
    x: camera.x + (px - sceneCenterX(width)) * (1 / before - 1 / after),
    y: camera.y + (py - height * 0.46) * (1 / before - 1 / after),
  });
}
export function zoomLabel(zoom: number) {
  return zoom >= 10
    ? zoom.toLocaleString("en-US", { maximumFractionDigits: 1 }) + "×"
    : (zoom * 100).toFixed(1) + "%";
}
export function readGalaxyData(value: unknown): GalaxyData {
  if (!value || typeof value !== "object")
    throw new Error("은하 데이터를 읽을 수 없습니다.");
  const d = value as GalaxyData;
  if (
    d.mode !== "galaxy-demo" ||
    !Array.isArray(d.stars) ||
    d.count !== d.stars.length ||
    !Number.isFinite(d.revision)
  )
    throw new Error("은하 데이터 형식이 올바르지 않습니다.");
  const ids = new Set<string>();
  for (const s of d.stars) {
    if (
      !s ||
      typeof s.id !== "string" ||
      ids.has(s.id) ||
      ![s.x, s.y, s.z, s.size, s.warmth, s.planetCount].every(
        Number.isFinite,
      ) ||
      s.size <= 0 ||
      s.planetCount < 0 ||
      !["unexplored", "in_progress", "complete"].includes(s.status)
    )
      throw new Error("별 데이터를 읽을 수 없습니다.");
    ids.add(s.id);
  }
  return d;
}
