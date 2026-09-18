import type { Star } from "../sky-data/contracts.ts";
import { SkyContractError } from "../sky-data/contracts.ts";
import {
  screenPoint,
  starStyle,
  type GalaxyCamera,
  type OwnedPlanet,
  type OwnedSystem,
} from "./model.ts";
import type { Matrix } from "../sky-data/geometry.ts";

export type HitTarget = {
  id: string;
  kind: "star" | "planet";
  x: number;
  y: number;
  radius: number;
  label: string;
  star?: Star;
  planet?: OwnedPlanet;
  systemTicId?: string;
};
export const CELL_SIZE = 64;
// A screen index contains only visible individual bodies, never glow/cloud/cluster regions.
export class HitGrid {
  private cells = new Map<string, HitTarget[]>();
  readonly targets: HitTarget[];
  readonly byId: Map<string, HitTarget>;
  examined = 0;
  constructor(targets: HitTarget[]) {
    this.targets = targets;
    this.byId = new Map(targets.map((t) => [t.id, t]));
    for (const t of targets)
      for (
        let y = Math.floor((t.y - t.radius) / CELL_SIZE);
        y <= Math.floor((t.y + t.radius) / CELL_SIZE);
        y++
      )
        for (
          let x = Math.floor((t.x - t.radius) / CELL_SIZE);
          x <= Math.floor((t.x + t.radius) / CELL_SIZE);
          x++
        ) {
          const key = `${x}:${y}`;
          const list = this.cells.get(key) ?? [];
          list.push(t);
          this.cells.set(key, list);
        }
  }
  hit(x: number, y: number) {
    const candidates =
      this.cells.get(
        `${Math.floor(x / CELL_SIZE)}:${Math.floor(y / CELL_SIZE)}`,
      ) ?? [];
    this.examined = candidates.length;
    let result: HitTarget | null = null,
      distance = Infinity;
    for (const t of candidates) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (
        d <= t.radius &&
        (d < distance || (d === distance && t.id < (result?.id ?? "")))
      ) {
        result = t;
        distance = d;
      }
    }
    return result;
  }
}
const progress = {
  unexplored: "미탐사",
  in_progress: "탐색 중",
  completed: "탐색 완료",
};
export function starLabel(s: Star) {
  return `TIC ${s.ticId} · 내 행성 ${s.planetCount}개 · ${progress[s.progressStage]}${s.completedWithoutPlanets ? " · 표시할 내 행성 없이 완료" : ""}`;
}
export function starTargets(
  stars: readonly Star[],
  matrix: Matrix,
  width: number,
  height: number,
  zoom: number,
  selected: string | null,
  system: OwnedSystem | null,
  dpr = 1,
): HitTarget[] {
  const sizeScale = zoom < 1 ? zoom ** 0.78 : zoom ** 0.36;
  return stars.flatMap((s) => {
    const p = screenPoint(matrix, width, height, s.x, s.y, s.depthZ);
    if (
      Math.abs(p.depth) > 1 ||
      // Match renderPlan's padded viewport: a badge or sprite can still be
      // visible after its centre leaves the canvas. The scene clips overflow.
      p.x < -80 ||
      p.y < -80 ||
      p.x > width + 80 ||
      p.y > height + 80
    )
      return [];
    const special = s.ticId === selected;
    const radius =
      s.ticId === system?.ticId
        ? 96
        : special
          ? 24
          : starStyle(s).baseSize * 1.35;
    const fit = special
      ? 1
      : Math.max(0.55, Math.min(width / 1680, height / 974));
    return [
      {
        id: s.ticId,
        kind: "star" as const,
        x: p.x,
        y: p.y,
        radius: Math.max(
          8,
          Math.min(160, radius * fit * dpr * sizeScale) / dpr / 2,
        ),
        label: starLabel(s),
        star: s,
      },
    ];
  });
}
export function panCamera(
  c: GalaxyCamera,
  dx: number,
  dy: number,
  width: number,
  height: number,
): GalaxyCamera {
  const scale = Math.min(width / 3100, height / 2020) * c.zoom;
  return { ...c, x: c.x - dx / scale, y: c.y - dy / scale };
}
export function zoomCamera(
  c: GalaxyCamera,
  factor: number,
  px: number,
  py: number,
  width: number,
  height: number,
): GalaxyCamera {
  const zoom = Math.max(0.001, Math.min(10000, c.zoom * factor));
  const base = Math.min(width / 3100, height / 2020);
  return {
    ...c,
    zoom,
    x: c.x + ((px - width / 2) / base) * (1 / c.zoom - 1 / zoom),
    y: c.y + ((py - height * 0.46) / base) * (1 / c.zoom - 1 / zoom),
  };
}
export function rotateCamera(
  c: GalaxyCamera,
  dx: number,
  dy: number,
): GalaxyCamera {
  return {
    ...c,
    yaw: c.yaw + dx * 0.006,
    tilt: Math.max(-1.42, Math.min(1.42, c.tilt + dy * 0.006)),
  };
}
export function planetOrbit(
  index: number,
  count: number,
  width: number,
  height: number,
) {
  return {
    radius: 35 + ((index + 1) / (count + 1)) * Math.min(width, height) * 0.34,
    speed: 0.12 + 0.18 / (index + 1),
  };
}
export function planetLabel(p: OwnedPlanet) {
  return `${p.candidateId} · ${p.kind === "confirmed" ? "확정 행성" : "미확정 후보"} · 주기 ${p.periodDays === null ? "정보 없음" : p.periodDays + "일"} · 감광 깊이 ${p.depthPpm === null ? "정보 없음" : p.depthPpm + " ppm (" + p.depthPpm / 10000 + "%)"}`;
}
export type TutorialMarkers = Map<
  string,
  { seq: number; completed: boolean; visible: boolean }
