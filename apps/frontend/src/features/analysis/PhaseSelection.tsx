import {
  createContext,
  useContext,
  useId,
  useMemo,
  useRef,
  useEffect,
} from "react";
import type { ReactNode, PointerEvent, KeyboardEvent } from "react";
import type { AnalysisContext } from "./analysis-data";
import type {
  PeriodSelectionChange,
  ReadyPeriodogram,
} from "./period-selection";
import { clampFoldView, type FoldView } from "./folded-curve";
import {
  getSelectionLimits,
  previewPhaseSelection,
  type PhaseRange,
  type PhaseSelectionResult,
} from "./phase-selection";
import {
  usePhaseDraft,
  useCurrentPhasePreview,
  emptyPhaseDraft as empty,
} from "./AnalysisSession";

const format = new Intl.NumberFormat("ko-KR", { maximumSignificantDigits: 10 });
function useSelectionModel(
  context: AnalysisContext,
  data: ReadyPeriodogram,
  change: PeriodSelectionChange,
  ready: boolean,
) {
  const { state, setState } = usePhaseDraft();
  const statusId = useId();
  const contract = useMemo(() => {
    try {
      return { limits: getSelectionLimits(context, data, change), error: "" };
    } catch (error) {
      return { limits: null, error: (error as Error).message };
    }
  }, [context, data, change]);
  const preview = state.preview;
  const enabled = ready && contract.limits !== null;
  const apply = (range: PhaseRange, finish: boolean) => {
    if (!enabled) return;
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
  };
  return {
    state,
    setState,
    contract,
    preview,
    enabled,
    change,
    apply,
    statusId,
  };
}
const SelectionContext = createContext<ReturnType<
  typeof useSelectionModel
> | null>(null);
export function PhaseSelectionProvider({
  context,
  data,
  change,
  ready,
  children,
}: {
  context: AnalysisContext;
  data: ReadyPeriodogram;
  change: PeriodSelectionChange;
  ready: boolean;
  children: ReactNode;
}) {
  const model = useSelectionModel(context, data, change, ready);
  return (
    <SelectionContext.Provider value={model}>
      {children}
    </SelectionContext.Provider>
  );
}
function useSelection() {
  const model = useContext(SelectionContext);
  if (!model) throw new Error("Phase selection requires its provider.");
  return model;
}

