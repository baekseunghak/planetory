import { useEffect, useMemo, useRef, useState } from "react";
import { SkyDataPage, type SkySceneProps } from "../sky-data/SkyDataPage";
import { api } from "../../api";
import { ErrorState } from "../../components/RequestState";
import { levelForScale, viewportBounds } from "../sky-data/geometry";
import {
  INITIAL_CAMERA,
  cameraMatrix,
  initialCamera,
  renderPlan,
  readOwnedSystem,
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
  fitAll(): void;
  setSystem(system: OwnedSystem | null): void;
};
type Props = SkySceneProps & {
  personalSystem?: OwnedSystem | null;
  onReady?: (control: SceneControl | null) => void;
  onMetrics?: (value: RendererMetrics) => void;
  onPlanetSelect?: (candidateId: string | null) => void;
};
export function GalaxyScene({
  data,
  store,
  onReady,
  onMetrics,
  personalSystem,
  onPlanetSelect,
}: Props) {
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
      setCamera(patch, options) {
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
    return () => onReady?.(null);
  }, [onReady]);
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
  const matrix = useMemo(
    () =>
      camera && dimensions.width > 0
        ? cameraMatrix(camera, dimensions.width, dimensions.height)
        : null,
    [camera, dimensions],
  );
  const level = forcedLevel ?? (camera ? levelForScale(meta, camera.zoom) : 0);
  useEffect(() => {
    if (matrix) void store.setView({ level, box: viewportBounds(matrix) });
  }, [store, matrix, level]);
  const plan = useMemo(
    () =>
      matrix
        ? renderPlan(data.stars, matrix, dimensions.width, dimensions.height)
        : { stars: [] },
    [data.stars, matrix, dimensions],
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
  ]);
  return (
    <div className="galaxy-scene">
      <canvas
        ref={canvas}
        data-rendered-stars={plan.stars.length}
        data-rendered-planets={visibleSystem?.items.length ?? 0}
        tabIndex={0}
        role="listbox"
        {...(import.meta.env.DEV ? { "data-camera": JSON.stringify(camera) } : {})}
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
          stars={plan.stars}
          system={visibleSystem}
          data={data}
          store={store}
          onPlanetSelect={onPlanetSelect}
          enabled={ready && !failure && !data.needsRefresh}
          changeCamera={(next) => {
            setForcedLevel(null);
            setCamera(next);
          }}
          fitAll={() => {
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
// Only fetch the selected member's system. Detail controls/planet information belong to 206.
function PersonalGalaxyScene(props: SkySceneProps) {
  const { data, store } = props;
  const selected = data.stars.find((star) => star.ticId === data.selectedTicId);
  const [system, setSystem] = useState<OwnedSystem | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setSystem(null);
    setError(null);
    if (!selected || !data.meta || data.needsRefresh) return;
    const controller = new AbortController();
    const meta = data.meta;
    void api<unknown>(`/v1/me/stars/${encodeURIComponent(selected.ticId)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted)
          setSystem(readOwnedSystem(value, meta, selected.ticId, selected));
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason
              : new Error("행성을 불러오지 못했습니다."),
          );
      });
    return () => controller.abort();
  }, [store, data.meta, selected, data.needsRefresh, retry]);
  return (
    <>
      {error && (
        <ErrorState
          error={error}
          retry={() => {
            void store.refresh();
            setRetry((n) => n + 1);
          }}
        />
      )}
      <GalaxyScene
        {...props}
        personalSystem={data.needsRefresh || error ? null : system}
      />
    </>
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
