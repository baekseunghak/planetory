import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  cameraMatrix,
  initialCamera,
  type RenderPlan,
} from "./legacy-galaxy/model";
import { GalaxyRenderer, type RendererMetrics } from "./legacy-galaxy/renderer";
import type { Matrix } from "./legacy-galaxy/geometry";
import {
  comparisonPlans,
  readComparisonSnapshot,
  type ComparisonSnapshot,
} from "./galaxy-comparison-model";
import "./galaxy-comparison.css";

type View = { zoom: number; rotation: number; tilt: number };
const initialView: View = { zoom: 1, rotation: 0.12, tilt: 0.78 };
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
type PanelProps = {
  label: string;
  kind: "individual" | "grouped";
  plan: RenderPlan;
  matrix: Matrix;
  width: number;
  height: number;
  frameKey: string;
  onDrag: (x: number, y: number) => void;
  onZoom: (factor: number) => void;
};
function ComparisonPanel({
  label,
  kind,
  plan,
  matrix,
  width,
  height,
  frameKey,
  onDrag,
  onZoom,
}: PanelProps) {
  const canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<GalaxyRenderer | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null),
    zoomRef = useRef(onZoom);
  zoomRef.current = onZoom;
  const [metrics, setMetrics] = useState<RendererMetrics | null>(null),
    [error, setError] = useState("");
  const [generation, setGeneration] = useState(0),
    [ready, setReady] = useState(false);
  useEffect(() => {
    const element = canvas.current!;
    let r: GalaxyRenderer | null = null,
      raf = 0,
      alive = true,
      lastMetrics = 0;
    const draw = (now: number) => {
      if (!alive || !r) return;
      r.draw(0, true);
      if (now - lastMetrics >= 700) {
        setMetrics(r.metrics());
        lastMetrics = now;
      }
      raf = requestAnimationFrame(draw);
    };
    const visibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && r) raf = requestAnimationFrame(draw);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(raf);
      setReady(false);
      setError("그래픽 연결 복구를 기다리고 있습니다.");
    };
    const restored = () => {
      if (alive) setGeneration((n) => n + 1);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      zoomRef.current(Math.exp(clamp(-delta * 0.0015, -0.5, 0.5)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("webglcontextlost", lost);
    element.addEventListener("webglcontextrestored", restored);
    document.addEventListener("visibilitychange", visibility);
    try {
      r = new GalaxyRenderer(element);
      renderer.current = r;
      setReady(true);
      setError("");
      if (!document.hidden) raf = requestAnimationFrame(draw);
    } catch (e) {
      setReady(false);
      setError(
        e instanceof Error ? e.message : "비교 화면을 그리지 못했습니다.",
      );
    }
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("webglcontextlost", lost);
      element.removeEventListener("webglcontextrestored", restored);
      document.removeEventListener("visibilitychange", visibility);
      r?.dispose();
      renderer.current = null;
    };
  }, [generation, height]);
  useEffect(() => {
    const r = renderer.current;
    if (!r || !ready) return;
    try {
      r.setCamera(matrix, width, height);
      r.setScene(plan, null);
      setMetrics(r.metrics());
      setError("");
    } catch (e) {
      r.setScene(
        { stars: [], clusters: [], orbitStars: [], overflow: null },
        null,
      );
      setError(e instanceof Error ? e.message : "표시 오류");
    }
  }, [ready, plan, matrix, width, height, generation]);
  const end = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <article className="comparison-panel" data-testid={`panel-${kind}`}>
      <header>
        <span className="comparison-index">
          {kind === "individual" ? "A" : "B"}
        </span>
        <div>
          <h2>{label}</h2>
          <p>
            {kind === "individual"
              ? "같은 별을 하나씩 표시"
              : "현재 204의 군집·LOD 표현"}
          </p>
        </div>
      </header>
      <div className="comparison-viewport">
        <canvas
          ref={canvas}
          style={{ height }}
          role="img"
          tabIndex={0}
          aria-label={`${label} 은하. 드래그와 방향키로 회전, 휠과 더하기 빼기로 확대 축소`}
          data-view={frameKey}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            onDrag(e.clientX - d.x, e.clientY - d.y);
            drag.current = { id: d.id, x: e.clientX, y: e.clientY };
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            const actions: Record<string, () => void> = {
              ArrowLeft: () => onDrag(-12, 0),
              ArrowRight: () => onDrag(12, 0),
              ArrowUp: () => onDrag(0, -12),
              ArrowDown: () => onDrag(0, 12),
              "+": () => onZoom(1.2),
              "=": () => onZoom(1.2),
              "-": () => onZoom(1 / 1.2),
            };
            if (actions[e.key]) {
              e.preventDefault();
              actions[e.key]();
            }
          }}
        />
        {error && (
          <div role="alert" className="comparison-error">
            <p>{error}</p>
            <button onClick={() => setGeneration((n) => n + 1)}>
              다시 그리기
            </button>
          </div>
        )}
        <div className="comparison-caption">
          {kind === "individual"
            ? `${plan.stars.length.toLocaleString()}개의 개별 별`
            : `${plan.clusters.length.toLocaleString()}개 군집 · ${plan.stars.length.toLocaleString()}개 개별 별`}
        </div>
      </div>
      <dl className="comparison-metrics">
        <div>
          <dt>본체·성운 그리기</dt>
          <dd>{metrics?.bodyDrawCalls ?? "—"}회</dd>
        </div>
        <div>
          <dt>궤도 표시 별</dt>
          <dd>{metrics?.orbitStars ?? "—"}개</dd>
        </div>
        <div>
          <dt>GPU 버퍼</dt>
          <dd>{metrics?.gpuBuffers ?? "—"}개</dd>
        </div>
      </dl>
      <details className="comparison-detail">
        <summary>계측 원문</summary>
        <output data-testid={`stats-${kind}`}>{JSON.stringify(metrics)}</output>
      </details>
    </article>
  );
}

