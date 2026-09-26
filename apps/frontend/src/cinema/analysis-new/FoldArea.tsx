import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type {
  AnalysisContext,
  CurveData,
} from "../../features/analysis/analysis-data";
import {
  emptyPhaseDraft,
  useAnalysisFold,
  usePhaseDraft,
} from "../../features/analysis/AnalysisSession";
import { useSustained } from "../../features/analysis/fold-progress";
import {
  clampFoldView,
  foldFluxDomain,
  fullFoldView,
  MAX_FOLD_ZOOM,
  zoomFoldView,
  type FoldView,
} from "../../features/analysis/folded-curve";
import type {
  PeriodSelectionChange,
  ReadyPeriodogram,
} from "../../features/analysis/period-selection";
import {
  previewPhaseSelection,
  type PhaseRange,
  type PhaseSelectionResult,
  type SelectionLimits,
} from "../../features/analysis/phase-selection";
import { drawFold, prepareCanvas } from "./draw";
import { useElementSize } from "./hooks";
import {
  foldMessage,
  format,
  handleStep,
  keyboardWindow,
  phaseAt,
  windowStats,
} from "./model";
import type { AreaState } from "./PeriodArea";

type Handle = "phaseStart" | "phaseEnd";
type Drag = {
  pointerId: number;
  anchor: number;
  handle: Handle | null;
  before: PhaseRange | null;
  beforePreview: PhaseSelectionResult | null;
  change: PeriodSelectionChange;
  low: number;
  high: number;
  pan: boolean;
  clientX: number;
  width: number;
  view: FoldView;
  moved: boolean;
};

const precise = new Intl.NumberFormat("ko-KR", {
  maximumSignificantDigits: 10,
});

export type SelectionContract = {
  limits: SelectionLimits | null;
  error: string;
};

/**
 * Folded curve and the phase window. Folding runs in the classic worker
 * (FoldClient via useFoldSession); the window uses the classic draft and the
 * server's width rules (getSelectionLimits, previewPhaseSelection).
 *
 * Drag draws a new window, the two edge handles adjust it (arrow keys too),
 * Shift+drag pans and the wheel zooms up to MAX_FOLD_ZOOM. Starting a window
 * from the period stage moves on to the window stage, like the classic
 * "이 주기로 구간 선택".
 */
