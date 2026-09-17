import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, KeyboardEvent, PointerEvent } from "react";
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
const countFormat = new Intl.NumberFormat("ko-KR");

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
  const model = useMemo(() => buildPeriodPlot(periodogram), [periodogram]);
  const ranked = useMemo(
    () => [...candidates.peaks].sort((a, b) => a.rank - b.rank),
    [candidates],
  );
  const [view, setView] = useState<PeriodView>(FULL_PERIOD_VIEW);
  useEffect(() => {
    const { low, high } = periodViewBounds(view);
    onViewportChange?.({
      minDays: periodAtFraction(periodogram, low),
      maxDays: periodAtFraction(periodogram, high),
    });
  }, [view, periodogram, onViewportChange]);
  const [inspection, setInspection] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [picking, setPicking] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const periodInput = useRef<HTMLInputElement>(null);
  const periodId = useId(),
    periodHintId = useId(),
    periodErrorId = useId();
  const plot = useRef<HTMLDivElement>(null),
    indexInput = useRef<HTMLInputElement>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
    width: number;
    view: PeriodView;
  } | null>(null);
  const hintId = useId(),
    summaryId = useId(),
    indexId = useId(),
    indexHintId = useId();
  const current = clampPeriodView(view),
    { low, high } = periodViewBounds(current);
  const currentRef = useRef(current);
  currentRef.current = current;
  const choose = (choice: PeriodChoice) => {
    try {
      onSelect(choice);
      setPicking(false);
      setSelectionError("");
    } catch (error) {
      setSelectionError((error as Error).message);
    }
  };
  const zoom = (factor: number) =>
    setView((old) => zoomPeriodView(old, factor));
  const reset = () => {
    setView(FULL_PERIOD_VIEW);
    setInspection(null);
    setAnnouncement("주기도 전체 범위를 표시합니다.");
  };
  const pan = (direction: number) =>
    setView((old) =>
      clampPeriodView({
        ...old,
        center: old.center + (direction * 0.2) / old.zoom,
      }),
    );
  const inspect = (index: number, announce = false) => {
    setInspection(index);
    if (announce)
      setAnnouncement(
        `격자 ${index}, 주기 ${format.format(model.periods[index])}일, power ${format.format(periodogram.power[index])}`,
      );
  };
  useEffect(() => {
    const element = plot.current!;
    const wheel = (event: WheelEvent) => {
      // Preserve normal page scrolling and browser pinch/zoom unless the plot owns focus.
      if (document.activeElement !== element || event.ctrlKey || event.metaKey)
        return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const anchor = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      );
      setView((old) =>
        zoomPeriodView(old, event.deltaY < 0 ? 1.25 : 0.8, anchor),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current) {
      const initial = gesture.current;
      if (initial.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - initial.x, event.clientY - initial.y) > 5)
        initial.moved = true;
      setView(
        clampPeriodView({
          ...initial.view,
          center:
            initial.view.center -
            (event.clientX - initial.x) / initial.width / initial.view.zoom,
        }),
      );
    } else if (event.pointerType === "mouse") {
      const bounds = event.currentTarget.getBoundingClientRect();
      inspect(
        indexAtFraction(
          periodogram,
          low + ((event.clientX - bounds.left) / bounds.width) * (high - low),
        ),
      );
    }
  };
  const endGesture = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
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
        "Enter",
        "Escape",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    if (event.key === "Escape") setPicking(false);
    else if (event.key === "Enter")
      choose({
        kind: "direct",
        periodDays:
          inspection === null
            ? periodAtFraction(periodogram, current.center)
            : model.periods[inspection],
      });
    else if (event.key === "+" || event.key === "=") zoom(2);
    else if (event.key === "-") zoom(0.5);
    else if (event.key === "0" || event.key === "Home") reset();
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      pan(event.key === "ArrowLeft" ? -1 : 1);
    else {
      const first = Math.ceil(low * (periodogram.nPeriods - 1)),
        last = Math.floor(high * (periodogram.nPeriods - 1));
      inspect(
        Math.max(
          first,
          Math.min(
            last,
            inspection === null || inspection < first || inspection > last
              ? first
              : inspection + (event.key === "ArrowDown" ? 1 : -1),
          ),
        ),
        true,
      );
    }
  };
  const inspectInput = (event: FormEvent) => {
    event.preventDefault();
    const input = indexInput.current!;
    if (!input.reportValidity()) return;
    const index = input.valueAsNumber;
    inspect(index, true);
    const center = index / (periodogram.nPeriods - 1);
    if (center < low || center > high)
      setView(clampPeriodView({ ...current, center }));
  };
  return (
    <>
      <p id={summaryId}>
        {countFormat.format(periodogram.nPeriods)}점 · 주기{" "}
        {format.format(periodogram.periodMinDays)}~
        {format.format(periodogram.periodMaxDays)}일 · 로그 축 · 세로축: power
      </p>
      <figure className="periodogram-overview">
        <figcaption>
          전체 주기도 · 테두리: 아래 그래프에 표시 중인 범위
        </figcaption>
        <div className="periodogram-overview-plot">
          <PlotCanvas
            model={model}
            candidates={candidates}
            zoom={1}
            center={0.5}
            overview
          />
          <div
            className="periodogram-window"
            aria-hidden="true"
            style={{ left: `${low * 100}%`, width: `${(high - low) * 100}%` }}
          />
        </div>
      </figure>
      <div
        role="group"
        aria-label="주기도 조작"
        className="periodogram-toolbar"
      >
        <button
          type="button"
          onClick={() => zoom(2)}
          disabled={current.zoom >= 64}
        >
          확대
        </button>
        <button
          type="button"
          onClick={() => zoom(0.5)}
          disabled={current.zoom <= 1}
        >
          축소
        </button>
        <button type="button" onClick={() => pan(-1)} disabled={low <= 1e-12}>
          왼쪽 이동
        </button>
        <button
          type="button"
          onClick={() => pan(1)}
          disabled={high >= 1 - 1e-12}
        >
          오른쪽 이동
        </button>
        <button type="button" onClick={reset}>
          전체 보기
        </button>
        <button
          type="button"
          aria-pressed={picking}
          onClick={() => setPicking((value) => !value)}
        >
          그래프에서 주기 고르기
        </button>
        <span
          data-testid="periodogram-zoom"
          aria-live="polite"
          aria-atomic="true"
        >
          ×{format.format(current.zoom)}
        </span>
      </div>
      <figure className="periodogram-detail">
        <div className="periodogram-y-axis" aria-hidden="true">
          {[model.yMax, (model.yMax + model.yMin) / 2, model.yMin].map(
            (power, index) => (
              <span key={index}>{format.format(power)}</span>
            ),
          )}
        </div>
        <div
          className={`periodogram-plot${picking ? " periodogram-picking" : ""}`}
          ref={plot}
          tabIndex={0}
          role="group"
          aria-label="주기도 그래프"
          aria-describedby={`${summaryId} ${hintId}`}
          data-point-count={periodogram.nPeriods}
          data-view-start={low}
          data-view-end={high}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            if (event.pointerType === "mouse") event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              moved: false,
              width: event.currentTarget.getBoundingClientRect().width,
              view: currentRef.current,
            };
          }}
          onPointerMove={move}
          onPointerUp={(event) => {
            const initial = gesture.current;
            if (
              picking &&
              initial?.pointerId === event.pointerId &&
              !initial.moved
            ) {
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - bounds.left) / bounds.width;
              if (
                x >= 0 &&
                x <= 1 &&
                event.clientY >= bounds.top &&
                event.clientY <= bounds.bottom
              )
                choose({
                  kind: "direct",
                  periodDays: periodAtFraction(
                    periodogram,
                    low + x * (high - low),
                  ),
                });
            }
            endGesture(event);
          }}
          onPointerCancel={endGesture}
          onLostPointerCapture={() => {
            gesture.current = null;
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
          periodFraction(periodogram, selectedPeriod) <= high ? (
            <span
              className="periodogram-selected-line"
              aria-hidden="true"
              style={{
                left: `${((periodFraction(periodogram, selectedPeriod) - low) / (high - low)) * 100}%`,
              }}
            />
          ) : null}
        </div>
        <div className="periodogram-x-axis" aria-hidden="true">
          {[low, (low + high) / 2, high].map((fraction, index) => (
            <span key={index}>
              {format.format(periodAtFraction(periodogram, fraction))}
            </span>
          ))}
        </div>
        <figcaption>
          표시 주기 {format.format(periodAtFraction(periodogram, low))}~
          {format.format(periodAtFraction(periodogram, high))}일
        </figcaption>
      </figure>
      <p className="periodogram-legend">
        실선: power · 번호: 추천 봉우리 순위 · 세로 실선: 선택 주기 · 회색 점선:
        이미 매칭한 주기 · 음영: {format.format(periodogram.baselineHalfDays)}일
        초과, 가려짐이 2번 미만일 수 있어 다음 관측 회차가 필요할 수 있음
      </p>
      <p id={hintId}>
        그래프에 포커스한 뒤 휠·+/−: 확대·축소 · 드래그·←/→: 이동 · ↑/↓: 격자 값
        확인 · Enter: 조회 중인 주기 선택(조회 전에는 화면 중앙) · 0/Home 또는
        더블클릭: 전체 보기. 같은 조작을 위 버튼으로 할 수 있습니다.
      </p>
      <p role="status">
        {picking
          ? "그래프를 한 번 눌러 새 주기를 선택하세요. 드래그는 이동만 합니다. Esc 또는 선택 버튼으로 취소할 수 있습니다."
          : "확대·이동·값 조회는 선택 주기를 바꾸지 않습니다."}
      </p>
      <form className="periodogram-inspector" onSubmit={inspectInput}>
        <label htmlFor={indexId}>조회할 격자 번호</label>
        <input
          ref={indexInput}
          id={indexId}
          name="periodogram-grid-index"
          type="number"
          inputMode="numeric"
          autoComplete="off"
          required
          min={0}
          max={periodogram.nPeriods - 1}
          step={1}
          defaultValue={0}
          aria-describedby={indexHintId}
        />
        <button type="submit">격자 값 확인</button>
        <span id={indexHintId}>
          0~{countFormat.format(periodogram.nPeriods - 1)} · 주기 선택값은
          바뀌지 않습니다.
        </span>
      </form>
      <p className="periodogram-readout" data-testid="periodogram-readout">
        {inspection === null
          ? "그래프의 점을 가리키거나 격자 번호로 주기와 power를 확인하세요."
          : `격자 ${inspection} · 주기 ${format.format(model.periods[inspection])}일 · power ${format.format(periodogram.power[inspection])}`}
      </p>
      <button
        type="button"
        disabled={inspection === null}
        onClick={() => {
          if (inspection !== null)
            choose({ kind: "direct", periodDays: model.periods[inspection] });
        }}
      >
        조회한 주기 선택
      </button>
      <form
        className="period-selection-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const input = periodInput.current!;
          const period = input.valueAsNumber;
          if (
            !Number.isFinite(period) ||
            period < periodogram.periodMinDays ||
            period > periodogram.periodMaxDays
          ) {
            setSelectionError(
              "주기도 전체 범위 안의 유한한 주기를 입력해 주세요.",
            );
            input.focus();
            return;
          }
          choose({ kind: "direct", periodDays: period });
        }}
      >
        <label htmlFor={periodId}>새 주기 (일)</label>
        <input
          ref={periodInput}
          id={periodId}
          name="new-period-days"
          type="number"
          inputMode="decimal"
          autoComplete="off"
          required
          min={periodogram.periodMinDays}
          max={periodogram.periodMaxDays}
          step="any"
          aria-invalid={Boolean(selectionError)}
          aria-describedby={`${periodHintId} ${periodErrorId}`}
        />
        <button type="submit">새 주기 선택</button>
        <span id={periodHintId}>
          {format.format(periodogram.periodMinDays)}~
          {format.format(periodogram.periodMaxDays)}일 · 추천 목록 밖의 주기도
          선택할 수 있습니다.
        </span>
      </form>
      <p id={periodErrorId} role="status" className="period-selection-error">
        {selectionError}
      </p>
      <span
        className="periodogram-sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
      <div className="periodogram-lists">
        <section aria-label="추천 봉우리 목록">
          <h3>추천 봉우리</h3>
          <p>번호는 추천 순위입니다. 위치 보기는 그래프만 확대합니다.</p>
          <ol
            className={ranked.length > 50 ? "periodogram-long-list" : undefined}
          >
            {ranked.map((peak) => (
              <li key={peak.gridIndex} value={peak.rank}>
                <span>
                  {format.format(peak.periodDays)}일 · power{" "}
                  {format.format(peak.power)}
                </span>
                <button
                  type="button"
                  aria-label={`${peak.rank}위 봉우리 위치 보기`}
                  onClick={() => {
                    setView(
                      clampPeriodView({
                        zoom: 8,
                        center: peak.gridIndex / (periodogram.nPeriods - 1),
                      }),
                    );
                    inspect(peak.gridIndex, true);
                  }}
                >
                  위치 보기
                </button>
                <button
                  type="button"
                  aria-label={`${peak.rank}위 봉우리 선택`}
                  onClick={() =>
                    choose({ kind: "peak", gridIndex: peak.gridIndex })
                  }
                >
                  주기 선택
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section aria-label="이미 매칭한 주기 목록">
          <h3>이미 매칭한 주기</h3>
          {candidates.matchedCandidates.length ? (
            <ul
              className={
                candidates.matchedCandidates.length > 50
                  ? "periodogram-long-list"
                  : undefined
              }
            >
              {candidates.matchedCandidates.map((item) => (
                <li key={item.candidateId}>
                  {format.format(item.periodDays)}일
                  {item.periodDays < periodogram.periodMinDays ||
                  item.periodDays > periodogram.periodMaxDays
                    ? " (그래프 범위 밖)"
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>표시할 매칭 주기선이 없습니다.</p>
          )}
        </section>
      </div>
    </>
  );
}
