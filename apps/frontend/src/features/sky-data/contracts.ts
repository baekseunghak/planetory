export const LAYOUT_VERSION = "personal-spiral-v1";
export const PRESENTATION_VERSION = "personal-galaxy-v1";
export const DEPTH_SCALE = 256;
export type Box = { x: number; y: number; w: number; h: number };
export type Star = {
  ticId: string;
  x: number;
  y: number;
  depthZ: number;
  layoutOrdinal: number;
  planetCount: number;
  progressStage: "unexplored" | "in_progress" | "completed";
  completedWithoutPlanets: boolean;
  marker: null | { type: "tutorial"; seq: number } | { type: "challenge" };
  reopened: boolean;
};
export type SkyMeta = {
  representation: "individual-stars";
  layoutVersion: typeof LAYOUT_VERSION;
  presentationVersion: typeof PRESENTATION_VERSION;
  version: string;
  starCount: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileSize: number;
  zoomLevels: { level: number; scale: number }[];
  centerTicIds: string[];
  firstVisit: boolean;
  asOf?: string;
};
type PageBase = {
  representation: "individual-stars";
  version: string;
  level: number;
  stars: Star[];
  nextCursor: string | null;
  asOf?: string;
};
export type SkyPage = PageBase & {
  versionChanged: false;
  bounds: Box;
  rangeStarCount: number;
};
export type SkyTiles = SkyPage | (PageBase & { versionChanged: true });
export class SkyContractError extends Error {
  constructor(detail: string) {
    super(`별지도 응답 형식을 확인해 주세요: ${detail}`);
    this.name = "SkyContractError";
  }
}
function fail(detail: string): never {
  throw new SkyContractError(detail);
}
function object(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail("객체가 필요합니다.");
}
function text(v: unknown): string {
  return typeof v === "string" && v.length > 0
    ? v
    : fail("문자열 ID/버전이 필요합니다.");
}
function number(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v)
    ? v
    : fail("유한한 수가 필요합니다.");
}
function integer(v: unknown): number {
  const n = number(v);
  return Number.isSafeInteger(n) && n >= 0
    ? n
    : fail("음수가 아닌 정수가 필요합니다.");
}
function ordinal(v: unknown) {
  const n = integer(v);
  return n <= 2147483647 ? n : fail("layoutOrdinal 범위를 벗어났습니다.");
}
function boolean(v: unknown): boolean {
  return typeof v === "boolean" ? v : fail("불리언 값이 필요합니다.");
}
function array<T>(v: unknown, read: (v: unknown) => T): T[] {
  return Array.isArray(v) ? v.map(read) : fail("배열이 필요합니다.");
}
function tic(v: unknown) {
  const s = text(v);
  return /^\d+$/.test(s) ? s : fail("TIC는 숫자로 된 문자열이어야 합니다.");
}
export function compareTic(a: string, b: string) {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
function forbid(v: Record<string, unknown>, keys: string[]) {
  if (keys.some((k) => k in v)) fail("구 군집/연출 응답은 사용할 수 없습니다.");
}
function representation(v: Record<string, unknown>): "individual-stars" {
  if (v.representation !== "individual-stars")
    fail("individual-stars 응답이 필요합니다.");
  forbid(v, ["clusters", "overview", "clustered", "nodeId", "counts"]);
  return "individual-stars";
}
export function asOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = text(v);
  return /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s))
    ? s
    : fail("asOf UTC 시각이 필요합니다.");
}
export function readBox(value: unknown): Box {
  const v = object(value),
    b = { x: number(v.x), y: number(v.y), w: number(v.w), h: number(v.h) };
  return b.w > 0 &&
    b.h > 0 &&
    Number.isFinite(b.x + b.w) &&
    Number.isFinite(b.y + b.h)
    ? b
    : fail("경계 상자의 폭/높이를 확인해 주세요.");
}
function unique<T>(values: T[], key: (item: T) => string | number) {
  if (new Set(values.map(key)).size !== values.length)
    fail("응답 안에 중복 ID/순번이 있습니다.");
  return values;
}
function readStar(value: unknown): Star {
  const v = object(value);
  forbid(v, ["colorLevel", "sizeLevel", "orbits", "nodeId", "counts"]);
  const depthZ = number(v.depthZ),
    planetCount = integer(v.planetCount),
    progressStage = text(v.progressStage);
  if (Math.abs(depthZ) > 1) fail("정규화 깊이 범위를 벗어났습니다.");
  if (!["unexplored", "in_progress", "completed"].includes(progressStage))
    fail("진행 상태를 확인해 주세요.");
  let marker: Star["marker"] = null;
  if (v.marker !== null) {
    const m = object(v.marker);
    if (m.type === "challenge") marker = { type: "challenge" };
    else if (m.type === "tutorial" && integer(m.seq) > 0 && integer(m.seq) <= 5)
      marker = { type: "tutorial", seq: integer(m.seq) };
    else fail("마커 형식을 확인해 주세요.");
  }
  const completedWithoutPlanets = boolean(v.completedWithoutPlanets);
  if (
    completedWithoutPlanets !==
    (progressStage === "completed" && planetCount === 0)
  )
    fail("행성 수/완료 상태가 일치하지 않습니다.");
  return {
    ticId: tic(v.ticId),
    x: number(v.x),
    y: number(v.y),
    depthZ,
    layoutOrdinal: ordinal(v.layoutOrdinal),
    planetCount,
    progressStage: progressStage as Star["progressStage"],
    completedWithoutPlanets,
    marker,
    reopened: boolean(v.reopened),
  };
}
export function readSkyMeta(value: unknown): SkyMeta {
  const v = object(value),
    rep = representation(v),
    b = object(v.bounds),
    tileSize = number(v.tileSize);
  if (
    v.layoutVersion !== LAYOUT_VERSION ||
    v.presentationVersion !== PRESENTATION_VERSION
  )
    fail("지원하지 않는 배치/표현 버전입니다.");
  const bounds = {
    minX: number(b.minX),
    maxX: number(b.maxX),
    minY: number(b.minY),
    maxY: number(b.maxY),
  };
  if (
    tileSize <= 0 ||
    !Number.isFinite(tileSize * 64) ||
    bounds.maxX < bounds.minX ||
    bounds.maxY < bounds.minY
  )
    fail("지도 범위를 확인해 주세요.");
  const zoomLevels = array(v.zoomLevels, (item) => {
    const z = object(item);
    forbid(z, ["clustered"]);
    return { level: integer(z.level), scale: number(z.scale) };
  });
  if (
    !zoomLevels.length ||
    zoomLevels.some(
      (z, i) =>
        z.level !== i ||
        z.scale <= 0 ||
        (i > 0 && z.scale <= zoomLevels[i - 1].scale),
    )
  )
    fail("연속된 1단계 이상의 배율 자료가 필요합니다.");
  return {
    representation: rep,
    layoutVersion: LAYOUT_VERSION,
    presentationVersion: PRESENTATION_VERSION,
    version: text(v.version),
    starCount: integer(v.starCount),
    bounds,
    tileSize,
    zoomLevels,
    centerTicIds: unique(array(v.centerTicIds, tic), (s) => s),
    firstVisit: boolean(v.firstVisit),
    asOf: asOf(v.asOf),
  };
}
export function readSkyTiles(value: unknown): SkyTiles {
  const v = object(value),
    rep = representation(v),
    versionChanged = boolean(v.versionChanged);
  const stars = unique(
    unique(array(v.stars, readStar), (s) => s.ticId),
    (s) => s.layoutOrdinal,
  );
  const nextCursor = v.nextCursor === null ? null : text(v.nextCursor);
  const base = {
    representation: rep,
    version: text(v.version),
    level: integer(v.level),
    stars,
    nextCursor,
    asOf: asOf(v.asOf),
  };
  if (versionChanged) {
    if (stars.length || nextCursor !== null)
      fail("버전 변경 응답에 이전 페이지 자료가 있습니다.");
    return { ...base, versionChanged: true };
  }
  const bounds = readBox(v.bounds),
    rangeStarCount = integer(v.rangeStarCount);
  if (
    stars.length > rangeStarCount ||
    stars.some(
      (s, i) =>
        s.x < bounds.x ||
        s.x >= bounds.x + bounds.w ||
        s.y < bounds.y ||
        s.y >= bounds.y + bounds.h ||
        (i > 0 && compareTic(stars[i - 1].ticId, s.ticId) >= 0),
    )
  )
    fail("페이지 좌표/개수/TIC 정렬이 올바르지 않습니다.");
  return { ...base, versionChanged: false, bounds, rangeStarCount };
}

