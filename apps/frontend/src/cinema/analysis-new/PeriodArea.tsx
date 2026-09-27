import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { PeriodogramViewport } from "../../features/analysis/analysis-judgment";
import {
  sliderPeriod,
  stepPeriod,
  type PeriodChoice,
  type PeriodSelectionChange,
  type ReadyPeriodogram,
} from "../../features/analysis/period-selection";
import {
  buildPeriodPlot,
  clampPeriodView,
  FULL_PERIOD_VIEW,
  indexAtFraction,
  periodAtFraction,
  periodFraction,
  periodViewBounds,
  zoomPeriodView,
  type PeriodView,
} from "../../features/analysis/periodogram-view";
import { periodStrength } from "../analysis/bridge";
import {
  maxPower,
  periodDays as periodText,
  strength as strengthOf,
  strengthText,
} from "../analysis/format";
import { drawPeriodogram, prepareCanvas } from "./draw";
import { useElementSize } from "./hooks";
import {
  format,
  moveCursor,
  periodKeyStep,
  periodPlotY,
  placeRankTags,
} from "./model";

export type AreaState = "active" | "ready" | "idle";

/**
 * Period: recommended peaks, a direct pick on the graph, and the fine-tune
 * slider inside the server's range. The classic rules hold: the period can
 * only change while choosing the period (stage 1), direct picks cannot be
 * fine-tuned, and every change re-folds the curve.
 */