export function PhaseSelectionControls({ view }: { view: FoldView }) {
  const { state, setState, contract, preview, enabled, apply, statusId } =
    useSelection();
  const hintId = useId();
  const currentPreview = useCurrentPhasePreview();
  const begin = () => {
    if (!contract.limits) return;
    const { minPhaseWidth, maxPhaseWidth } = contract.limits;
    const width = (minPhaseWidth + maxPhaseWidth) / 2;
    const center = Math.max(
      -0.5 + width / 2,
      Math.min(1.5 - width / 2, view.center),
    );
    apply(
      { phaseStart: center - width / 2, phaseEnd: center + width / 2 },
      true,
    );
    setState((previous) => ({ ...previous, focus: previous.focus + 1 }));
  };
  return (
    <section
      className="phase-selection"
      aria-label="위상 구간 선택"
      aria-describedby={hintId}
    >
      <h4>위상 구간 선택</h4>
      <div className="periodogram-toolbar">
        <button type="button" disabled={!enabled} onClick={begin}>
          구간 선택 시작
        </button>
        <button
          type="button"
          disabled={!enabled || !state.range}
          onClick={() =>
            setState((previous) => ({ ...empty, judgment: previous.judgment }))
          }
        >
          구간 지우기
        </button>
      </div>
      <p id={hintId}>
        그래프에서 드래그하면 구간을 선택하고, Shift+드래그하면 선택값을
        유지하며 좌우로 이동합니다. 키보드로 시작하려면 구간 선택 시작을
        누르세요. 시작·끝 핸들에서 방향키는 현재 보기 폭의 1/1000,
        Shift+방향키는 10배 이동합니다. 확대해도 선택값은 유지됩니다.
      </p>
      {contract.limits && (
        <p>
          허용 위상 폭 {format.format(contract.limits.minPhaseWidth)}~
          {format.format(contract.limits.maxPhaseWidth)}. 범위를 벗어나면 핸들로
          조정해 주세요.
        </p>
      )}
      <p
        data-testid="phase-selection-value"
        data-valid={preview?.kind === "preview"}
        data-start={
          preview?.kind === "preview" ? preview.selection.phaseStart : undefined
        }
        data-end={
          preview?.kind === "preview" ? preview.selection.phaseEnd : undefined
        }
      >
        {preview?.kind === "preview"
          ? `선택 위상 ${format.format(preview.selection.phaseStart)}~${format.format(preview.selection.phaseEnd)}`
          : state.range
            ? "선택한 구간을 확인해 주세요."
            : "아직 선택한 구간이 없습니다."}
      </p>
      <p
        id={statusId}
        className="phase-selection-status"
        role="status"
        data-testid="phase-selection-status"
      >
        {contract.error || state.message}
      </p>
      <div
        className="phase-time-preview"
        data-testid="phase-time-preview"
        data-available={Boolean(currentPreview)}
      >
        <h4>선택 구간의 시간 미리보기</h4>
        <dl>
          <dt>기준 시각 (BTJD)</dt>
          <dd
            data-testid="phase-epoch"
            data-value={currentPreview?.epochPreviewBtjd}
          >
            {currentPreview
              ? format.format(currentPreview.epochPreviewBtjd)
              : "—"}
          </dd>
          <dt>가려진 시간 (시간)</dt>
          <dd
            data-testid="phase-duration"
            data-value={currentPreview?.durationPreviewHours}
          >
            {currentPreview
              ? format.format(currentPreview.durationPreviewHours)
              : "—"}
          </dd>
        </dl>
        <p>
          유효한 구간을 선택하면 시간 곡선에 예상 반복 위치를 표시합니다. 기준
          시각은 BTJD 일 단위이며, 서버가 검증·저장한 최종값이 아닙니다.
        </p>
      </div>
    </section>
  );
}

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
export function PhaseSelectionOverlay({
  view,
  setView,
}: {
  view: FoldView;
  setView: (update: (view: FoldView) => FoldView) => void;
}) {
  const { state, setState, enabled, preview, change, apply, statusId } =
    useSelection();
  const layer = useRef<HTMLDivElement>(null);
  const startHandle = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const hintId = useId();
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
  useEffect(() => {
    if (state.focus) startHandle.current?.focus({ preventScroll: true });
  }, [state.focus]);
  useEffect(() => {
    if (!enabled || drag.current?.change !== change) drag.current = null;
  }, [enabled, change]);
  const coordinate = (event: PointerEvent, from = low, to = high) => {
    const rect = layer.current!.getBoundingClientRect();
    return (
      from +
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) *
        (to - from)
    );
  };
  const cancel = () => {
    const active = drag.current;
    drag.current = null;
    if (active?.change !== change) return;
    if (!active.handle)
      layer.current
        ?.closest<HTMLElement>(".fold-plot")
        ?.focus({ preventScroll: true });
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
  const begin = (event: PointerEvent<HTMLElement>, handle: Handle | null) => {
    const pan = handle === null && event.shiftKey;
    if (
      (!enabled && !pan) ||
      event.button !== 0 ||
      !event.isPrimary ||
      drag.current
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const anchor = coordinate(event);
    drag.current = {
      pointerId: event.pointerId,
      anchor,
      handle,
      before: state.range,
      beforePreview: state.preview,
      change,
      low,
      high,
      pan,
      clientX: event.clientX,
      width: layer.current!.getBoundingClientRect().width,
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
    if ((!enabled && !active.pan) || active.change !== change) {
      drag.current = null;
      return;
    }
    if (Math.abs(event.clientX - active.clientX) >= 3) active.moved = true;
    if (!active.moved) {
      if (finish) {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (!active.handle)
          layer.current
            ?.closest<HTMLElement>(".fold-plot")
            ?.focus({ preventScroll: true });
      }
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
      if (finish) {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        layer.current
          ?.closest<HTMLElement>(".fold-plot")
          ?.focus({ preventScroll: true });
      }
      return;
    }
    // A changed viewport invalidates the pointer-to-phase mapping; discard the gesture.
    if (active.low !== low || active.high !== high) {
      cancel();
      return;
    }
    const phase = coordinate(event);
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
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (!active.handle)
        setState((previous) => ({ ...previous, focus: previous.focus + 1 }));
    }
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>, handle: Handle) => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (
      !enabled ||
      !state.range ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const direction = ["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1;
    const next =
      state.range[handle] +
      ((direction * (high - low)) / 1000) * (event.shiftKey ? 10 : 1);
    apply(
      { ...state.range, [handle]: Math.max(-0.5, Math.min(1.5, next)) },
      true,
    );
  };
  const position = (phase: number) => ((phase - low) / (high - low)) * 100;
  return (
    <div
      ref={layer}
      className="phase-selection-layer"
      data-dragging={state.dragging}
      data-enabled={enabled}
      onPointerMove={(event) => {
        if (
          drag.current ||
          (event.target as HTMLElement).closest(".phase-handle")
        )
          event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest(".phase-handle"))
          event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (drag.current) cancel();
      }}
    >
      <span id={hintId} className="periodogram-sr-only">
        방향키로 핸들을 이동합니다. Shift는 10배 이동, Esc는 드래그 취소입니다.
        보기 밖의 핸들은 전체 보기에서 확인할 수 있습니다.
      </span>
      <div
        className="phase-draw-target"
        tabIndex={-1}
        role="group"
        aria-label="위상 구간 드래그"
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={(event) => move(event, false)}
        onPointerUp={(event) => move(event, true)}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (drag.current) cancel();
        }}
      />
      {state.range && (
        <>
          <div className="phase-band-clip" aria-hidden="true">
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
                  className="phase-band"
                  data-invalid={preview?.kind !== "preview"}
                  style={{
                    left: `${position(a)}%`,
                    width: `${position(b) - position(a)}%`,
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
                className={`phase-handle phase-handle-${index}`}
                style={{
                  left: `clamp(22px, ${position(value)}%, calc(100% - 22px))`,
                }}
                disabled={!enabled}
                aria-label={index === 0 ? "위상 구간 시작" : "위상 구간 끝"}
                aria-orientation="horizontal"
                aria-valuemin={-0.5}
                aria-valuemax={1.5}
                aria-valuenow={value}
                aria-valuetext={`${format.format(value)}${outside ? " (보기 밖, 전체 보기로 확인)" : ""}`}
                aria-invalid={preview?.kind === "invalid"}
                aria-describedby={`${hintId} ${statusId}`}
                onKeyDown={(event) => key(event, handle)}
                onPointerDown={(event) => begin(event, handle)}
                onPointerMove={(event) => move(event, false)}
                onPointerUp={(event) => move(event, true)}
                onPointerCancel={cancel}
                onLostPointerCapture={() => {
                  if (drag.current) cancel();
                }}
              >
                {index === 0 ? "시작" : "끝"}
                {outside ? " ↔" : ""}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