export function GalaxyComparisonPage() {
  const [snapshot, setSnapshot] = useState<ComparisonSnapshot | null>(null),
    [error, setError] = useState("");
  const [request, setRequest] = useState(0),
    [view, setView] = useState<View>(initialView);
  const [fixedClusters, setFixedClusters] = useState(false),
    [orbits, setOrbits] = useState(false);
  const [layout, setLayout] = useState<"both" | "individual" | "grouped">(
    "both",
  );
  const measuring = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 480 });
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setSnapshot(null);
    fetch("/api/dev-legacy-galaxy-204/dev-galaxy-204/comparison", {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(`비교 자료를 가져오지 못했습니다. (${r.status})`);
        const next = readComparisonSnapshot(await r.json());
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setView(initialView);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message || e));
      });
    return () => controller.abort();
  }, [request]);
  useEffect(() => {
    const element = measuring.current;
    if (!element) return;
    const resize = () => {
      const gap = 20,
        cols = getComputedStyle(element).gridTemplateColumns.split(" ").length;
      setSize({
        width: Math.max(
          1,
          (element.getBoundingClientRect().width - gap * (cols - 1)) / cols,
        ),
        height: clamp(window.innerHeight * 0.53, 340, 650),
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [layout]);
  const onDrag = useCallback(
    (x: number, y: number) =>
      setView((v) => ({
        ...v,
        rotation: v.rotation + x * 0.007,
        tilt: clamp(v.tilt + y * 0.005, 0, 1.35),
      })),
    [],
  );
  const onZoom = useCallback(
    (factor: number) =>
      setView((v) => ({ ...v, zoom: clamp(v.zoom * factor, 0.6, 45) })),
    [],
  );
  const scene = useMemo(() => {
    if (!snapshot) return null;
    const camera = {
      ...initialCamera(snapshot.meta, size.width, size.height),
      rotation: view.rotation,
      tilt: view.tilt,
    };
    camera.scale *= view.zoom;
    const matrix = cameraMatrix(camera, size.width, size.height);
    return {
      matrix,
      ...comparisonPlans(
        snapshot,
        matrix,
        size.width,
        size.height,
        camera.scale,
        fixedClusters,
        orbits,
      ),
    };
  }, [snapshot, size, view, fixedClusters, orbits]);
  const frameKey = JSON.stringify({ view, size });
  return (
    <main className="galaxy-comparison-page">
      <nav>
        <a href="/sky" className="comparison-wordmark">
          PLANETORY
        </a>
        <a href="/sky">기존 별지도로 돌아가기 ↗</a>
      </nav>
      <header className="comparison-intro">
        <p className="comparison-kicker">GALAXY / A–B STUDY</p>
        <h1>별을 모으면, 무엇이 달라질까요.</h1>
        <p>같은 별, 같은 위치, 같은 시점. 군집을 사용하는 방식만 비교합니다.</p>
        <span className="comparison-badge">
          군집 비교 실험 · 가상 데이터{" "}
          {snapshot?.stars.length.toLocaleString() ?? "…"}개
        </span>
      </header>
      <section className="comparison-toolbar" aria-label="양쪽 지도 공통 조작">
        <div
          className="comparison-segments"
          role="group"
          aria-label="보기 방식"
        >
          {(
            [
              ["both", "나란히"],
              ["individual", "군집 없음 크게"],
              ["grouped", "군집 있음 크게"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              aria-pressed={layout === value}
              onClick={() => setLayout(value)}
            >
              {text}
            </button>
          ))}
        </div>
        <button onClick={() => setView(initialView)}>처음 시점</button>
        <button onClick={() => setView((v) => ({ ...v, tilt: 0 }))}>
          정면 보기
        </button>
        <label>
          확대{" "}
          <input
            aria-label="공통 확대 배율"
            type="range"
            min="0.6"
            max="45"
            step="0.1"
            value={view.zoom}
            onChange={(e) =>
              setView((v) => ({ ...v, zoom: Number(e.target.value) }))
            }
          />
          <output data-testid="comparison-zoom">{view.zoom.toFixed(1)}×</output>
        </label>
        <label>
          오른쪽 표현{" "}
          <select
            value={fixedClusters ? "fixed" : "auto"}
            onChange={(e) => setFixedClusters(e.target.value === "fixed")}
          >
            <option value="auto">현재 LOD 자동 전환</option>
            <option value="fixed">큰 군집 유지</option>
          </select>
        </label>
        <label className="comparison-checkbox">
          <input
            type="checkbox"
            checked={orbits}
            onChange={(e) => setOrbits(e.target.checked)}
          />
          궤도 함께 보기
        </label>
      </section>
      <p className="comparison-gesture">
        어느 쪽이든 드래그하면 함께 회전합니다. 휠로 확대·축소할 수 있습니다.
        키보드: 방향키 회전, + / − 확대·축소.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setRequest((n) => n + 1)}>
            다시 불러오기
          </button>
        </p>
      )}
      {!snapshot && !error && (
        <p role="status">같은 원본 별과 군집 자료를 준비하고 있습니다.</p>
      )}
      <div
        ref={measuring}
        className={`comparison-grid ${layout === "both" ? "comparison-two" : "comparison-one"}`}
      >
        {scene &&
          (["individual", "grouped"] as const)
            .filter((kind) => layout === "both" || layout === kind)
            .map((kind) => (
              <ComparisonPanel
                key={kind}
                label={kind === "individual" ? "군집 없음" : "군집 있음"}
                kind={kind}
                plan={scene[kind]}
                matrix={scene.matrix}
                width={size.width}
                height={size.height}
                frameKey={frameKey}
                onDrag={onDrag}
                onZoom={onZoom}
              />
            ))}
      </div>
      {snapshot && scene && (
        <section className="comparison-explanation" aria-label="비교 조건">
          <div>
            <h2>지금 비교하는 조건</h2>
            <p>
              현재 204의 별 {snapshot.stars.length.toLocaleString()}개와 그
              별들을 묶은 자료를 한 번에 읽었습니다. 양쪽의 좌표·별빛·카메라는
              같습니다. 오른쪽은{" "}
              {snapshot.meta.zoomLevels[scene.level].clustered
                ? `LOD ${scene.level}의 군집`
                : `LOD ${scene.level}의 개별 별`}
              을 표시합니다.
            </p>
            <p>
              {fixedClusters
                ? "큰 군집을 유지하여 확대해도 묶음의 형태를 비교합니다."
                : "현재 LOD 자동 전환에서는 가까이 갈수록 오른쪽도 개별 별로 바뀝니다. 예산을 넘으면 더 넓은 군집을 사용합니다."}
            </p>
          </div>
          <div>
            <h2>확인할 차이</h2>
            <p>
              나선팔의 윤곽, 별빛의 선명함, 회전했을 때의 깊이를 비교해 보세요.
              왼쪽도 현재 204와 같은 별 자료이므로 예전 시제품의 전체 외형을
              복원한 화면은 아닙니다.
            </p>
            <p>
              개별 별이 많아도 인스턴싱 때문에 그리기 호출 수는 같을 수
              있습니다. 이 수치만으로 성능의 우열을 판단할 수는 없습니다.
            </p>
          </div>
          <p className="comparison-footnote">
            왼쪽은 군집 효과를 비교하기 위해 별 400개·궤도 표시 별 60개 제한을
            해제한 실험입니다. 오른쪽은 현재 렌더 예산을 적용합니다.{" "}
            {scene.rawBudget
              ? `현재 개별 표시는 ${scene.rawBudget} 예산을 초과합니다. `
              : ""}
            두 장면을 함께 실행하므로 최종 성능 인수 자료로 사용하지 않습니다.
            기존 /sky 화면과 공식 API 계약은 그대로입니다.
          </p>
          <output hidden data-testid="comparison-snapshot-204">
            {JSON.stringify({
              version: snapshot.meta.version,
              count: snapshot.stars.length,
              level: scene.level,
              fixedClusters,
              view,
              size,
            })}
          </output>
        </section>
      )}
    </main>
  );
}
