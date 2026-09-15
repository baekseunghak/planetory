import { useEffect, useMemo, useRef, useState } from "react";
import { SkyDataPage, type SkySceneProps } from "../sky-data/SkyDataPage";
import { levelForScale, viewportBounds } from "../sky-data/geometry";
import {
  cameraMatrix,
  initialCamera,
  renderPlan,
  STAR_COLORS,
  COMPLETE_COLOR,
  type GalaxyCamera,
  type OwnedSystem,
} from "./model";
import { GalaxyRenderer, type RendererMetrics } from "./renderer";
import "./galaxy.css";

export type SceneControl = {
  setCamera(
    patch: Partial<GalaxyCamera>,
    options?: { overview?: boolean; level?: number },
  ): void;
  getCamera(): GalaxyCamera | null;
  setSystem(system: OwnedSystem | null): void;
};
type Props = SkySceneProps & {
  onReady?: (control: SceneControl | null) => void;
  onMetrics?: (value: RendererMetrics) => void;
};
export function GalaxyScene({ data, store, onReady, onMetrics }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<GalaxyRenderer | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1100, height: 600 });
  const [camera, setCamera] = useState<GalaxyCamera | null>(null);
  const [mode, setMode] = useState<{ overview: boolean; level: number | null }>(
    { overview: true, level: null },
  );
  const [system, setSystem] = useState<OwnedSystem | null>(null);
  const [failure, setFailure] = useState<string | null>(null),
    [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false),
    [budgetMessage, setBudgetMessage] = useState("");
  const cameraRef = useRef(camera),
    metricsRef = useRef(onMetrics);
  cameraRef.current = camera;
  metricsRef.current = onMetrics;
  const meta = data.meta!;
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setDimensions({
        width: Math.max(1, entry.contentRect.width),
        height: Math.max(1, entry.contentRect.height),
      }),
    );
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!camera)
      setCamera(initialCamera(meta, dimensions.width, dimensions.height));
  }, [meta, camera, dimensions]);
  useEffect(() => {
    onReady?.({
      setCamera(patch, options) {
        setCamera((c) => (c ? { ...c, ...patch } : c));
        setMode({
          overview: options?.overview ?? false,
          level: options?.level ?? null,
        });
        setBudgetMessage("");
      },
      getCamera: () => cameraRef.current,
      setSystem(value) {
        setSystem(value);
      },
    });
    return () => onReady?.(null);
  }, [onReady]);
  // A new sky version retires a previously fetched personal-system response.
  useEffect(() => setSystem(null), [meta.version, data.selectedTicId]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let active: GalaxyRenderer | null = null,
      frame = 0,
      last = 0,
      lastMetrics = 0,
      alive = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const tick = (now: number) => {
      if (!alive || !active) return;
      active.draw(last ? (now - last) / 1000 : 0, reduced.matches);
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
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "지도를 그리지 못했습니다.",
      );
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
      camera ? cameraMatrix(camera, dimensions.width, dimensions.height) : null,
    [camera, dimensions],
  );
  const level = mode.level ?? (camera ? levelForScale(meta, camera.scale) : 0);
  useEffect(() => {
    if (!matrix) return;
    void store.setView({
      level: mode.overview ? 0 : level,
      overview: mode.overview,
      box: mode.overview ? null : viewportBounds(matrix),
    });
  }, [store, matrix, level, mode.overview]);
  const planned = useMemo(() => {
    if (!matrix) return { plan: null, error: null };
    try {
      return {
        plan: renderPlan(
          data.stars,
          data.clusters,
          matrix,
          dimensions.width,
          dimensions.height,
        ),
        error: null,
      };
    } catch (error) {
      return {
        plan: null,
        error:
          error instanceof Error ? error.message : "표시 자료를 확인해 주세요.",
      };
    }
  }, [data.stars, data.clusters, matrix, dimensions]);
  useEffect(() => {
    const r = renderer.current;
    if (!r || !ready || !matrix) return;
    r.setCamera(matrix, dimensions.width, dimensions.height);
    if (!planned.plan) {
      r.setScene(
        { stars: [], clusters: [], orbitStars: [], overflow: null },
        null,
      );
      return;
    }
    if (planned.plan.overflow) {
      r.setScene(
        { stars: [], clusters: [], orbitStars: [], overflow: null },
        null,
      );
      const current = data.view?.level ?? 0;
      if (!data.pending && current > 0) {
        setBudgetMessage(
          `${planned.plan.overflow} 표시 예산을 넘어 서버의 더 넓은 군집을 불러옵니다.`,
        );
        setMode({ overview: false, level: current - 1 });
      } else if (!data.pending && current === 0)
        setBudgetMessage(
          "가장 넓은 서버 군집도 표시 예산을 넘었습니다. 지도 자료를 다시 확인해 주세요.",
        );
      return;
    }
    try {
      // A detailed system is supplied only for the selected, currently loaded star.
      const visibleSystem =
        system?.ticId === data.selectedTicId &&
        planned.plan.stars.some((s) => s.ticId === system.ticId)
          ? system
          : null;
      r.setScene(planned.plan, data.selectedTicId, visibleSystem);
      setFailure(null);
      setBudgetMessage("");
    } catch (error) {
      r.setScene(
        { stars: [], clusters: [], orbitStars: [], overflow: null },
        null,
      );
      setFailure(error instanceof Error ? error.message : "표시 자료 오류");
    }
  }, [
    planned,
    matrix,
    dimensions,
    ready,
    data.selectedTicId,
    data.pending,
    data.view?.level,
    system,
  ]);
  return (
    <div className="galaxy-scene">
      <canvas
        ref={canvas}
        role="img"
        aria-label="발견한 별과 서버 성운 군집으로 그린 은하 지도"
      />
      {(failure || planned.error) && (
        <div className="galaxy-error" role="alert">
          <p>{failure || planned.error}</p>
          <button onClick={() => setGeneration((n) => n + 1)}>
            그래픽 다시 시작
          </button>
          <button onClick={() => void store.refresh()}>
            지도 자료 다시 확인
          </button>
        </div>
      )}
      {budgetMessage && (
        <p className="galaxy-budget" role="status">
          {budgetMessage}
        </p>
      )}
      <details className="galaxy-legend">
        <summary>별과 성운 읽기</summary>
        <ul>
          {STAR_COLORS.map((color, i) => (
            <li key={color}>
              <i
                style={{
                  background: color,
                  width: 7 + i * 2,
                  height: 7 + i * 2,
                }}
              />
              내 행성 {i === 4 ? "4개 이상" : `${i}개`}
            </li>
          ))}
          <li>
            <i style={{ background: COMPLETE_COLOR }} />
            표시할 내 행성 없이 탐색 완료
          </li>
          <li>회색 선: 찾은 행성의 궤도</li>
          <li>성운 색: 행성 있음 · 행성 없이 완료 · 나머지 별의 구성 비율</li>
        </ul>
        <p>표면과 궤도는 이해를 돕기 위한 시각화입니다.</p>
      </details>
    </div>
  );
}
export function GalaxyPage() {
  return (
    <SkyDataPage
      renderScene={(props) => (
        <GalaxyScene key={props.store.memberId} {...props} />
      )}
    />
  );
}