>;
export function readTutorialMarkers(value: unknown): TutorialMarkers {
  const fail = (): never => {
    throw new SkyContractError("튜토리얼 마커 상태를 확인해 주세요.");
  };
  const v = value as {
    tutorial?: {
      items?: {
        seq: number;
        status: string;
        ticId: string | null;
        completionReason: string | null;
      }[];
    };
  };
  const items = v?.tutorial?.items;
  if (!Array.isArray(items) || items.length !== 5) return fail();
  const result: TutorialMarkers = new Map(),
    seen = new Set<number>();
  for (const item of items) {
    if (
      !item ||
      !Number.isInteger(item.seq) ||
      item.seq < 1 ||
      item.seq > 5 ||
      seen.has(item.seq) ||
      !["locked", "unlocked", "in_progress", "completed"].includes(item.status)
    )
      return fail();
    seen.add(item.seq);
    if (item.status === "locked") {
      if (item.ticId !== null) return fail();
      continue;
    }
    if (
      typeof item.ticId !== "string" ||
      !/^\d+$/.test(item.ticId) ||
      result.has(item.ticId)
    )
      return fail();
    const completed =
      item.status === "completed" || item.completionReason === "skipped";
    result.set(item.ticId, { seq: item.seq, completed, visible: !completed });
  }
  return result;
}
// The active challenge belongs to /me/quests, not to the star's discovery reason.
export function readChallengeTicId(value: unknown): string | null {
  const challenge = (
    value as { challenge?: { unlocked?: unknown; ticId?: unknown } }
  )?.challenge;
  if (
    !challenge ||
    typeof challenge.unlocked !== "boolean" ||
    (challenge.unlocked
      ? typeof challenge.ticId !== "string" || !/^\d+$/.test(challenge.ticId)
      : challenge.ticId !== null)
  )
    throw new SkyContractError("챌린지 마커 상태를 확인해 주세요.");
  return challenge.unlocked ? (challenge.ticId as string) : null;
}
export function markerLabel(
  s: Star,
  tutorials: TutorialMarkers | null,
  challengeTicId: string | null = null,
) {
  if (s.ticId === challengeTicId) return "!";
  const state = tutorials?.get(s.ticId);
  return s.marker?.type === "tutorial" &&
    state?.visible &&
    state.seq === s.marker.seq &&
    s.progressStage !== "completed"
    ? String(state.seq)
    : null;
}
