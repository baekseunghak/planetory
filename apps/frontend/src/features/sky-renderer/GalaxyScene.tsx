import { useEffect, useMemo, useRef, useState } from "react";
import { SkyDataPage, type SkySceneProps } from "../sky-data/SkyDataPage";
import type { Star } from "../sky-data/contracts";
import { focusCamera } from "./detail";
import { PersonalGalaxyScene } from "./StarDetail";
import { levelForScale, viewportBounds } from "../sky-data/geometry";
import {
  INITIAL_CAMERA,
  cameraMatrix,
  initialCamera,
  renderPlan,
  type GalaxyCamera,
  type OwnedSystem,
} from "./model";
import { GalaxyRenderer, type RendererMetrics } from "./renderer";
import "./galaxy.css";
import {
  GalaxyInteraction,
  type InteractionControl,
} from "./GalaxyInteraction";

export type SceneControl = {
  setCamera(patch: Partial<GalaxyCamera>, options?: { level?: number }): void;
  getCamera(): GalaxyCamera | null;
  restartGraphics(): void;
  fitAll(): void;
  setSystem(system: OwnedSystem | null): void;
  focusStar(position: Pick<Star, "x" | "y" | "depthZ">): void;
};
type Props = SkySceneProps & {
  personalSystem?: OwnedSystem | null;
  onReady?: (control: SceneControl | null) => void;
  onMetrics?: (value: RendererMetrics) => void;
  onPlanetSelect?: (candidateId: string | null) => void;
  onDeselect?: () => void;
  selectedStar?: Star | null;
  focusedPlanet?: string | null;
  suspended?: boolean;
  onGraphics?: (available: boolean, message: string | null) => void;
};
export function GalaxyScene({
  data,
  store,
  onReady,
  onMetrics,
  personalSystem,
  onPlanetSelect,
  onDeselect,
  selectedStar,
  focusedPlanet = null,
  suspended = false,
  onGraphics,
}: Props) {
  const cameraAnimation = useRef(0);
  const interaction = useRef<InteractionControl | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<GalaxyRenderer | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<GalaxyCamera | null>(null);
  const [forcedLevel, setForcedLevel] = useState<number | null>(null);
  const [system, setSystem] = useState<OwnedSystem | null>(null);
  const [failure, setFailure] = useState<string | null>(null),
    [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const paused = useRef(suspended);
  paused.current = suspended;
  const hasCamera = camera !== null;
  const current = useRef({ camera, dimensions, data }),
    metricsRef = useRef(onMetrics);
  current.current = { camera, dimensions, data };
  metricsRef.current = onMetrics;
  const meta = data.meta!;
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([e]) =>
      setDimensions({
        width: Math.max(1, e.contentRect.width),
        height: Math.max(1, e.contentRect.height),
      }),
    );
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!camera && dimensions.width > 0) setCamera({ ...INITIAL_CAMERA });
  }, [meta, camera, dimensions]);
  useEffect(() => {
    onReady?.({
      restartGraphics: () => setGeneration((n) => n + 1),
      setCamera(patch, options) {
        cancelAnimationFrame(cameraAnimation.current);
        const c = current.current.camera,
          d = current.current.dimensions;
        if (!c) return;
        const next = { ...c, ...patch };
        cameraMatrix(next, d.width, d.height);
        const level = options?.level;
        if (
          level !== undefined &&
          !current.current.data.meta!.zoomLevels.some((z) => z.level === level)
        )
          throw new Error("지원하지 않는 배율입니다.");
        setCamera(next);
        setForcedLevel(level ?? null);
      },
      getCamera: () => current.current.camera,
      focusStar(position) {
        cancelAnimationFrame(cameraAnimation.current);
        const start = current.current.camera;
        if (!start) return;
        const target = focusCamera(start, position);
        setForcedLevel(null);
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setCamera(target);
          return;
        }
        const began = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - began) / 650),
            ease = 1 - (1 - t) ** 3;
          setCamera({
            ...target,
            x: start.x + (target.x - start.x) * ease,
            y: start.y + (target.y - start.y) * ease,
            zoom: start.zoom + (target.zoom - start.zoom) * ease,
          });
          if (t < 1) cameraAnimation.current = requestAnimationFrame(tick);
        };
        cameraAnimation.current = requestAnimationFrame(tick);
      },
      fitAll() {
        const { data, dimensions } = current.current;
        setSystem(null);
        setForcedLevel(null);
        setCamera(
          initialCamera(data.meta!, dimensions.width, dimensions.height),
        );
      },
      setSystem(value) {
        setSystem(value);
      },
    });
    return () => {
      cancelAnimationFrame(cameraAnimation.current);
      onReady?.(null);
    };
  }, [onReady, hasCamera]);
  useEffect(() => setSystem(null), [meta.version, data.selectedTicId]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active: GalaxyRenderer | null = null,
      frame = 0,
      last = 0,
      lastMetrics = 0,
      alive = true;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const tick = (now: number) => {
      if (!alive || !active) return;
      if (paused.current) {
        last = 0;
        frame = requestAnimationFrame(tick);
        return;
      }
      active.draw(last ? (now - last) / 1000 : 0, reduced.matches);
      interaction.current?.frame(active.planetTargets());
      last = now;
      if (now - lastMetrics > 250) {
        metricsRef.current?.(active.metrics());
        lastMetrics = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (!document.hidden && alive && active)
        frame = requestAnimationFrame(tick);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(cameraAnimation.current);
      setReady(false);
      setFailure(
        "그래픽 연결이 끊겼습니다. 복구되면 현재 지도를 다시 그립니다.",
      );
    };
    const restored = () => {
      if (alive) setGeneration((n) => n + 1);
    };
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    document.addEventListener("visibilitychange", visibility);
    try {
      active = new GalaxyRenderer(element);
      renderer.current = active;
      setFailure(null);
      setReady(true);
      if (!document.hidden) frame = requestAnimationFrame(tick);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "지도를 그리지 못했습니다.");
      setReady(false);
    }
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      element.removeEventListener("webglcontextlost", lost);
      element.removeEventListener("webglcontextrestored", restored);
      document.removeEventListener("visibilitychange", visibility);
      active?.dispose();
      renderer.current = null;
    };
  }, [generation]);
  useEffect(() => {
    if (ready || failure) onGraphics?.(ready && !failure, failure);
  }, [ready, failure, onGraphics]);
  const matrix = useMemo(
    () =>
      camera && dimensions.width > 0
        ? cameraMatrix(camera, dimensions.width, dimensions.height)
        : null,
    [camera, dimensions],
  );
  const level = forcedLevel ?? (camera ? levelForScale(meta, camera.zoom) : 0);
  useEffect(() => {
    if (matrix && !suspended)
      void store.setView({ level, box: viewportBounds(matrix) });
  }, [store, matrix, level, suspended]);
  const sourceStars = useMemo(
    () =>
      selectedStar && !data.stars.some((s) => s.ticId === selectedStar.ticId)
        ? [...data.stars, selectedStar]
        : data.stars,
    [data.stars, selectedStar],
  );
  const plan = useMemo(
    () =>
      matrix
        ? renderPlan(sourceStars, matrix, dimensions.width, dimensions.height)
        : { stars: [] },
    [sourceStars, matrix, dimensions],
  );
  // Retire stale detail synchronously, before effects/paint after a version or selection change.
  const requestedSystem =
    personalSystem === undefined ? system : personalSystem;
  const visibleSystem =
    requestedSystem?.version === meta.version &&
    requestedSystem.presentationVersion === meta.presentationVersion &&
    requestedSystem.ticId === data.selectedTicId &&
    plan.stars.some((s) => s.ticId === requestedSystem.ticId)
      ? requestedSystem
      : null;
  useEffect(() => {
    const r = renderer.current;
    if (!r || !ready || !matrix || !camera) return;
    r.setCamera(
      matrix,
      dimensions.width,
      dimensions.height,
      camera.zoom,
      meta.starCount,
    );
    try {
      r.setScene(plan, data.selectedTicId, visibleSystem);
      r.setPlanetFocus(focusedPlanet);
      setFailure(null);
    } catch (e) {
      r.setScene({ stars: [] }, null);
      setFailure(e instanceof Error ? e.message : "표시 자료 오류");
    }
  }, [
    plan,
    matrix,
    dimensions,
    ready,
    generation,
    data.selectedTicId,
    visibleSystem,
    camera,
    meta.starCount,
    focusedPlanet,
  ]);
  return (
    <div
      className="galaxy-scene"
      inert={suspended}
      aria-hidden={suspended || undefined}
    >
      <canvas
        ref={canvas}
        data-rendered-stars={plan.stars.length}
        data-rendered-planets={visibleSystem?.items.length ?? 0}
        data-focused-planet={focusedPlanet ?? ""}
        tabIndex={suspended ? -1 : 0}
        role="listbox"
        {...(import.meta.env.DEV
          ? { "data-camera": JSON.stringify(camera) }
          : {})}
        aria-label="내가 발견한 개별 별로 이루어진 3D 은하 지도"
      />
      {camera && matrix && (
        <GalaxyInteraction
          ref={interaction}
          canvas={canvas}
          camera={camera}
          matrix={matrix}
          width={dimensions.width}
          height={dimensions.height}
          stars={sourceStars}
          system={visibleSystem}
          data={data}
          store={store}
          onPlanetSelect={onPlanetSelect}
          onDeselect={onDeselect}
          enabled={ready && !failure && !data.needsRefresh && !suspended}
          changeCamera={(next) => {
            cancelAnimationFrame(cameraAnimation.current);
            setForcedLevel(null);
            setCamera(next);
          }}
          fitAll={() => {
            cancelAnimationFrame(cameraAnimation.current);
            if (onDeselect && data.selectedTicId) {
              onDeselect();
              return;
            }
            setForcedLevel(null);
            setCamera(initialCamera(meta, dimensions.width, dimensions.height));
          }}
        />
      )}
      {failure && (
        <div className="galaxy-error" role="alert">
          <p>{failure}</p>
          <button onClick={() => setGeneration((n) => n + 1)}>
            그래픽 다시 시작
          </button>
          <button onClick={() => void store.refresh()}>
            지도 자료 다시 확인
          </button>
        </div>
      )}
      <details className="galaxy-legend">
        <summary>별지도 읽기</summary>
        <p>
          금빛 중심과 푸른 별빛은 은하를 표현하는 색입니다. 행성 수나 탐색
          성과를 뜻하지 않습니다.
        </p>
        <p>행성과 궤도는 선택한 별의 근접 화면에서만 나타납니다.</p>
        <p>표면과 궤도는 이해를 돕기 위한 시각화입니다.</p>
        <p>
          파란 번호는 진행할 튜토리얼, 빨간 느낌표는 챌린지입니다. 완료한
          튜토리얼 번호는 사라집니다.
        </p>
        <p>
          드래그: 회전 · Shift+드래그 또는 우클릭 드래그: 이동 · 휠: 확대/축소.
          이동 모드에서는 드래그로 이동합니다.
        </p>
        <p>
          지도에 Tab으로 들어간 뒤 방향키: 이동 · Shift+방향키: 회전 · +/−: 배율
          · Home: 전체 보기 · [/]: 화면의 별/행성 탐색 · Enter: 선택 · Escape:
          해제.
        </p>
      </details>
      <span className="galaxy-visible-count" data-testid="visible-count">
        적재 {data.loadedCount.toLocaleString()} · 화면{" "}
        {plan.stars.length.toLocaleString()}
      </span>
    </div>
  );
}
export function GalaxyPage() {
  return (
    <SkyDataPage
      renderScene={(props) => (
        <PersonalGalaxyScene key={props.store.memberId} {...props} />
      )}
    />
  );
}
