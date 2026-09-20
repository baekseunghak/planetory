import { useAnalysisStage } from "./analysis-stage";
import resetIcon from "./assets/reset.svg";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { PeriodogramLoad } from "./load-periodogram";
import type { CandidatePeaks } from "./periodogram-data";
import type { PeriodChoice } from "./period-selection";
import type { PeriodogramViewport } from "./analysis-judgment";
import {
  buildPeriodPlot,
  clampPeriodView,
  drawPeriodogram,
  FULL_PERIOD_VIEW,
  indexAtFraction,
  periodAtFraction,
  periodFraction,
  periodViewBounds,
  zoomPeriodView,
  type PeriodPlot,
  type PeriodView,
} from "./periodogram-view";

const format = new Intl.NumberFormat("ko-KR", { maximumSignificantDigits: 9 });

const PlotCanvas = memo(function PlotCanvas({
  model,
  candidates,
  zoom,
  center,
  overview = false,
}: {
  model: PeriodPlot;
  candidates: CandidatePeaks;
  zoom: number;
  center: number;
  overview?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });
  useEffect(() => {
    const canvas = ref.current!;
    const measure = () => {
      const bounds = canvas.getBoundingClientRect(),
        dpr = window.devicePixelRatio || 1;
      setSize((previous) =>
        previous.width === bounds.width &&
        previous.height === bounds.height &&
        previous.dpr === dpr
          ? previous
          : { width: bounds.width, height: bounds.height, dpr },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    let resolution: MediaQueryList;
    const watch = () => {
      resolution?.removeEventListener("change", change);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      resolution.addEventListener("change", change);
    };
    const change = () => {
      measure();
      watch();
    };
    measure();
    watch();
    return () => {
      observer.disconnect();
      resolution.removeEventListener("change", change);
    };
  }, []);
  useLayoutEffect(() => {
    const canvas = ref.current!,
      ctx = canvas.getContext("2d");
    if (!ctx || size.width <= 0 || size.height <= 0) return;
    canvas.width = Math.round(size.width * size.dpr);
    canvas.height = Math.round(size.height * size.dpr);
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    drawPeriodogram(
      ctx,
      model,
      candidates,
      { zoom, center },
      size.width,
      size.height,
      overview,
    );
  }, [model, candidates, zoom, center, overview, size]);
  return <canvas ref={ref} aria-hidden="true" />;
});

export function PeriodogramChart({
  data,
  onSelect,
  selectedPeriod,
  onViewportChange,
}: {
  data: Extract<PeriodogramLoad, { kind: "ready" }>;
  onSelect: (choice: PeriodChoice) => void;
  selectedPeriod: number | null;
  onViewportChange?: (viewport: PeriodogramViewport) => void;
}) {
  const { periodogram, candidates } = data;
  const { stage } = useAnalysisStage();
  const model = useMemo(() => buildPeriodPlot(periodogram), [periodogram]);
  const [view, setView] = useState<PeriodView>(FULL_PERIOD_VIEW);
  const [inspection, setInspection] = useState<number | null>(null);
  const [error, setError] = useState("");
  const plot = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    width: number;
    view: PeriodView;
    moved: boolean;
  } | null>(null);
  const current = clampPeriodView(view),
    { low, high } = periodViewBounds(current);
  const hintId = useId(),
    readoutId = useId();
  useEffect(() => {
    onViewportChange?.({
      minDays: periodAtFraction(periodogram, low),
      maxDays: periodAtFraction(periodogram, high),
    });
  }, [low, high, periodogram, onViewportChange]);
  const choose = (choice: PeriodChoice) => {
    if (stage !== 1) return;
    try {
      onSelect(choice);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const reset = () => {
    setView(FULL_PERIOD_VIEW);
    setInspection(null);
  };
  useEffect(() => {
    const el = plot.current!;
    const wheel = (e: WheelEvent) => {
      if (document.activeElement !== el || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) =>
        zoomPeriodView(
          v,
          e.deltaY < 0 ? 1.25 : 0.8,
          Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        ),
      );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const initial = drag.current;
    if (initial) {
      if (initial.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - initial.x, e.clientY - initial.y) > 5)
        initial.moved = true;
      if (initial.moved)
        setView(
          clampPeriodView({
            ...initial.view,
            center:
              initial.view.center -
              (e.clientX - initial.x) / initial.width / initial.view.zoom,
          }),
        );
    } else {
      const r = e.currentTarget.getBoundingClientRect();
      setInspection(
        indexAtFraction(
          periodogram,
          low + ((e.clientX - r.left) / r.width) * (high - low),
        ),
      );
    }
  };
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey)
      return;
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
        "Enter",
        "Escape",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    if (e.key === "Escape") {
      setInspection(null);
      return;
    }
    if (e.key === "Enter") {
      choose({
        kind: "direct",
        periodDays:
          inspection === null
            ? periodAtFraction(periodogram, current.center)
            : model.periods[inspection],
      });
      return;
    }
    if (["0", "Home"].includes(e.key)) {
      reset();
      return;
    }
    if (["+", "=", "-"].includes(e.key)) {
      setView((v) => zoomPeriodView(v, e.key === "-" ? 0.5 : 2));
      return;
    }
    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
      setView((v) =>
        clampPeriodView({
          ...v,
          center: v.center + (e.key === "ArrowLeft" ? -0.2 : 0.2) / v.zoom,
        }),
      );
      return;
    }
    const first = Math.ceil(low * (periodogram.nPeriods - 1)),
      last = Math.floor(high * (periodogram.nPeriods - 1));
    setInspection((i) =>
      Math.max(
        first,
        Math.min(
          last,
          i === null || i < first || i > last
            ? first
            : i + (e.key === "ArrowDown" ? 1 : -1),
        ),
      ),
    );
  };
  return (
    <section className="periodogram-card" aria-label="반복 주기">
      <div className="chart-heading">
        <h2>반복 주기</h2>
        <button
          className="chart-icon"
          aria-label="주기도 전체 보기"
          title="주기도 전체 보기"
          onClick={reset}
        >
          <img src={resetIcon} alt="" width="18" height="18" />
        </button>
      </div>
      <span className="analysis-sr-only" data-testid="periodogram-zoom">
        ×{format.format(current.zoom)}
      </span>
      <figure className="periodogram-detail">
        <div className="periodogram-y-axis" aria-hidden="true">
          {[model.yMax, (model.yMax + model.yMin) / 2, model.yMin].map(
            (v, i) => (
              <span key={i}>{v.toFixed(2)}</span>
            ),
          )}
        </div>
        <div
          ref={plot}
          className="periodogram-plot"
          role="group"
          aria-label="주기도 그래프"
          aria-describedby={hintId}
          tabIndex={0}
          data-point-count={periodogram.nPeriods}
          data-view-start={low}
          data-view-end={high}
          onPointerDown={(e) => {
            if (
              e.button !== 0 ||
              !e.isPrimary ||
              (e.target as HTMLElement).closest("button")
            )
              return;
            e.preventDefault();
            e.currentTarget.focus({ preventScroll: true });
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              id: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              width: e.currentTarget.getBoundingClientRect().width,
              view: current,
              moved: false,
            };
          }}
          onPointerMove={move}
          onPointerUp={(e) => {
            const initial = drag.current;
            drag.current = null;
            if (!initial || initial.id !== e.pointerId) return;
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            if (
              initial.moved ||
              Math.hypot(e.clientX - initial.x, e.clientY - initial.y) > 5
            )
              return;
            const r = e.currentTarget.getBoundingClientRect(),
              x = (e.clientX - r.left) / r.width;
            if (x < 0 || x > 1 || e.clientY < r.top || e.clientY > r.bottom)
              return;
            choose({
              kind: "direct",
              periodDays: periodAtFraction(periodogram, low + x * (high - low)),
            });
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerLeave={() => {
            if (!drag.current) setInspection(null);
          }}
          onDoubleClick={reset}
          onKeyDown={keyDown}
        >
          <PlotCanvas
            model={model}
            candidates={candidates}
            zoom={current.zoom}
            center={current.center}
          />
          {selectedPeriod !== null &&
            periodFraction(periodogram, selectedPeriod) >= low &&
            periodFraction(periodogram, selectedPeriod) <= high && (
              <span
                className="periodogram-selected-line"
                aria-hidden="true"
                style={{
                  left:
                    ((periodFraction(periodogram, selectedPeriod) - low) /
                      (high - low)) *
                      100 +
                    "%",
                }}
              />
            )}
          {candidates.peaks.map((peak) => {
            const x =
              (periodFraction(periodogram, peak.periodDays) - low) /
              (high - low);
            if (x < 0 || x > 1) return null;
            return (
              <button
                key={peak.gridIndex}
                type="button"
                className="peak-target"
                aria-label={peak.rank + "위 봉우리 선택"}
                aria-disabled={stage !== 1}
                aria-describedby={
                  inspection === peak.gridIndex ? readoutId : undefined
                }
                style={{
                  left: x * 100 + "%",
                  top:
                    Math.max(
                      0,
                      Math.min(
                        76,
                        (1 -
                          (peak.power - model.yMin) /
                            (model.yMax - model.yMin)) *
                          100,
                      ),
                    ) + "%",
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerMove={(e) => {
                  e.stopPropagation();
                  setInspection(peak.gridIndex);
                }}
                onFocus={() => setInspection(peak.gridIndex)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setInspection(null);
                  }
                }}
                onBlur={() => setInspection(null)}
                onClick={() =>
                  choose({ kind: "peak", gridIndex: peak.gridIndex })
                }
              >
                <span className="analysis-sr-only">{peak.rank}</span>
              </button>
            );
          })}
          {inspection !== null && (
            <div
              className="periodogram-tooltip"
              id={readoutId}
              role="tooltip"
              data-testid="periodogram-readout"
            >
              주기 {format.format(model.periods[inspection])}일<br />
              power {format.format(periodogram.power[inspection])}
            </div>
          )}
        </div>
        <div className="periodogram-x-axis" aria-hidden="true">
          {[low, (low + high) / 2, high].map((v, i) => (
            <span key={i}>
              {Number(periodAtFraction(periodogram, v).toPrecision(4))}
            </span>
          ))}
        </div>
      </figure>
      <p className="chart-caption">
        주기 (일·로그) · power · {stage === 1 ? "클릭해 선택" : "조회 전용"}
      </p>
      <p id={hintId} className="analysis-sr-only">
        봉우리에 Tab으로 이동하고 Enter로 선택합니다. 그래프 +/− 확대·축소,
        드래그·좌우 방향키 이동, 상하 방향키 격자 조회, Enter 직접 선택, 0/Home
        전체 보기. 음영은 관측 기간 절반 초과, 점선은 매칭 주기입니다.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
