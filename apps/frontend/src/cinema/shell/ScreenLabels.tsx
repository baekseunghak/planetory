// DOM on top of the scene, placed from the scene's own projection feed.
// Positions change in onFrame through transforms only (no React state per
// frame). Nothing is shown until the scene reports a visible position.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Star } from "../../features/sky-data/contracts";
import { useOptionalQuests } from "../../features/quests/QuestProvider";
import { currentChallengeMismatch } from "../../features/quests/contracts";
import {
  markerLabel,
  starLabel,
} from "../../features/sky-renderer/interaction";
import type { OwnedPlanet } from "../../features/sky-renderer/model";
import { useScene, type ScreenPoint } from "../scene";
import { progressLabel } from "./StarPanel";

function place(
  node: HTMLElement,
  point: ScreenPoint | null,
  offset = "translate(-50%, -50%)",
) {
  if (!point || !point.visible) {
    if (node.dataset.visible !== "false") node.dataset.visible = "false";
    return;
  }
  node.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0) ${offset}`;
  if (node.dataset.visible !== "true") node.dataset.visible = "true";
}

/** Tutorial numbers (blue) and the challenge "!" (red), per markerLabel(). */
export function MarkerLayer({
  stars,
  onSelect,
  held = false,
  onHover,
}: {
  stars: readonly Star[];
  onSelect(ticId: string): void;
  /**
   * The camera is still moving (fly-in, leaving a system, ignition): the
   * markers wait and fade in once the galaxy is at rest, so a number never
   * sits on the face of the star the camera is leaving.
   */
  held?: boolean;
  /** Pointer or keyboard on a marker: name its star like a hovered star. */
  onHover?(ticId: string | null): void;
}) {
  const scene = useScene();
  const quest = useOptionalQuests();
  const tutorials = quest?.markers ?? null;
  const stale = currentChallengeMismatch(
    quest?.current,
    quest?.quests?.challenge,
  );
  const challengeTicId =
    quest?.quests?.challenge.unlocked && !stale
      ? quest.quests.challenge.ticId
      : null;
  const byId = useMemo(
    () => new Map(stars.map((star) => [star.ticId, star])),
    [stars],
  );
  const markers = useMemo(() => {
    const ids = new Set([
      ...(tutorials?.keys() ?? []),
      ...(challengeTicId ? [challengeTicId] : []),
    ]);
    return [...ids].flatMap((id) => {
      const star = byId.get(id);
      if (!star) return [];
      const label = markerLabel(star, tutorials, challengeTicId);
      return label ? [{ star, label }] : [];
    });
  }, [byId, tutorials, challengeTicId]);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const update = () => {
      for (const [ticId, node] of nodes.current)
        place(node, scene.projectStar(ticId), "translate(-50%, -135%)");
    };
    update();
    return scene.onFrame(update);
  }, [scene, markers]);
  return (
    <div
      className="cinema-markers"
      data-testid="marker-pool"
      data-pool-size={markers.length}
      data-held={held ? "true" : "false"}
    >
      {markers.map(({ star, label }) => (
        <button
          key={star.ticId}
          type="button"
          ref={(node) => {
            if (node) nodes.current.set(star.ticId, node);
            else nodes.current.delete(star.ticId);
          }}
          className="galaxy-marker cinema-marker"
          data-marker={label}
          data-tic-id={star.ticId}
          data-visible="false"
          aria-label={`${label === "!" ? "챌린지" : "튜토리얼 " + label} · ${starLabel(star)}`}
          onClick={() => onSelect(star.ticId)}
          onPointerEnter={() => onHover?.(star.ticId)}
          onPointerLeave={() => onHover?.(null)}
          onFocus={() => onHover?.(star.ticId)}
          onBlur={() => onHover?.(null)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** TIC and a short status next to the star under the pointer (or marker). */
export function HoverLabel({
  stars,
  forced = null,
}: {
  stars: readonly Star[];
  /** A marker under the pointer or keyboard focus names this star. */
  forced?: string | null;
}) {
  const scene = useScene();
  const [pointed, setHover] = useState<string | null>(null);
  const hover = forced ?? pointed;
  const node = useRef<HTMLDivElement>(null);
  const star = useMemo(
    () => (hover ? (stars.find((item) => item.ticId === hover) ?? null) : null),
    [stars, hover],
  );
  useEffect(
    () => scene.onStarHover((pointer) => setHover(pointer?.ticId ?? null)),
    [scene],
  );
  useEffect(() => {
    if (!hover || !node.current) return;
    const target = node.current;
    const update = () =>
      place(target, scene.projectStar(hover), "translate(14px, -50%)");
    update();
    return scene.onFrame(update);
  }, [scene, hover]);
  if (!hover) return null;
  return (
    <div
      ref={node}
      className="cinema-hover"
      data-visible="false"
      aria-hidden="true"
    >
      <b>TIC {hover}</b>
      {star && (
        <span>
          {progressLabel[star.progressStage]}
          {star.planetCount ? ` · 행성 ${star.planetCount}` : ""}
        </span>
      )}
    </div>
  );
}

/** "행성 N" beside each of my planets while a system is on stage. */
export function PlanetLabels({
  planets,
  selected,
}: {
  planets: readonly OwnedPlanet[];
  selected: string | null;
}) {
  const scene = useScene();
  const nodes = useRef(new Map<string, HTMLSpanElement>());
  useEffect(() => {
    const update = () => {
      for (const [id, node] of nodes.current) {
        const point = scene.projectPlanet(id);
        // Below the planet's own disc, not on it.
        const gap = Math.round((point?.radius ?? 0) + 6);
        place(node, point, `translate(-50%, ${gap}px)`);
      }
    };
    update();
    return scene.onFrame(update);
  }, [scene, planets]);
  return (
    <div className="cinema-planet-labels" aria-hidden="true">
      {planets.map((planet, index) => (
        <span
          key={planet.candidateId}
          ref={(node) => {
            if (node) nodes.current.set(planet.candidateId, node);
            else nodes.current.delete(planet.candidateId);
          }}
          data-visible="false"
          data-selected={planet.candidateId === selected}
          data-kind={planet.kind}
        >
          행성 {index + 1}
        </span>
      ))}
    </div>
  );
}

/**
 * After an ignition: a ring and "새로 열린 별" on the new star, so the member
 * can tell which one it is. It stays until the next thing they do.
 */
export function NewStarReticle({
  ticId,
  onDone,
}: {
  ticId: string;
  onDone(): void;
}) {
  const scene = useScene();
  const node = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const target = node.current;
    if (!target) return;
    const update = () =>
      place(target, scene.projectStar(ticId), "translate(-50%, -50%)");
    update();
    return scene.onFrame(update);
  }, [scene, ticId]);
  useEffect(() => {
    // The next interaction ends it; the click that caused the ignition
    // (은하로 돌아가기) is long over by now.
    const end = () => done.current();
    const options = { capture: true, once: true } as const;
    document.addEventListener("pointerdown", end, options);
    document.addEventListener("keydown", end, options);
    document.addEventListener("wheel", end, options);
    return () => {
      document.removeEventListener("pointerdown", end, options);
      document.removeEventListener("keydown", end, options);
      document.removeEventListener("wheel", end, options);
    };
  }, []);
  return (
    <div
      ref={node}
      className="cinema-reticle"
      data-visible="false"
      data-testid="new-star-reticle"
      data-tic-id={ticId}
    >
      <span className="cinema-reticle-ring" aria-hidden="true" />
      <span className="cinema-reticle-label">
        <b>새로 열린 별</b>
        <span className="cinema-num">TIC {ticId}</span>
      </span>
    </div>
  );
}
