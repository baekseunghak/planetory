import {
  readBox,
  DEPTH_SCALE,
  SkyContractError,
  type Box,
  type SkyMeta,
} from "./contracts.ts";
// Matrices use WebGL column-major order; z is the API's normalized depthZ.
export type Matrix = readonly number[];
export type Point = { x: number; y: number; z: number };
export function transform(m: Matrix, p: Point): Point {
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12)
    throw new SkyContractError("카메라 투영이 유효하지 않습니다.");
  return {
    x: (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w,
    y: (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w,
    z: (m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]) / w,
  };
}
export function inverse(matrix: Matrix): Matrix {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite))
    throw new SkyContractError("카메라 행렬을 확인해 주세요.");
  const a = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 8 }, (_, c) =>
      c < 4 ? matrix[c * 4 + r] : Number(c - 4 === r),
    ),
  );
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++)
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12)
      throw new SkyContractError("역투영할 수 없는 카메라입니다.");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let c = 0; c < 8; c++) a[col][c] /= d;
    for (let r = 0; r < 4; r++)
      if (r !== col) {
        const factor = a[r][col];
        for (let c = 0; c < 8; c++) a[r][c] -= factor * a[col][c];
      }
  }
  return Array.from({ length: 16 }, (_, i) => a[i % 4][4 + Math.floor(i / 4)]);
}
// Clip the inverse-projected frustum to the full depth slab, not just its z=0 plane.
// 20% on each screen edge is an explicit conservative interpretation of the margin.
export function viewportBounds(worldToClip: Matrix, margin = 0.2): Box | null {
  if (!Number.isFinite(margin) || margin < 0)
    throw new SkyContractError("뷰포트 여백을 확인해 주세요.");
  const inv = inverse(worldToClip),
    edge = 1 + 2 * margin;
  const vertices = Array.from({ length: 8 }, (_, i) =>
    transform(inv, {
      x: i & 1 ? edge : -edge,
      y: i & 2 ? edge : -edge,
      z: i & 4 ? 1 : -1,
    }),
  );
  const points = vertices.filter((p) => p.z >= -1 && p.z <= 1);
  for (let i = 0; i < 8; i++)
    for (const bit of [1, 2, 4])
      if (!(i & bit)) {
        const a = vertices[i],
          b = vertices[i | bit];
        for (const z of [-1, 1]) {
          const t = (z - a.z) / (b.z - a.z);
          if (Number.isFinite(t) && t >= 0 && t <= 1)
            points.push({
              x: a.x + t * (b.x - a.x),
              y: a.y + t * (b.y - a.y),
              z,
            });
        }
      }
  if (!points.length) return null;
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    x = Math.min(...xs),
    y = Math.min(...ys),
    w = Math.max(...xs) - x,
    h = Math.max(...ys) - y;
  return w > 0 && h > 0 ? readBox({ x, y, w, h }) : null;
}
export function intersects(a: Box, b: Box) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}
export type Cell = { col: number; row: number; box: Box };
export function visibleCells(box: Box | null, meta: SkyMeta): Cell[] {
  if (!box) return [];
  readBox(box);
  const s = meta.tileSize,
    b = meta.bounds;
  // Metadata bounds can be a single point. Include the grid cell containing maxX/maxY.
  const x0 = Math.max(Math.floor(box.x / s), Math.floor(b.minX / s)),
    x1 = Math.min(Math.ceil((box.x + box.w) / s) - 1, Math.floor(b.maxX / s));
  const y0 = Math.max(Math.floor(box.y / s), Math.floor(b.minY / s)),
    y1 = Math.min(Math.ceil((box.y + box.h) / s) - 1, Math.floor(b.maxY / s));
  if (x1 < x0 || y1 < y0) return [];
  if (
    ![x0, x1, y0, y1].every(Number.isSafeInteger) ||
    (x1 - x0 + 1) * (y1 - y0 + 1) > 65536
  )
    throw new SkyContractError(
      "표시 범위가 너무 넓습니다. 확대 후 다시 확인해 주세요.",
    );
  const out: Cell[] = [];
  for (let row = y0; row <= y1; row++)
    for (let col = x0; col <= x1; col++)
      out.push({ col, row, box: { x: col * s, y: row * s, w: s, h: s } });
  return out;
}
export const cellId = (cell: Cell) => `${cell.col}:${cell.row}`;
export function cacheKey(
  memberId: string,
  version: string,
  level: number,
  cell: Cell,
) {
  return JSON.stringify([memberId, version, level, cell.col, cell.row]);
}
// Network batching preference, not an API limit. Each rectangle may cover up to 64x64 tiles.
export function requestGroups(
  cells: Cell[],
  span = 8,
): { box: Box; cells: Cell[] }[] {
  if (!Number.isInteger(span) || span < 1 || span > 64)
    throw new SkyContractError("요청 묶음 크기를 확인해 주세요.");
  const groups: { box: Box; cells: Cell[] }[] = [];
  for (const cell of cells) {
    const prior = groups.at(-1);
    if (
      prior &&
      prior.box.y === cell.box.y &&
      prior.box.x + prior.box.w === cell.box.x &&
      prior.cells.length < span
    ) {
      prior.box.w += cell.box.w;
      prior.cells.push(cell);
    } else groups.push({ box: { ...cell.box }, cells: [cell] });
  }
  const merged: typeof groups = [];
  for (const run of groups) {
    const prior = merged.find(
      (g) =>
        g.box.x === run.box.x &&
        g.box.w === run.box.w &&
        g.box.y + g.box.h === run.box.y &&
        g.box.h / run.cells[0].box.h < span,
    );
    if (prior) {
      prior.box.h += run.box.h;
      prior.cells.push(...run.cells);
    } else merged.push(run);
  }
  return merged;
}
export function tileQuery(
  level: number,
  box: Box,
  meta: SkyMeta,
  limit = 1000,
  cursor: string | null = null,
) {
  readBox(box);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000 ||
    cursor === "" ||
    !meta.zoomLevels.some((z) => z.level === level) ||
    box.w > meta.tileSize * 64 ||
    box.h > meta.tileSize * 64
  )
    throw new SkyContractError("요청 배율 또는 범위가 상한을 벗어났습니다.");
  return `/v1/me/sky/tiles?${new URLSearchParams({ level: String(level), x: String(box.x), y: String(box.y), w: String(box.w), h: String(box.h), version: meta.version, limit: String(limit), ...(cursor !== null ? { cursor } : {}) })}`;
}
export function levelForScale(meta: SkyMeta, scale: number) {
  return meta.zoomLevels.reduce(
    (best, z) => (z.scale <= scale ? z : best),
    meta.zoomLevels[0],
  ).level;
}

