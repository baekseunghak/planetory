export type Box = { x: number; y: number; w: number; h: number };
export type Cluster = {
  nodeId: string;
  x: number;
  y: number;
  count: number;
  counts: { planet: number; done: number; new: number };
  bounds: Box;
};
export type Star = {
  ticId: string;
  x: number;
  y: number;
  depthZ: number;
  planetCount: number;
  colorLevel: number;
  sizeLevel: number;
  progressStage: "unexplored" | "in_progress" | "completed";
  completedWithoutPlanets: boolean;
  marker: null | { type: "tutorial"; seq: number } | { type: "challenge" };
  reopened: boolean;
  orbits: {
    candidateId: string;
    periodDays: number;
    kind: "confirmed" | "unconfirmed";
  }[];
};
export type SkyMeta = {
  version: string;
  starCount: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileSize: number;
  zoomLevels: { level: number; scale: number; clustered: boolean }[];
  centerTicIds: string[];
  overview: Cluster[];
  firstVisit: boolean;
  asOf?: string;
};
export type SkyTiles = {
  version: string;
  level: number;
  versionChanged: boolean;
  bounds: Box;
  stars: Star[];
  clusters: Cluster[];
  asOf?: string;
};
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
function boolean(v: unknown): boolean {
  return typeof v === "boolean" ? v : fail("불리언 값이 필요합니다.");
}
function array<T>(v: unknown, read: (v: unknown) => T): T[] {
  return Array.isArray(v) ? v.map(read) : fail("배열이 필요합니다.");
}
export function asOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = text(v);
  return /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s))
    ? s
    : fail("asOf UTC 시각이 필요합니다.");
}
export function readBox(value: unknown): Box {
  const v = object(value);
  const b = { x: number(v.x), y: number(v.y), w: number(v.w), h: number(v.h) };
  return b.w > 0 &&
    b.h > 0 &&
    Number.isFinite(b.x + b.w) &&
    Number.isFinite(b.y + b.h)
    ? b
    : fail("경계 상자의 폭/높이를 확인해 주세요.");
}
function unique<T>(values: T[], key: (item: T) => string) {
  if (new Set(values.map(key)).size !== values.length)
    fail("응답 안에 중복 ID가 있습니다.");
  return values;
}
function readCluster(value: unknown): Cluster {
  const v = object(value),
    c = object(v.counts);
  const counts = {
      planet: integer(c.planet),
      done: integer(c.done),
      new: integer(c.new),
    },
    count = integer(v.count);
  if (count !== counts.planet + counts.done + counts.new || count === 0)
    fail("군집 집계가 일치하지 않습니다.");
  return {
    nodeId: text(v.nodeId),
    x: number(v.x),
    y: number(v.y),
    count,
    counts,
    bounds: readBox(v.bounds),
  };
}
function readStar(value: unknown): Star {
  const v = object(value),
    depthZ = number(v.depthZ),
    planetCount = integer(v.planetCount),
    colorLevel = integer(v.colorLevel);
  if (Math.abs(depthZ) > 1 || colorLevel > 4)
    fail("깊이/색 단계 범위를 벗어났습니다.");
  const progressStage = text(v.progressStage);
  if (!["unexplored", "in_progress", "completed"].includes(progressStage))
    fail("진행 상태를 확인해 주세요.");
  let marker: Star["marker"] = null;
  if (v.marker !== null) {
    const m = object(v.marker);
    if (m.type === "challenge") marker = { type: "challenge" };
    else if (m.type === "tutorial" && integer(m.seq) > 0)
      marker = { type: "tutorial", seq: integer(m.seq) };
    else fail("마커 형식을 확인해 주세요.");
  }
  const orbits = unique(
    array(v.orbits, (item) => {
      const o = object(item),
        kind = text(o.kind),
        periodDays = number(o.periodDays);
      if (!["confirmed", "unconfirmed"].includes(kind) || periodDays <= 0)
        fail("공전 자료를 확인해 주세요.");
      return {
        candidateId: text(o.candidateId),
        periodDays,
        kind: kind as "confirmed" | "unconfirmed",
      };
    }),
    (o) => o.candidateId,
  );
  const completedWithoutPlanets = boolean(v.completedWithoutPlanets);
  if (
    orbits.length !== planetCount ||
    completedWithoutPlanets !==
      (progressStage === "completed" && planetCount === 0)
  )
    fail("행성 수/완료 상태가 일치하지 않습니다.");
  return {
    ticId: text(v.ticId),
    x: number(v.x),
    y: number(v.y),
    depthZ,
    planetCount,
    colorLevel,
    sizeLevel: integer(v.sizeLevel),
    progressStage: progressStage as Star["progressStage"],
    completedWithoutPlanets,
    marker,
    reopened: boolean(v.reopened),
    orbits,
  };
}
export function readSkyMeta(value: unknown): SkyMeta {
  const v = object(value),
    b = object(v.bounds),
    tileSize = number(v.tileSize);
  const bounds = {
    minX: number(b.minX),
    maxX: number(b.maxX),
    minY: number(b.minY),
    maxY: number(b.maxY),
  };
  if (tileSize <= 0 || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY)
    fail("지도 범위를 확인해 주세요.");
  const zoomLevels = array(v.zoomLevels, (item) => {
    const z = object(item);
    return {
      level: integer(z.level),
      scale: number(z.scale),
      clustered: boolean(z.clustered),
    };
  });
  if (
    zoomLevels.length < 5 ||
    zoomLevels.some(
      (z, i) =>
        z.level !== i ||
        z.scale <= 0 ||
        (i > 0 && z.scale <= zoomLevels[i - 1].scale),
    )
  )
    fail("연속된 5단계 이상의 배율 자료가 필요합니다.");
  return {
    version: text(v.version),
    starCount: integer(v.starCount),
    bounds,
    tileSize,
    zoomLevels,
    centerTicIds: unique(array(v.centerTicIds, text), (v) => v),
    overview: unique(array(v.overview, readCluster), (c) => c.nodeId),
    firstVisit: boolean(v.firstVisit),
    asOf: asOf(v.asOf),
  };
}
export function readSkyTiles(value: unknown): SkyTiles {
  const v = object(value);
  return {
    version: text(v.version),
    level: integer(v.level),
    versionChanged: boolean(v.versionChanged),
    bounds: readBox(v.bounds),
    stars: unique(array(v.stars, readStar), (s) => s.ticId),
    clusters: unique(array(v.clusters, readCluster), (c) => c.nodeId),
    asOf: asOf(v.asOf),
  };
}