// W07 owns HTTP loading and the full panel DTO; this checks its shared map/planet fields.
export type PersonalDetailProjection = {
  ticId: string;
  version: string;
  presentationVersion: typeof PRESENTATION_VERSION;
  position: Pick<Star, "x" | "y" | "depthZ" | "layoutOrdinal"> & {
    layoutVersion: typeof LAYOUT_VERSION;
  };
  planets: {
    count: number;
    items: {
      candidateId: string;
      kind: "confirmed" | "unconfirmed";
      periodDays: number | null;
      depthPpm: number | null;
    }[];
  };
};
export function readPersonalDetailProjection(
  value: unknown,
  meta: SkyMeta,
  expectedTicId: string,
  loadedStar?: Star,
): PersonalDetailProjection {
  const v = object(value),
    p = object(object(v.unlock).position),
    planets = object(v.planets);
  const position: PersonalDetailProjection["position"] = {
    x: number(p.x),
    y: number(p.y),
    depthZ: number(p.depthZ),
    layoutOrdinal: ordinal(p.layoutOrdinal),
    layoutVersion: LAYOUT_VERSION,
  };
  if (
    tic(v.ticId) !== expectedTicId ||
    v.version !== meta.version ||
    v.presentationVersion !== meta.presentationVersion ||
    p.layoutVersion !== meta.layoutVersion ||
    Math.abs(position.depthZ) > 1
  )
    fail("상세의 별/버전/좌표가 지도와 다릅니다.");
  const nullable = (n: unknown, positive: boolean) => {
    if (n === null) return null;
    const x = number(n);
    if (positive ? x <= 0 : x < 0) fail("행성 수치 범위를 확인해 주세요.");
    return x;
  };
  const items = unique(
    array(planets.items, (item) => {
      const q = object(item);
      if (q.kind !== "confirmed" && q.kind !== "unconfirmed")
        fail("표시할 수 없는 행성 종류입니다.");
      return {
        candidateId: text(q.candidateId),
        kind: q.kind as "confirmed" | "unconfirmed",
        periodDays: nullable(q.periodDays, true),
        depthPpm: nullable(q.depthPpm, false),
      };
    }),
    (q) => q.candidateId,
  );
  const count = integer(planets.count);
  if (
    count !== items.length ||
    items.some((q, i) => i > 0 && items[i - 1].candidateId >= q.candidateId)
  )
    fail("행성 개수/정렬이 일치하지 않습니다.");
  if (
    loadedStar &&
    (loadedStar.ticId !== expectedTicId ||
      loadedStar.planetCount !== count ||
      (["x", "y", "depthZ", "layoutOrdinal"] as const).some(
        (k) => loadedStar[k] !== position[k],
      ))
  )
    fail("같은 버전의 지도와 상세 자료가 다릅니다.");
  return {
    ticId: expectedTicId,
    version: meta.version,
    presentationVersion: PRESENTATION_VERSION,
    position,
    planets: { count, items },
  };
}
