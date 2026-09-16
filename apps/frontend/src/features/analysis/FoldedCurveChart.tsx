import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import type { FoldData } from "./fold-data";
import type { FoldResult } from "./fold-client";
import {
  clampFoldView,
  drawFoldedCurve,
  foldFluxDomain,
  fullFoldView,
  MAX_FOLD_ZOOM,
  zoomFoldView,
} from "./folded-curve";
import "./folded-curve.css";

const number = new Intl.NumberFormat("ko-KR", { maximumSignificantDigits: 12 });
const tick = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 });

export function FoldedCurveChart({
  data,
  result,
  operation,
  fluxUnit,
}: {
  data: FoldData;
  result: FoldResult;
  operation: "reselect" | "fine-tune";
  fluxUnit: string;
}) {
  const [viewport, setViewport] = useState({ result, view: fullFoldView });
  const [inspected, setInspected] = useState<number | null>(null);
  // Reset a new selection before paint; fine tuning preserves the current phase view.
  let view = viewport.view;
  if (viewport.result !== result) {
    view = operation === "reselect" ? fullFoldView : viewport.view;
    setViewport({ result, view });
    setInspected(null);
  }
  const domain = useMemo(() => foldFluxDomain(data.points), [data]);
  const canvas = useRef<HTMLCanvasElement>(null),
    plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 280, dpr: 1 });
  const hintId = useId();
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
  const reset = () => {
    setViewport({ result, view: fullFoldView });
    setInspected(null);
  };
  const zoom = (factor: number) => {
    setViewport((v) => ({ ...v, view: zoomFoldView(v.view, factor) }));
    setInspected(null);
  };
  const pan = (direction: number) => {
    setViewport((v) => ({
      ...v,
      view: clampFoldView({
        ...v.view,
        center: v.view.center + (direction * 0.4) / v.view.zoom,
      }),
    }));
    setInspected(null);
  };
  useEffect(() => {
    const element = plot.current!;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = {
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
      };
      setSize((previous) =>
        previous.width === next.width &&
        previous.height === next.height &&
        previous.dpr === next.dpr
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    let resolution: MediaQueryList;
    const watch = () => {
      resolution?.removeEventListener("change", change);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      resolution.addEventListener("change", change);
    };
    const change = () => {
      update();
      watch();
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      );
      setViewport((v) => ({
        ...v,
        view: zoomFoldView(v.view, event.deltaY < 0 ? 2 : 0.5, ratio),
      }));
      setInspected(null);
    };
    update();
    watch();
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      resolution.removeEventListener("change", change);
      element.removeEventListener("wheel", wheel);
    };
  }, []);
  useLayoutEffect(() => {
    const element = canvas.current!;
    if (size.width <= 0 || size.height <= 0) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const width = Math.round(size.width * size.dpr),
      height = Math.round(size.height * size.dpr);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    drawFoldedCurve(
      ctx,
      data.points,
      result.phases,
      domain,
      view,
      size.width,
      size.height,
    );
  }, [data, result, domain, view.zoom, view.center, size]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (
      ![
        "+",
        "=",
        "-",
        "0",
        "Home",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    if (["+", "="].includes(event.key)) zoom(2);
    else if (event.key === "-") zoom(0.5);
    else if (["0", "Home"].includes(event.key)) reset();
    else if (["ArrowLeft", "ArrowRight"].includes(event.key))
      pan(event.key === "ArrowLeft" ? -1 : 1);
    else
      setInspected((i) =>
        Math.max(
          0,
          Math.min(
            data.points.length - 1,
            i === null ? 0 : i + (event.key === "ArrowDown" ? 1 : -1),
          ),
        ),
      );
  };
  const point = inspected === null ? null : data.points[inspected];
  return (
    <>
      <div
        className="periodogram-toolbar"
        role="group"
        aria-label="접힌 곡선 조작"
      >
        <button
          type="button"
          onClick={() => zoom(2)}
          disabled={view.zoom >= MAX_FOLD_ZOOM}
        >
          접힌 곡선 확대
        </button>
        <button
          type="button"
          onClick={() => zoom(0.5)}
          disabled={view.zoom <= 1}
        >
          접힌 곡선 축소
        </button>
        <button type="button" onClick={() => pan(-1)} disabled={low <= -0.5}>
          접힌 곡선 왼쪽 이동
        </button>
        <button type="button" onClick={() => pan(1)} disabled={high >= 1.5}>
          접힌 곡선 오른쪽 이동
        </button>
        <button type="button" onClick={reset}>
          접힌 곡선 전체 보기
        </button>
        <span role="status" data-testid="fold-zoom">
          ×{view.zoom}
        </span>
      </div>
      <p
        data-testid="fold-result"
        data-period={result.periodDays}
        data-revision={result.revision}
      >
        그래프 주기 {number.format(result.periodDays)}일 · 유효 관측점{" "}
        {number.format(data.points.length)}개 · 밝기 ({fluxUnit})
      </p>
      <figure className="fold-figure">
        <div className="fold-y-axis" aria-hidden="true">
          {[1, 0.5, 0].map((r) => (
            <span key={r}>
              {number.format(domain[0] + r * (domain[1] - domain[0]))}
            </span>
          ))}
        </div>
        <div
          ref={plot}
          className="fold-plot"
          tabIndex={0}
          role="group"
          aria-label="접힌 곡선 그래프"
          aria-describedby={hintId}
          data-view-start={low}
          data-view-end={high}
          data-y-min={domain[0]}
          data-y-max={domain[1]}
          data-point-count={data.points.length}
          onKeyDown={keyDown}
          onDoubleClick={reset}
          onPointerMove={(event) => {
            if (event.pointerType === "touch") return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width,
              y = (event.clientY - rect.top) / rect.height;
            let closest: number | null = null,
              distance = 12 ** 2;
            for (let i = 0; i < data.points.length; i++)
              for (let repeat = -1; repeat <= 1; repeat++) {
                const phase = result.phases[i] + repeat;
                if (phase < low || phase >= high) continue;
                const dx = ((phase - low) / (high - low) - x) * rect.width;
                const dy =
                  (1 -
                    (data.points[i].flux - domain[0]) /
                      (domain[1] - domain[0]) -
                    y) *
                  rect.height;
                const d = dx * dx + dy * dy;
                if (d < distance) {
                  distance = d;
                  closest = i;
                }
              }
            setInspected(closest);
          }}
          onPointerLeave={() => setInspected(null)}
        >
          <canvas ref={canvas} aria-hidden="true" />
        </div>
        <div className="fold-x-axis" aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((r) => (
            <span key={r}>{tick.format(low + r * (high - low))}</span>
          ))}
        </div>
        <figcaption>
          반복 위상 · 같은 관측점을 두 주기에 반복 표시합니다.
        </figcaption>
      </figure>
      <p id={hintId}>
        휠은 포인터 기준 가로 확대, +/−는 중앙 기준 확대·축소, 0·더블클릭은 전체
        보기입니다. 최대 {MAX_FOLD_ZOOM}배까지 확대하며 미세 조정 중에는 배율과
        보는 위치를 유지합니다. ←/→로 보기 이동, ↑/↓로 원본 순서의 관측값을
        확인합니다.
      </p>
      <p className="fold-inspector" role="status">
        {point
          ? `관측점 ${inspected! + 1}/${data.points.length} · Sector ${point.sector} · BTJD ${number.format(point.btjd)} · 위상 ${number.format(result.phases[inspected!])} · 밝기 ${number.format(point.flux)}`
          : "관측점에 포인터를 올리거나 그래프에서 ↑/↓를 눌러 수치를 확인하세요."}
      </p>
    </>
  );
}