// Simple orthographic camera for the data adapter's verification page.
// W06 can supply its own perspective/orthographic matrix to the same viewportBounds API.
export function orthographicMatrix(
  c: { x: number; y: number; rotation: number; tilt: number; scale: number },
  width: number,
  height: number,
  depthHeight: number,
  clipDepth: number,
): Matrix {
  const cr = Math.cos(c.rotation),
    sr = Math.sin(c.rotation),
    ct = Math.cos(c.tilt),
    st = Math.sin(c.tilt),
    sx = (2 * c.scale) / width,
    sy = (-2 * c.scale) / height;
  return [
    sx * cr,
    sy * ct * sr,
    (st * sr) / clipDepth,
    0,
    -sx * sr,
    sy * ct * cr,
    (st * cr) / clipDepth,
    0,
    0,
    -sy * st * depthHeight,
    (ct * depthHeight) / clipDepth,
    0,
    sx * (-cr * c.x + sr * c.y),
    -sy * ct * (sr * c.x + cr * c.y),
    (-st * (sr * c.x + cr * c.y)) / clipDepth,
    1,
  ];
}

// Matrix input z remains normalized depthZ. This matrix alone restores the 256 world units.
export type GalaxyCamera = {
  x: number;
  y: number;
  zoom: number;
  yaw: number;
  tilt: number;
  roll: number;
};
export function galaxyMatrix(
  c: GalaxyCamera,
  width: number,
  height: number,
): Matrix {
  if (
    !Object.values(c).every(Number.isFinite) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    c.zoom < 0.001 ||
    c.zoom > 10000 ||
    Math.abs(c.tilt) > 1.42
  )
    throw new SkyContractError("은하 카메라 범위를 확인해 주세요.");
  const cy = Math.cos(c.yaw),
    sy = Math.sin(c.yaw),
    ct = Math.cos(c.tilt),
    st = Math.sin(c.tilt),
    cr = Math.cos(c.roll),
    sr = Math.sin(c.roll);
  const scale = Math.min(width / 3100, height / 2020) * c.zoom,
    sx = (2 * scale) / width,
    syClip = (-2 * scale) / height;
  return [
    sx * (cr * cy - sr * ct * sy),
    syClip * (sr * cy + cr * ct * sy),
    0,
    0,
    sx * (-cr * sy - sr * ct * cy),
    syClip * (-sr * sy + cr * ct * cy),
    0,
    0,
    sx * sr * st * DEPTH_SCALE,
    -syClip * cr * st * DEPTH_SCALE,
    1,
    0,
    -sx * c.x,
    0.08 - syClip * c.y,
    0,
    1,
  ];
}
export function visibleStarCount(
  stars: readonly { x: number; y: number; depthZ: number }[],
  matrix: Matrix,
) {
  return stars.reduce((n, s) => {
    const p = transform(matrix, { x: s.x, y: s.y, z: s.depthZ });
    return (
      n + Number(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1)
    );
  }, 0);
}