export function FoldArea({
  context,
  data,
  curve,
  stage,
  go,
  locked,
  contract,
  areaState,
  onRetryFold,
  emptyRuleNote,
}: {
  context: AnalysisContext;
  data: ReadyPeriodogram;
  curve: Extract<CurveData, { kind: "ready" }>;
  stage: 1 | 2 | 3 | 4;
  go: (next: 1 | 2 | 3) => void;
  locked: boolean;
  contract: SelectionContract;
  areaState: AreaState;
  onRetryFold: () => void;
  /** The rules forbid a window without observations (allowEmptyPhaseSpan). */
  emptyRuleNote: boolean;
}) {
  const fold = useAnalysisFold();
  const { input, state: foldState, ready, cancel, setView } = fold;
  const { state, setState } = usePhaseDraft();
  const { success, status, view } = foldState;
  const shown =
    success &&
    input.data &&
    success.result.dataId === input.data.dataId &&
    curve.kind === "ready"
      ? { data: input.data, result: success.result, change: success.change }
      : null;
  const change = shown?.change ?? null;
  const pending = status === "pending";
  const slow = useSustained(pending);
  const canEdit =
    ready && contract.limits !== null && !locked && change !== null;
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
  const plot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const startHandle = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const size = useElementSize(plot);
  const hintId = useId();
  const statusId = useId();
  const points = shown?.data.points ?? null;
  const phases = shown?.result.phases ?? null;
  const flux = useMemo(
    () => (points ? Float64Array.from(points, (point) => point.flux) : null),
    [points],
  );
  const domain = useMemo(
    () => (points ? foldFluxDomain(points) : ([0, 1] as [number, number])),
    [points],
  );
  const { zoom, center } = view;
  useLayoutEffect(() => {
    if (!phases || !flux || !canvas.current) return;
    const ctx = prepareCanvas(canvas.current, size);
    if (ctx)
      drawFold(
        ctx,
        phases,
        flux,
        domain,
        { zoom, center },
        size.width,
        size.height,
      );
  }, [phases, flux, domain, zoom, center, size]);

  useEffect(() => {
    if (state.focus) startHandle.current?.focus({ preventScroll: true });
  }, [state.focus]);
  useEffect(() => {
    const active = drag.current;
    if (active && ((!canEdit && !active.pan) || active.change !== change))
      drag.current = null;
  }, [canEdit, change]);

  // Wheel zoom around the pointer, as in the classic chart.
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      if (!element.dataset.ready) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      );
      setView((value) =>
        zoomFoldView(value, event.deltaY < 0 ? 2 : 0.5, ratio),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [setView]);

  /** Same draft update as the classic selection model. */
  const apply = useCallback(
    (range: PhaseRange, finish: boolean) => {
      if (!change) return;
      const result = previewPhaseSelection(
        context,
        data,
        change,
        range.phaseStart,
        range.phaseEnd,
      );
      setState((previous) => ({
        ...previous,
        range,
        preview: result,
        dragging: !finish,
        committed: finish ? range : previous.committed,
        committedPreview: finish ? result : previous.committedPreview,
        confirmed: finish ? null : previous.confirmed,
        review: finish ? null : previous.review,
        message: !finish
          ? previous.message
          : result?.kind === "invalid"
            ? result.issues[0].message
            : "위상 구간을 선택했습니다. 서버 검증 전의 선택값입니다.",
      }));
    },
    [context, data, change, setState],
  );
  /** Editing the window always happens in the window stage. */
  const enterWindowStage = () => {
    if (stage !== 2) go(2);
  };

  const cancelDrag = () => {
    const active = drag.current;
    drag.current = null;
    if (!active || active.change !== change) return;
    if (!active.handle) plot.current?.focus({ preventScroll: true });
    if (active.pan) {
      setView(() => active.view);
      return;
    }
    setState((previous) => ({
      ...previous,
      range: active.before,
      committed: active.before,
      preview: active.beforePreview,
      committedPreview: active.beforePreview,
      dragging: false,
      message: "드래그를 취소하고 이전 선택으로 돌아갔습니다.",
    }));
  };
  const pointerPhase = (clientX: number) => {
    const rect = plot.current!.getBoundingClientRect();
    return phaseAt(clientX - rect.left, rect.width, low, high);
  };
  const begin = (event: PointerEvent<HTMLElement>, handle: Handle | null) => {
    const pan = handle === null && event.shiftKey;
    if (
      !shown ||
      event.button !== 0 ||
      !event.isPrimary ||
      drag.current ||
      (!pan && !canEdit)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    (handle ? event.currentTarget : plot.current)?.focus({
      preventScroll: true,
    });
    drag.current = {
      pointerId: event.pointerId,
      anchor: pointerPhase(event.clientX),
      handle,
      before: state.range,
      beforePreview: state.preview,
      change: change!,
      low,
      high,
      pan,
      clientX: event.clientX,
      width: plot.current!.getBoundingClientRect().width,
      view,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>, finish: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const release = () => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    };
    if ((!canEdit && !active.pan) || active.change !== change) {
      drag.current = null;
      return;
    }
    if (!active.moved && Math.abs(event.clientX - active.clientX) >= 3) {
      active.moved = true;
      // A real edit (not a stray click) moves on to the window stage.
      if (!active.pan) enterWindowStage();
    }
    if (!active.moved) {
      if (finish) release();
      return;
    }
    if (active.pan) {
      if (view.zoom !== active.view.zoom) {
        drag.current = null;
        return;
      }
      setView(() =>
        clampFoldView({
          zoom: active.view.zoom,
          center:
            active.view.center -
            ((event.clientX - active.clientX) / active.width) *
              (active.high - active.low),
        }),
      );
      if (finish) release();
      return;
    }
    // A changed viewport invalidates the pointer-to-phase mapping.
    if (active.low !== low || active.high !== high) {
      cancelDrag();
      return;
    }
    const phase = pointerPhase(event.clientX);
    const range =
      active.handle && active.before
        ? {
            ...active.before,
            [active.handle]: Math.max(
              -0.5,
              Math.min(
                1.5,
                active.before[active.handle] + phase - active.anchor,
              ),
            ),
          }
        : {
            phaseStart: Math.min(active.anchor, phase),
            phaseEnd: Math.max(active.anchor, phase),
          };
    apply(range, finish);
    if (finish) {
      release();
      if (!active.handle)
        setState((previous) => ({ ...previous, focus: previous.focus + 1 }));
    }
  };
  const handleKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    handle: Handle,
  ) => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (
      !canEdit ||
      !state.range ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !event.key.startsWith("Arrow")
    )
      return;
    event.preventDefault();
    enterWindowStage();
    const direction = ["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1;
    apply(
      {
        ...state.range,
        [handle]: handleStep(
          state.range[handle],
          direction,
          event.shiftKey,
          low,
          high,
        ),
      },
      true,
    );
  };
  const plotKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (drag.current) {
        event.preventDefault();
        cancelDrag();
      }
      return;
    }
    if (event.target !== event.currentTarget || !shown) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (
      !["+", "=", "-", "0", "Home", "ArrowLeft", "ArrowRight"].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    if (event.key === "+" || event.key === "=")
      setView((value) => zoomFoldView(value, 2));
    else if (event.key === "-") setView((value) => zoomFoldView(value, 0.5));
    else if (event.key === "0" || event.key === "Home")
      setView(() => fullFoldView);
    else
      setView((value) =>
        clampFoldView({
          ...value,
          center:
            value.center +
            ((event.key === "ArrowLeft" ? -1 : 1) * 0.4) / value.zoom,
        }),
      );
  };
  const startKeyboardWindow = () => {
    if (!canEdit || !contract.limits) return;
    enterWindowStage();
    apply(keyboardWindow(contract.limits, view.center), true);
    setState((previous) => ({ ...previous, focus: previous.focus + 1 }));
  };
  const clearWindow = () => {
    if (!canEdit) return;
    setState((previous) => ({
      ...emptyPhaseDraft,
      editingStep: 2,
      judgment: previous.judgment,
    }));
  };

  const preview =
    ready && state.preview?.kind === "preview" ? state.preview : null;
  const range = state.range;
  const stats = useMemo(
    () => (phases && flux && range ? windowStats(phases, flux, range) : null),
    [phases, flux, range],
  );
  const invalid = state.range !== null && state.preview?.kind === "invalid";
  const position = (phase: number) => ((phase - low) / (high - low)) * 100;
  const problem =
    input.error ||
    !input.data?.points.length ||
    status === "error" ||
    status === "cancelled";
  const statusText = problem
    ? foldMessage({
        inputError: input.error,
        points: input.data?.points.length ?? 0,
        status,
        message: foldState.message,
        hasSuccess: Boolean(success),
        hasChange: Boolean(foldState.change),
      })
    : slow
      ? "선택한 주기로 곡선을 접고 있습니다… 계산이 끝나면 구간 선택·판단·제출을 진행할 수 있습니다."
      : "";
  const limits = contract.limits;
  const periodDays = change?.selection.periodDays ?? null;

  return (
    <section
      className="cx-area"
      data-area="window"
      data-state={areaState}
      aria-label="구간"
    >
      <div className="cx-row">
        <h2 className="cx-label">
          구간
          <em>
            {!shown || locked
              ? ""
              : state.range
                ? stage >= 3
                  ? "다시 드래그하면 바뀝니다"
                  : "핸들로 다듬기"
                : "떨어지는 곳을 드래그"}
          </em>
        </h2>
        <div className="cx-tools" role="group" aria-label="접힌 곡선 보기 조작">
          <button
            type="button"
            className="cx-icon"
            aria-label="접힌 곡선 축소"
            disabled={!shown || view.zoom <= 1}
            onClick={() => setView((value) => zoomFoldView(value, 0.5))}
          >
            −
          </button>
          <span className="cx-ro" data-testid="cx-fold-zoom">
            ×{view.zoom}
          </span>
          <button
            type="button"
            className="cx-icon"
            aria-label="접힌 곡선 확대"
            disabled={!shown || view.zoom >= MAX_FOLD_ZOOM}
            onClick={() => setView((value) => zoomFoldView(value, 2))}
          >
            +
          </button>
          <button
            type="button"
            className="cx-link"
            aria-label="접힌 곡선 전체 보기"
            disabled={!shown}
            onClick={() => setView(() => fullFoldView)}
          >
            전체
          </button>
        </div>
      </div>
      <div
        ref={plot}
        className="cx-plot cx-fold-plot"
        role="group"
        tabIndex={shown ? 0 : -1}
        aria-label="접힌 곡선 그래프"
        aria-describedby={hintId}
        data-testid="cx-fold"
        data-ready={shown ? "true" : undefined}
        data-fold-ready={ready}
        data-folding={pending || undefined}
        data-can-edit={canEdit}
        data-view-start={low}
        data-view-end={high}
        data-dragging={state.dragging || undefined}
        onKeyDown={plotKey}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest(".cx-handle")) return;
          setView(() => fullFoldView);
        }}
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={(event) => move(event, false)}
        onPointerUp={(event) => move(event, true)}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={() => {
          if (drag.current) cancelDrag();
        }}
      >
        <canvas ref={canvas} aria-hidden="true" />
        {pending && <span className="cx-progress" aria-hidden="true" />}
        {!shown && (
          <p className="cx-empty">
            {pending
              ? "곡선을 접고 있습니다"
              : "주기를 고르면 여기서 곡선이 접힙니다"}
          </p>
        )}
        {shown && state.range && (
          <>
            <div className="cx-band-clip" aria-hidden="true">
              {[-2, -1, 0, 1, 2].map((repeat) => {
                const a =
                  Math.min(state.range!.phaseStart, state.range!.phaseEnd) +
                  repeat;
                const b =
                  Math.max(state.range!.phaseStart, state.range!.phaseEnd) +
                  repeat;
                if (b < low || a > high) return null;
                return (
                  <div
                    key={repeat}
                    className="cx-band"
                    data-invalid={invalid || undefined}
                    data-primary={repeat === 0 || undefined}
                    style={{
                      left: `${position(a)}%`,
                      width: `${Math.max(0.2, position(b) - position(a))}%`,
                    }}
                  />
                );
              })}
            </div>
            {(["phaseStart", "phaseEnd"] as const).map((handle, index) => {
              const value = state.range![handle];
              const outside = value < low || value > high;
              return (
                <button
                  key={handle}
                  ref={index === 0 ? startHandle : undefined}
                  type="button"
                  role="slider"
                  className={`cx-handle cx-handle-${index}`}
                  data-outside={outside || undefined}
                  style={{
                    left: `clamp(8px, ${position(value)}%, calc(100% - 8px))`,
                  }}
                  disabled={!canEdit}
                  aria-label={index === 0 ? "위상 구간 시작" : "위상 구간 끝"}
                  aria-orientation="horizontal"
                  aria-valuemin={-0.5}
                  aria-valuemax={1.5}
                  aria-valuenow={value}
                  aria-valuetext={`${precise.format(value)}${outside ? " (보기 밖, 전체 보기로 확인)" : ""}`}
                  aria-invalid={invalid}
                  aria-describedby={`${hintId} ${statusId}`}
                  onKeyDown={(event) => handleKey(event, handle)}
                  onPointerDown={(event) => begin(event, handle)}
                  onPointerMove={(event) => move(event, false)}
                  onPointerUp={(event) => move(event, true)}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={() => {
                    if (drag.current) cancelDrag();
                  }}
                >
                  <span className="cx-sr">{index === 0 ? "시작" : "끝"}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
      <p id={hintId} className="cx-sr">
        드래그하면 새 구간을 고르고, Shift+드래그하면 보기를 옮깁니다. 휠이나
        +/−로 최대 {MAX_FOLD_ZOOM}배까지 확대하고 0이나 더블클릭으로 전체 보기를
        합니다. ←/→는 보기 이동입니다. 시작·끝 핸들에서 방향키는 보기 폭의
        1/1000, Shift+방향키는 10배 움직입니다. Esc는 드래그를 취소합니다.
      </p>
      <dl className="cx-stats" data-testid="cx-window-readouts">
        <div>
          <dt>지속 시간</dt>
          <dd data-value={preview?.durationPreviewHours}>
            {preview ? (
              <>
                <b>{format.hours(preview.durationPreviewHours)}</b>시간
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>평균 감소 (추정)</dt>
          <dd
            data-value={stats?.depth ?? undefined}
            title="구간 안과 밖의 평균 밝기 차이입니다. 화면 미리보기이며 제출하지 않습니다."
          >
            {preview && stats?.depth != null ? (
              <>
                <b>{format.depth(stats.depth)}</b>%
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>기준 시각</dt>
          <dd data-value={preview?.epochPreviewBtjd}>
            {preview ? (
              <>
                <b>{format.btjd(preview.epochPreviewBtjd)}</b> BTJD
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>위상</dt>
          <dd
            data-testid="cx-window-phase"
            data-valid={Boolean(preview)}
            data-start={preview?.selection.phaseStart}
            data-end={preview?.selection.phaseEnd}
          >
            {state.range ? (
              <b>
                {format.phase(state.range.phaseStart)}–
                {format.phase(state.range.phaseEnd)}
              </b>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      <div className="cx-foot">
        <span className="cx-ro cx-limits">
          {limits && periodDays
            ? `허용 ${format.hours(limits.minWindowDays * 24)}–${format.hours(limits.maxWindowDays * 24)}시간`
            : ""}
          <span className="cx-sr">
            {limits
              ? ` · 허용 위상 폭 ${precise.format(limits.minPhaseWidth)}~${precise.format(limits.maxPhaseWidth)}. 범위를 벗어나면 핸들로 조정해 주세요.`
              : ""}
          </span>
        </span>
        {canEdit && !state.range && (
          <button
            type="button"
            className="cx-link"
            onClick={startKeyboardWindow}
          >
            구간 선택 시작
          </button>
        )}
        {canEdit && state.range && (
          <button type="button" className="cx-link" onClick={clearWindow}>
            구간 지우기
          </button>
        )}
      </div>
      <p
        id={statusId}
        className="cx-note"
        role="status"
        data-testid="cx-window-status"
        data-tone={invalid ? "bad" : undefined}
      >
        {contract.error ||
          (invalid
            ? state.message
            : preview && emptyRuleNote && stats?.inside === 0
              ? "이 구간에는 관측점이 없습니다. 빈 구간은 서버 규칙상 제출할 수 없습니다."
              : state.range && !invalid && state.message && !locked
                ? "미리보기 값입니다. 제출하면 서버가 다시 계산하고 검증합니다."
                : "")}
      </p>
      {(problem || slow) && (
        <div
          className="cx-alert"
          role={problem ? "alert" : "status"}
          data-testid="cx-fold-status"
        >
          <p>{statusText}</p>
          <button
            type="button"
            className="cx-link"
            onClick={pending ? cancel : onRetryFold}
            disabled={
              !pending && !(status === "error" || status === "cancelled")
            }
          >
            {pending ? "접기 취소" : "접기 다시 계산"}
          </button>
        </div>
      )}
    </section>
  );
}
