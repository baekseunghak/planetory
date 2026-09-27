import resetIcon from "./assets/reset.svg";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { CurveSegment } from "./analysis-data";
import {
  buildTimeCurve,
  clampTimeView,
  drawTimeCurve,
  pointAtDisplay,
  zoomTimeView,
} from "./time-curve";
import type { TimePoint, TimeView } from "./time-curve";
import "./time-curve.css";
import { TransitBands } from "./TransitBands";
import { useCinemaCopy } from "./cinema-copy";

// Adapts the experiment's Canvas/DPR, zoom and pointer-capture approach for segment DTOs.
// No phase selection or scientific recomputation belongs in this time-domain chart.
export function TimeCurveChart({
  segments,
  fluxUnit,
}: {
  segments: CurveSegment[];
  fluxUnit: string;
}) {
  const curve = useMemo(() => buildTimeCurve(segments), [segments]);
  // 시네마 화면: BTJD 대신 관측 시작부터 지난 날, 「섹터」, 밝기 4자리.
  const cinema = useCinemaCopy();
  const origin = curve.segments[0]?.source.startBtjd ?? 0;
  const [view, setView] = useState<TimeView>({
    zoom: 1,
    center: curve.width / 2,
  });
  const [point, setPoint] = useState<TimePoint | null>(null);
  const [size, setSize] = useState({ width: 600, height: 280, dpr: 1 });
  const canvas = useRef<HTMLCanvasElement>(null),
    plot = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ clientX: number; view: TimeView } | null>(null);
  const hintId = useId();
  const current = clampTimeView(view, curve.width);
  const latest = useRef({ curve, view: current });
  latest.current = { curve, view: current };
  const span = curve.width / current.zoom,
    low = current.center - span / 2,
    high = low + span;
  const percent = (x: number) => ((x - low) / span) * 100;
  const reset = () => {
    setView({ zoom: 1, center: curve.width / 2 });
    setPoint(null);
  };
  const zoom = (factor: number) => {
    setView((v) => zoomTimeView(v, curve.width, factor));
    setPoint(null);
  };
  const pan = (direction: number) => {
    setView((v) =>
      clampTimeView(
        { ...v, center: v.center + ((direction * curve.width) / v.zoom) * 0.2 },
        curve.width,
      ),
    );
    setPoint(null);
  };

  useEffect(() => {
    const element = plot.current!;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
      });
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
    update();
    watch();
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      );
      setView(
        zoomTimeView(
          latest.current.view,
          latest.current.curve.width,
          event.deltaY < 0 ? 1.25 : 0.8,
          ratio,
        ),
      );
      setPoint(null);
    };
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
    drawTimeCurve(ctx, curve, current, size.width, size.height);
  }, [curve, current.zoom, current.center, size]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current) {
      const initial = gesture.current;
      const shift =
        (((event.clientX - initial.clientX) /
          plot.current!.getBoundingClientRect().width) *
          curve.width) /
        initial.view.zoom;
      setView(
        clampTimeView(
          { ...initial.view, center: initial.view.center - shift },
          curve.width,
        ),
      );
      setPoint(null);
    } else {
      const rect = plot.current!.getBoundingClientRect();
      setPoint(
        pointAtDisplay(
          curve,
          low + ((event.clientX - rect.left) / rect.width) * span,
        ),
      );
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(2);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(0.5);
    } else if (["0", "Home"].includes(event.key)) {
      event.preventDefault();
      reset();
    } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      pan(event.key === "ArrowLeft" ? -1 : 1);
    } else if (["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const visible = curve.points.filter((p) => p.x >= low && p.x <= high);
      if (!visible.length) {
        setPoint(null);
        return;
      }
      const index = point
        ? visible.findIndex(
            (p) => p.segmentId === point.segmentId && p.index === point.index,
          )
        : -1;
      setPoint(
        visible[
          Math.max(
            0,
            Math.min(
              visible.length - 1,
              index < 0 ? 0 : index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          )
        ],
      );
    }
  };
  return (
    <section className="analysis-time-curve" aria-label="시간 곡선">
      <div className="analysis-time-heading">
        <h2>시간에 따른 밝기 변화</h2>
        <button
          className="chart-icon"
          aria-label="시간 곡선 전체 보기"
          title="시간 곡선 전체 보기"
          onClick={reset}
        >
          <img src={resetIcon} alt="" width="18" height="18" />
        </button>
      </div>
      <span className="analysis-sr-only" data-testid="time-zoom">
        ×{Number(current.zoom.toFixed(2))}
      </span>
      <figure>
        <div className="analysis-time-axis-y" aria-hidden="true">
          {[1, 0.5, 0].map((ratio) => (
            <span key={ratio}>
              {cinema
                ? cinema.format.flux(
                    curve.fluxDomain[0] +
                      ratio * (curve.fluxDomain[1] - curve.fluxDomain[0]),
                  )
                : (
                    curve.fluxDomain[0] +
                    ratio * (curve.fluxDomain[1] - curve.fluxDomain[0])
                  ).toPrecision(7)}
            </span>
          ))}
        </div>
        <div
          className="analysis-time-plot"
          ref={plot}
          tabIndex={0}
          role="group"
          aria-label="시간 곡선 그래프"
          aria-describedby={hintId}
          data-point-count={curve.points.length}
          data-view-start={low}
          data-view-end={high}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = { clientX: event.clientX, view: current };
          }}
          onPointerMove={move}
          onPointerUp={() => {
            gesture.current = null;
          }}
          onPointerCancel={() => {
            gesture.current = null;
          }}
          onLostPointerCapture={() => {
            gesture.current = null;
          }}
          onPointerLeave={() => {
            if (!gesture.current) setPoint(null);
          }}
          onDoubleClick={reset}
          onKeyDown={keyDown}
        >
          <canvas ref={canvas} aria-hidden="true" />
          <TransitBands curve={curve} low={low} high={high} size={size} />
          {curve.segments.map((segment) => {
            const left = Math.max(low, segment.start),
              right = Math.min(high, segment.end);
            if (left >= right) return null;
            return (
              <div
                key={segment.source.segmentId}
                className="analysis-time-sector"
                style={{
                  left: `${percent(left)}%`,
                  width: `${percent(right) - percent(left)}%`,
                }}
              >
                {cinema ? (
                  <span>{cinema.format.sector(segment.source.sector)}</span>
                ) : (
                  <span>Sector {segment.source.sector}</span>
                )}
              </div>
            );
          })}
          {curve.segments.slice(1).map((segment, i) => {
            const x = (curve.segments[i].end + segment.start) / 2;
            return x >= low && x <= high ? (
              <span
                key={segment.source.segmentId}
                className="analysis-time-break"
                style={{ left: `${percent(x)}%` }}
              >
                //
              </span>
            ) : null;
          })}
        </div>
        <div className="analysis-time-axis-x" aria-hidden="true">
          {curve.segments.flatMap((segment) => {
            const left = Math.max(low, segment.start),
              right = Math.min(high, segment.end);
            if (left >= right) return [];
            const count = ((right - left) / span) * size.width > 220 ? 3 : 1;
            return Array.from({ length: count }, (_, i) => {
              const x = left + ((right - left) * (i + 0.5)) / count;
              const btjd = segment.source.startBtjd + x - segment.start;
              return (
                <span
                  key={`${segment.source.segmentId}-${i}`}
                  style={{ left: `${percent(x)}%` }}
                >
                  {cinema ? cinema.format.days(btjd - origin) : btjd.toFixed(5)}
                </span>
              );
            });
          })}
        </div>
        {cinema ? (
          <figcaption>
            관측 시작부터 지난 날 ·{" "}
            <span className="analysis-time-gap-key">음영: 관측값 없음</span> ·
            //: 섹터 사이 시간 간격은 줄여 표시 · 금색 띠: 고른 구간이 반복될
            위치 (읽기 전용)
          </figcaption>
        ) : (
          <figcaption>
            실제 관측 시각 (BTJD) ·{" "}
            <span className="analysis-time-gap-key">음영: 관측값 없음</span> ·
            //: Sector 경계의 시간 간격 축약
            {" · "}금색 띠: 선택 구간의 예상 반복 위치 (읽기 전용)
          </figcaption>
        )}
      </figure>
      <p id={hintId} className="analysis-time-help analysis-sr-only">
        휠·+/−: 확대·축소 · 드래그·←/→: 이동 · ↑/↓: 관측점 확인 · 0/Home: 전체
        보기
      </p>
      <div
        className="analysis-time-readout"
        aria-live="polite"
        aria-atomic="true"
      >
        {cinema
          ? point
            ? `${cinema.format.sector(point.sector)} · 관측 ${cinema.format.days(point.btjd - origin)}째 · 밝기 ${cinema.format.flux(point.flux)}${cinema.format.fluxUnit(fluxUnit) ? ` ${cinema.format.fluxUnit(fluxUnit)}` : ""}`
            : "점에 마우스를 올리거나 그래프에서 ↑/↓ 키로 관측 시점과 밝기를 확인하세요."
          : point
            ? `Sector ${point.sector} · BTJD ${point.btjd} · 밝기 ${point.flux} ${fluxUnit}`
            : "점에 마우스를 올리거나 그래프에서 ↑/↓ 키로 실제 시각과 밝기를 확인하세요."}
      </div>
      <details className="time-gap-details">
        <summary>
          {cinema ? "섹터 사이 실제 시간 간격" : "Sector 경계의 실제 시간 간격"}
        </summary>
        <ul>
          {curve.segments.slice(1).map((segment, i) => {
            const previous = curve.segments[i].source;
            const days =
              segment.source.startBtjd +
              segment.source.binMinutes / 2880 -
              (previous.startBtjd +
                ((previous.nPoints - 0.5) * previous.binMinutes) / 1440);
            return (
              <li key={segment.source.segmentId}>
                {cinema
                  ? `${cinema.format.sector(previous.sector)} → ${segment.source.sector}: ${days >= 0 ? cinema.format.days(days) : "관측 시간 범위 겹침"}`
                  : null}
                {!cinema && (
                  <>
                    Sector {previous.sector} → {segment.source.sector}:{" "}
                    {days >= 0 ? `${days.toFixed(5)}일` : "관측 시간 범위 겹침"}
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {curve.segments.length === 1 && <p>관측 세그먼트가 하나입니다.</p>}
      </details>
    </section>
  );
}