export function PeriodArea({
  data,
  change,
  editable,
  lockReason,
  areaState,
  inputKey,
  onChoose,
  onTune,
  onReopen,
  onViewportChange,
  initialViewport,
  strip,
}: {
  data: ReadyPeriodogram;
  /** The latest requested period (may still be folding). */
  change: PeriodSelectionChange | null;
  /** Stage 1 and no submission lock. */
  editable: boolean;
  /** Why the period cannot change now (shown when a pick is refused). */
  lockReason: string | null;
  areaState: AreaState;
  /** Fold session input key: resets the slider after a rollback. */
  inputKey: number;
  onChoose: (choice: PeriodChoice) => void;
  onTune: (period: number) => void;
  /** Back to choosing the period (only offered when not editable). */
  onReopen: (() => void) | null;
  onViewportChange: (viewport: PeriodogramViewport) => void;
  initialViewport?: PeriodogramViewport;
  strip: ReactNode;
}) {
  const { periodogram, candidates } = data;
  const plotModel = useMemo(() => buildPeriodPlot(periodogram), [periodogram]);
  // Drawn and read as 세기 (0..1, the strongest peak = 1), as the classic
  // cinema chart does; choosing still uses the server's grid and periods.
  const display = useMemo(() => {
    const max = maxPower(periodogram.power);
    return {
      plot: {
        ...plotModel,
        grid: {
          ...periodogram,
          power: periodogram.power.map((power) => strengthOf(power, max)),
        },
        yMin: 0,
        yMax: 1,
      },
      candidates: {
        ...candidates,
        peaks: candidates.peaks.map((peak) => ({
          ...peak,
          power: strengthOf(peak.power, max),
        })),
      },
    };
  }, [plotModel, periodogram, candidates]);
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
  const current = clampPeriodView(view);
  const { low, high } = periodViewBounds(current);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const plot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(plot);
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    view: PeriodView;
    moved: boolean;
  } | null>(null);
  const hintId = useId();
  const sliderId = useId();
  const sliderHintId = useId();
  const selection = change?.selection ?? null;
  const tunable =
    selection !== null &&
    selection.step !== null &&
    selection.fineStep !== null;
  const strength = selection
    ? periodStrength(data, selection.periodDays)
    : null;

  useEffect(() => {
    onViewportChange({
      minDays: periodAtFraction(periodogram, low),
      maxDays: periodAtFraction(periodogram, high),
    });
  }, [low, high, periodogram, onViewportChange]);

  const { zoom, center } = current;
  useLayoutEffect(() => {
    const ctx = canvas.current && prepareCanvas(canvas.current, size);
    if (ctx)
      drawPeriodogram(
        ctx,
        display.plot,
        display.candidates,
        { zoom, center },
        size.width,
        size.height,
      );
  }, [display, zoom, center, size]);

  // Wheel zoom only while the graph has focus, so the panel still scrolls.
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (document.activeElement !== element || event.ctrlKey || event.metaKey)
        return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setView((value) =>
        zoomPeriodView(
          value,
          event.deltaY < 0 ? 1.25 : 0.8,
          Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const refuse = () => {
    setMessage(lockReason ?? "주기를 바꾸려면 ‘주기 다시 고르기’를 누르세요.");
  };
  const choose = (choice: PeriodChoice) => {
    if (!editable) return refuse();
    try {
      onChoose(choice);
      setMessage("");
      // Arrows go back to fine-tuning the new period.
      setCursor(null);
    } catch (cause) {
      setMessage((cause as Error).message);
    }
  };
  const tune = (period: number) => {
    if (!editable) return refuse();
    try {
      onTune(period);
      setMessage("");
    } catch (cause) {
      setMessage((cause as Error).message);
    }
  };

  const fractionAt = (clientX: number) => {
    const rect = plot.current!.getBoundingClientRect();
    return low + ((clientX - rect.left) / rect.width) * (high - low);
  };
  const visibleCells = Math.max(1, (high - low) * (periodogram.nPeriods - 1));
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === "Escape") {
      setCursor(null);
      return;
    }
    if (["+", "=", "-", "0"].includes(key)) {
      event.preventDefault();
      if (key === "0") setView(FULL_PERIOD_VIEW);
      else setView((value) => zoomPeriodView(value, key === "-" ? 0.5 : 2));
      return;
    }
    if (key === "Enter") {
      if (cursor === null) return;
      event.preventDefault();
      choose({ kind: "direct", periodDays: plotModel.periods[cursor] });
      return;
    }
    const tuning = [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(key);
    if (!tuning) return;
    event.preventDefault();
    // A peak's period: arrows fine-tune it inside the server's range.
    if (tunable && cursor === null) {
      if (!editable) return refuse();
      const next = periodKeyStep(selection, key, event.shiftKey);
      if (next !== null && next !== selection!.periodDays) tune(next);
      return;
    }
    // Otherwise the arrows move a cursor on the grid; Enter picks it directly.
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key))
      return;
    const fallback = indexAtFraction(
      periodogram,
      selection
        ? periodFraction(periodogram, selection.periodDays)
        : current.center,
    );
    const stepCells = Math.max(1, Math.round(visibleCells / 200));
    const delta =
      (["ArrowRight", "ArrowUp"].includes(key) ? 1 : -1) *
      stepCells *
      (event.shiftKey ? 10 : 1);
    const next = moveCursor(cursor, fallback, delta, periodogram.nPeriods);
    setCursor(next);
    // Keep the cursor in view.
    const fraction = next / (periodogram.nPeriods - 1);
    if (fraction < low || fraction > high)
      setView((value) => clampPeriodView({ ...value, center: fraction }));
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target as HTMLElement).closest("button")
    )
      return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      width: event.currentTarget.getBoundingClientRect().width,
      view: current,
      moved: false,
    };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active && active.id === event.pointerId) {
      if (Math.abs(event.clientX - active.x) > 5) active.moved = true;
      if (active.moved && active.view.zoom > 1)
        setView(
          clampPeriodView({
            ...active.view,
            center:
              active.view.center -
              (event.clientX - active.x) / active.width / active.view.zoom,
          }),
        );
      return;
    }
    if (event.pointerType === "touch") return;
    setHover(indexAtFraction(periodogram, fractionAt(event.clientX)));
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    drag.current = null;
    if (!active || active.id !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.moved) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      return;
    choose({
      kind: "direct",
      periodDays: periodAtFraction(periodogram, fractionAt(event.clientX)),
    });
  };

  const shown = cursor ?? hover;
  const position = (fraction: number) =>
    ((fraction - low) / (high - low)) * 100;
  const selectedAt = selection
    ? periodFraction(periodogram, selection.periodDays)
    : null;
  // Rank labels in px, inside the plot and apart (model.placeRankTags).
  const peakByRank = new Map(display.candidates.peaks.map((p) => [p.rank, p]));
  const tags =
    size.width > 0 && size.height > 0
      ? placeRankTags(
          display.candidates.peaks
            .map((peak) => ({
              rank: peak.rank,
              x:
                (position(peak.gridIndex / (periodogram.nPeriods - 1)) / 100) *
                size.width,
              y: periodPlotY(peak.power, size.height),
            }))
            .filter((peak) => peak.x >= 0 && peak.x <= size.width),
          {
            width: size.width,
            height: size.height,
            avoidX:
              selectedAt === null
                ? null
                : (position(selectedAt) / 100) * size.width,
          },
        )
      : [];
  const sliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!selection || !tunable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    if (event.key === "Home") tune(selection.minimum);
    else if (event.key === "End") tune(selection.maximum);
    else
      tune(
        stepPeriod(
          selection,
          ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key) ? 1 : -1,
          event.key === "PageUp" || event.key === "PageDown",
        ),
      );
  };

  return (
    <section
      className="cx-area"
      data-area="period"
      data-state={areaState}
      aria-label="반복 주기"
    >
      {strip}
      <div className="cx-row">
        <h2 className="cx-label">
          주기
          <em>
            {!selection
              ? "봉우리를 고르세요"
              : editable
                ? tunable
                  ? "← → 미세 조정"
                  : "직접 고른 주기"
                : "고정됨"}
          </em>
        </h2>
        <span className="cx-ro" data-testid="cx-period-readout">
          {selection ? (
            <>
              <b>{format.period(selection.periodDays)}</b>일
              {strength !== null && (
                <span title="이 주기의 신호 세기. 가장 강한 봉우리를 1로 둔 값입니다.">
                  {" "}
                  · 세기 <b>{format.strength(strength)}</b>
                </span>
              )}
            </>
          ) : (
            "주기 —"
          )}
        </span>
      </div>
      <div className="cx-chips" role="group" aria-label="추천 봉우리">
        {[...candidates.peaks]
          .sort((a, b) => a.rank - b.rank)
          .map((peak) => {
            const pressed = selection?.sourcePeakGridIndex === peak.gridIndex;
            return (
              <button
                key={peak.gridIndex}
                type="button"
                className="cx-chip"
                aria-label={`${peak.rank}위 봉우리 선택`}
                aria-pressed={pressed}
                aria-disabled={!editable || undefined}
                title={`주기 ${periodText(peak.periodDays, 3)} · 세기 ${strengthText(strengthOf(peak.power, maxPower(periodogram.power)))}`}
                onClick={() =>
                  choose({ kind: "peak", gridIndex: peak.gridIndex })
                }
              >
                <span>{peak.rank}위</span>
                <b>{format.period(peak.periodDays)}</b>
              </button>
            );
          })}
        <button
          type="button"
          className="cx-chip cx-chip-direct"
          aria-pressed={
            selection !== null && selection.sourcePeakGridIndex === null
          }
          aria-disabled={!editable || undefined}
          aria-describedby={hintId}
          onClick={() => {
            if (!editable) return refuse();
            plot.current?.focus({ preventScroll: true });
            setCursor(
              (value) =>
                value ??
                indexAtFraction(
                  periodogram,
                  selection
                    ? periodFraction(periodogram, selection.periodDays)
                    : current.center,
                ),
            );
            setMessage(
              "그래프를 누르거나 ←/→로 옮긴 뒤 Enter로 주기를 직접 고르세요.",
            );
          }}
        >
          직접 선택
        </button>
        {onReopen && (
          <button type="button" className="cx-link" onClick={onReopen}>
            주기 다시 고르기
          </button>
        )}
        {current.zoom > 1 && (
          <button
            type="button"
            className="cx-link cx-push"
            aria-label="주기도 전체 보기"
            onClick={() => {
              setView(FULL_PERIOD_VIEW);
              setCursor(null);
            }}
          >
            전체 ×{current.zoom.toFixed(current.zoom < 10 ? 1 : 0)}
          </button>
        )}
      </div>
      <div
        ref={plot}
        className="cx-plot cx-period-plot"
        role="group"
        tabIndex={0}
        aria-label="주기도 그래프"
        aria-describedby={hintId}
        data-testid="cx-periodogram"
        data-view-start={low}
        data-view-end={high}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          if (!drag.current) setHover(null);
        }}
        onDoubleClick={() => setView(FULL_PERIOD_VIEW)}
        onKeyDown={keyDown}
      >
        <canvas ref={canvas} aria-hidden="true" />
        {tags.map((tag) => {
          const peak = peakByRank.get(tag.rank)!;
          return (
            <span
              key={peak.gridIndex}
              className="cx-peak-tag"
              aria-hidden="true"
              data-rank={tag.rank}
              data-side={tag.side}
              data-pressed={selection?.sourcePeakGridIndex === peak.gridIndex}
              style={{ left: `${tag.x}px`, top: `${tag.y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={() =>
                choose({ kind: "peak", gridIndex: peak.gridIndex })
              }
            >
              {tag.rank}
            </span>
          );
        })}
        {selectedAt !== null && selectedAt >= low && selectedAt <= high && (
          <span
            className="cx-pline"
            aria-hidden="true"
            style={{ left: `${position(selectedAt)}%` }}
          />
        )}
        {shown !== null && (
          <>
            <span
              className="cx-pcursor"
              aria-hidden="true"
              style={{
                left: `${position(shown! / (periodogram.nPeriods - 1))}%`,
              }}
            />
            <span
              className="cx-ptip"
              role="status"
              data-testid="cx-period-cursor"
              style={{
                left: `${Math.max(8, Math.min(92, position(shown! / (periodogram.nPeriods - 1))))}%`,
              }}
            >
              {periodText(plotModel.periods[shown!], 3)} · 세기{" "}
              {strengthText(display.plot.grid.power[shown!])}
            </span>
          </>
        )}
      </div>
      <p id={hintId} className="cx-sr">
        추천 봉우리 버튼으로 주기를 고릅니다. 그래프를 누르면 그 주기를 직접
        고릅니다. 그래프에 포커스한 뒤 봉우리 주기는 ←/→로 미세 조정하고 Shift는
        격자 한 칸, Home/End는 허용 범위 끝입니다. 직접 고를 때는 ←/→로 위치를
        옮긴 뒤 Enter를 누릅니다. +/−로 확대·축소, 0은 전체 보기입니다. 음영은
        관측 기간 절반을 넘는 주기, 보라 점선은 이미 찾은 신호의 주기입니다.
        세기는 가장 강한 봉우리를 1로 둔 값입니다.
      </p>
      <div className="cx-tune">
        {selection && tunable ? (
          <>
            <label htmlFor={sliderId} className="cx-sr">
              반복 주기 미세 조정
            </label>
            <input
              key={inputKey}
              id={sliderId}
              name="period-fine-tune-slider"
              type="range"
              disabled={!editable}
              min={selection.minimum}
              max={selection.maximum}
              step="any"
              value={selection.periodDays}
              aria-describedby={sliderHintId}
              aria-valuetext={periodText(selection.periodDays, 3) ?? undefined}
              onChange={(event) => {
                try {
                  tune(
                    sliderPeriod(selection, event.currentTarget.valueAsNumber),
                  );
                } catch (cause) {
                  setMessage((cause as Error).message);
                }
              }}
              onKeyDown={sliderKey}
            />
            <span id={sliderHintId} className="cx-ro cx-tune-range">
              {format.period(selection.minimum)} –{" "}
              {format.period(selection.maximum)}일
              <span className="cx-sr">
                {" 조정 범위. 방향키는 한 칸씩, Page 키는 크게 움직입니다."}
              </span>
            </span>
          </>
        ) : selection ? (
          <p className="cx-note">
            직접 선택한 주기의 미세 조정은 아직 지원하지 않습니다. 값을 바꾸려면
            새 주기를 선택해 주세요.
          </p>
        ) : (
          <>
            <input
              aria-label="반복 주기 미세 조정"
              type="range"
              disabled
              value={50}
              readOnly
            />
            <span className="cx-ro cx-tune-range">허용 범위 —</span>
          </>
        )}
      </div>
      <p className="cx-note" role="status" data-testid="cx-period-message">
        {message}
      </p>
    </section>
  );
}
