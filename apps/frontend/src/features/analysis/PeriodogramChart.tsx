import { useAnalysisStage } from "./analysis-stage";
import { useCinemaCopy } from "./cinema-copy";
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
  rankLabels = "all",
  selectedPeriod = null,
}: {
  model: PeriodPlot;
  candidates: CandidatePeaks;
  zoom: number;
  center: number;
  overview?: boolean;
  rankLabels?: "all" | "avoid";
  /** With "avoid" (cinema): rank labels keep clear of this period's line. */
  selectedPeriod?: number | null;
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
      rankLabels,
      selectedPeriod,
    );
  }, [
    model,
    candidates,
    zoom,
    center,
    overview,
    size,
    rankLabels,
    selectedPeriod,
  ]);
  return <canvas ref={ref} aria-hidden="true" />;
});

export function PeriodogramChart({
  data,
  onSelect,
  selectedPeriod,
  onViewportChange,
  initialViewport,
}: {
  data: Extract<PeriodogramLoad, { kind: "ready" }>;
  onSelect: (choice: PeriodChoice) => void;
  selectedPeriod: number | null;
  onViewportChange?: (viewport: PeriodogramViewport) => void;
  initialViewport?: PeriodogramViewport;
}) {
  const { periodogram, candidates } = data;
  const { stage, go } = useAnalysisStage();
  // 시네마 화면: 주기도 값을 가장 센 봉우리 = 1인 「세기」(0..1, 음수는 0)로
  // 그린다. 선택·조회는 원래 값과 격자를 그대로 쓴다.
  const cinema = useCinemaCopy();
  // 시네마 화면: 구간 선택·판단·제출값 확인 단계에서 주기도를 누르면(Enter
  // 포함) '주기 선택' 단계로 돌아가 그 주기를 고른다. 단계 줄의 '주기 선택'을
  // 누르고 고른 것과 같다(같은 go(1)과 같은 선택). 새 주기의 접기가 끝나면
  // 구간·판단 초안은 늘 그렇듯 비워진다. develop 화면은 1단계에서만 고른다.
  const reselect = cinema !== null && stage !== 1;
  const display = useMemo(() => {
    if (!cinema) return null;
    const { maxPower, strength } = cinema.format;
    const max = maxPower(periodogram.power);
    return {
      periodogram: {
        ...periodogram,
        power: periodogram.power.map((power) => strength(power, max)),
      },
      candidates: {
        ...candidates,
        peaks: candidates.peaks.map((peak) => ({
          ...peak,
          power: strength(peak.power, max),
        })),
      },
    };
  }, [cinema, periodogram, candidates]);
  const model = useMemo(
    () =>
      display
        ? { ...buildPeriodPlot(display.periodogram), yMin: 0, yMax: 1 }
        : buildPeriodPlot(periodogram),
    [periodogram, display],
  );
  const shown = display?.candidates ?? candidates;
  const [view, setView] = useState<PeriodView>(() => {
    if (!initialViewport) return FULL_PERIOD_VIEW;
    const low = Math.max(
      0,
      periodFraction(periodogram, initialViewport.minDays),
    );
    const high = Math.min(
      1,
      periodFraction(periodogram, initialViewport.maxDays),
    );
    return high > low
      ? clampPeriodView({ zoom: 1 / (high - low), center: (low + high) / 2 })
      : FULL_PERIOD_VIEW;
  });
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
    readoutId = useId(),
    reselectId = `${hintId}-reselect`;
  useEffect(() => {
    onViewportChange?.({
      minDays: periodAtFraction(periodogram, low),
      maxDays: periodAtFraction(periodogram, high),
    });
  }, [low, high, periodogram, onViewportChange]);
  const choose = (choice: PeriodChoice) => {
    if (stage !== 1 && !reselect) return;
    try {
      onSelect(choice);
      if (reselect) go(1);
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
          {cinema
            ? ["1", "0.5", "0"].map((v) => <span key={v}>{v}</span>)
            : [model.yMax, (model.yMax + model.yMin) / 2, model.yMin].map(
                (v, i) => <span key={i}>{v.toFixed(2)}</span>,
              )}
        </div>
        <div
          ref={plot}
          className="periodogram-plot"
          role="group"
          aria-label="주기도 그래프"
          aria-describedby={reselect ? `${reselectId} ${hintId}` : hintId}
          tabIndex={0}
          data-point-count={periodogram.nPeriods}
          data-view-start={low}
          data-view-end={high}
          data-reselect={reselect ? "true" : undefined}
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
            candidates={shown}
            zoom={current.zoom}
            center={current.center}
            rankLabels={cinema ? "avoid" : "all"}
            selectedPeriod={cinema ? selectedPeriod : null}
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
          {shown.peaks.map((peak) => {
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
                aria-disabled={stage !== 1 && !reselect}
                aria-describedby={
                  [
                    inspection === peak.gridIndex ? readoutId : null,
                    reselect ? reselectId : null,
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
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
              {cinema && display ? (
                <>
                  주기 {cinema.format.periodDays(model.periods[inspection], 3)}
                  <br />
                  세기{" "}
                  {cinema.format.strengthText(
                    display.periodogram.power[inspection],
                  )}
                </>
              ) : (
                <>
                  주기 {format.format(model.periods[inspection])}일<br />
                  power {format.format(periodogram.power[inspection])}
                </>
              )}
            </div>
          )}
        </div>
        <div className="periodogram-x-axis" aria-hidden="true">
          {[low, (low + high) / 2, high].map((v, i) => (
            <span key={i}>
              {cinema
                ? cinema.format.periodTick(periodAtFraction(periodogram, v))
                : Number(periodAtFraction(periodogram, v).toPrecision(4))}
            </span>
          ))}
        </div>
      </figure>
      {cinema ? (
        <>
          <p className="chart-caption">
            주기 (일, 로그 눈금) · 세기 (가장 강한 봉우리 = 1)
            {stage === 1 && " · 봉우리를 눌러 선택"}
          </p>
          {reselect && (
            <p id={reselectId} className="periodogram-reselect-hint">
              그래프를 눌러 주기를 다시 고를 수 있습니다
            </p>
          )}
        </>
      ) : (
        <p className="chart-caption">
          주기 (일·로그) · power · {stage === 1 ? "클릭해 선택" : "조회 전용"}
        </p>
      )}
      <p id={hintId} className="analysis-sr-only">
        봉우리에 Tab으로 이동하고 Enter로 선택합니다. 그래프 +/− 확대·축소,
        드래그·좌우 방향키 이동, 상하 방향키 격자 조회, Enter 직접 선택, 0/Home
        전체 보기. 음영은 관측 기간 절반 초과, 점선은 매칭 주기입니다.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
