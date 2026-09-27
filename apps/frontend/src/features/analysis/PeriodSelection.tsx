import { useAnalysisStage } from "./analysis-stage";
import { usePhaseDraft, useRetryDraft } from "./AnalysisSession";
import { useCallback, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { PeriodogramChart } from "./PeriodogramChart";
import type { AnalysisContext, CurveData } from "./analysis-data";
import { FoldedCurvePanel } from "./FoldedCurvePanel";
import { useAnalysisFold } from "./AnalysisSession";
import { AnalysisJudgment } from "./AnalysisJudgment";
import { AnalysisDraftPersistence } from "./AnalysisDraftPersistence";
import type { PeriodogramViewport } from "./analysis-judgment";
import { useClassicAnalysisEmits } from "../../cinema/analysis-classic/classic-bridge";
import { useCinemaCopy } from "./cinema-copy";
import {
  choosePeriod,
  fineTunePeriod,
  periodChange,
  sliderPeriod,
  stepPeriod,
  type PeriodChoice,
  type PeriodSelection,
  type PeriodSelectionChange,
  type ReadyPeriodogram,
} from "./period-selection";

const format = new Intl.NumberFormat("ko-KR", { maximumSignificantDigits: 12 });

function PeriodTune({
  selection,
  onTune,
}: {
  selection: PeriodSelection;
  onTune: (period: number) => void;
}) {
  const sliderId = useId(),
    hintId = useId();
  const { stage } = useAnalysisStage();
  const cinema = useCinemaCopy();
  const [error, setError] = useState("");
  const apply = (period: number) => {
    try {
      onTune(period);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const step = (direction: -1 | 1, coarse = false) =>
    apply(stepPeriod(selection, direction, coarse));
  const sliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
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
    if (event.key === "Home") apply(selection.minimum);
    else if (event.key === "End") apply(selection.maximum);
    else
      step(
        ["ArrowRight", "ArrowUp", "PageUp"].includes(event.key) ? 1 : -1,
        event.key === "PageUp" || event.key === "PageDown",
      );
  };
  if (selection.step === null || selection.fineStep === null)
    return (
      <p>
        직접 선택한 주기의 미세 조정은 아직 지원하지 않습니다. 값을 바꾸려면 새
        주기를 선택해 주세요.
      </p>
    );
  return (
    <div className="period-selection-controls">
      {cinema ? (
        <p id={hintId}>
          조정 범위 {cinema.format.periodDays(selection.minimum, 3)} ~{" "}
          {cinema.format.periodDays(selection.maximum, 3)}
        </p>
      ) : (
        <p id={hintId}>
          허용 범위 {format.format(selection.minimum)}~
          {format.format(selection.maximum)}일
          {` · 조정 간격 ${format.format(selection.fineStep)}일`}
          {` · Page 키 ${format.format(selection.step)}일`}
        </p>
      )}
      <label htmlFor={sliderId}>반복 주기 미세 조정</label>
      <input
        id={sliderId}
        name="period-fine-tune-slider"
        type="range"
        disabled={stage !== 1}
        min={selection.minimum}
        max={selection.maximum}
        step="any"
        value={selection.periodDays}
        aria-describedby={hintId}
        aria-valuetext={
          cinema
            ? (cinema.format.periodDays(selection.periodDays, 3) ?? undefined)
            : `${format.format(selection.periodDays)}일`
        }
        onChange={(event) =>
          apply(sliderPeriod(selection, event.currentTarget.valueAsNumber))
        }
        onKeyDown={sliderKey}
      />
      <p role="status">{error}</p>
    </div>
  );
}

export function PeriodSelectionWorkspace({
  data,
  context,
  curve,
  onPeriodChange,
}: {
  data: ReadyPeriodogram;
  context: AnalysisContext;
  curve: CurveData;
  onPeriodChange?: (change: PeriodSelectionChange) => void;
}) {
  const session = useAnalysisFold();
  const { draft: retryDraft, resume } = useRetryDraft();
  const { stage } = useAnalysisStage();
  const { state: phase } = usePhaseDraft();
  const cinema = useCinemaCopy();
  useClassicAnalysisEmits(context.ticId, data);
  const viewport = useRef<PeriodogramViewport>({
    minDays: data.periodogram.periodMinDays,
    maxDays: data.periodogram.periodMaxDays,
  });
  const trackViewport = useCallback((next: PeriodogramViewport) => {
    viewport.current = next;
  }, []);
  const { state, dispatch } = session;
  const change = state.change;
  const revision = useRef(0);
  const begin = useCallback(
    (
      kind: PeriodSelectionChange["kind"],
      selection: PeriodSelection,
      resetView?: boolean,
    ) => {
      const next = {
        ...periodChange(data, null, kind, selection),
        revision: ++revision.current,
      };
      dispatch({ type: "begin", change: next, resetView });
      onPeriodChange?.(next);
      return next;
    },
    [data, dispatch, onPeriodChange],
  );
  const select = useCallback(
    (choice: PeriodChoice) => {
      begin("reselect", choosePeriod(data, choice));
    },
    [data, begin],
  );
  const tune = (period: number) => {
    const previous = change;
    if (!previous || previous.selection.periodDays === period) return;
    begin("fine-tune", fineTunePeriod(previous.selection, period));
  };
  const retry = () => {
    if (!state.request) return;
    begin(
      state.request.change.kind,
      state.request.change.selection,
      state.request.resetView,
    );
  };
  return (
    <>
      <AnalysisDraftPersistence
        context={context}
        data={data}
        onRestore={(selection) => begin("reselect", selection)}
      />
      <PeriodogramChart
        data={data}
        onSelect={select}
        selectedPeriod={change?.selection.periodDays ?? null}
        onViewportChange={trackViewport}
        initialViewport={
          !resume ? retryDraft?.draft.viewState?.periodogramViewport : undefined
        }
      />
      <FoldedCurvePanel
        curve={curve}
        session={session}
        onRetry={retry}
        context={context}
        periodogram={data}
      >
        <section className="period-selection" aria-label="선택 주기">
          <div className="period-selection-row">
            {cinema ? (
              <>
                <span>
                  주기{" "}
                  {change
                    ? cinema.format.periodDays(change.selection.periodDays, 3)
                    : "— 일"}
                </span>
                <span>
                  {phase.range
                    ? `선택 위상 ${cinema.format.phaseRange(phase.range.phaseStart, phase.range.phaseEnd)}`
                    : "구간 선택 전"}
                </span>
              </>
            ) : (
              <>
                <span>
                  주기{" "}
                  {change
                    ? `${change.selection.periodDays.toFixed(6)}일`
                    : "— 일"}
                </span>
                <span>
                  {phase.range
                    ? `선택 위상 ${phase.range.phaseStart.toFixed(4)}–${phase.range.phaseEnd.toFixed(4)}`
                    : "구간 선택 전"}
                </span>
              </>
            )}
          </div>
          <p
            className="analysis-sr-only"
            data-testid="selected-period"
            data-period={change?.selection.periodDays}
            data-source={
              change ? String(change.selection.sourcePeakGridIndex) : undefined
            }
            data-operation={change?.kind}
            data-revision={change?.revision}
          >
            {change
              ? `${format.format(change.selection.periodDays)}일 · ${change.selection.sourcePeakGridIndex === null ? "직접 선택" : "추천 봉우리 선택"} · ${change.kind === "reselect" ? "새 주기 선택" : "미세 조정"}`
              : "추천 봉우리나 그래프의 주기를 선택해 주세요."}
          </p>
          {change ? (
            <PeriodTune
              key={state.inputKey}
              selection={change.selection}
              onTune={tune}
            />
          ) : (
            <input
              aria-label="반복 주기 미세 조정"
              type="range"
              disabled
              value={50}
              readOnly
            />
          )}
        </section>
        <p className="fold-stage-hint">
          {stage === 1
            ? change
              ? "슬라이더로 주기를 조절하세요. 구간은 다음 단계에서 선택합니다."
              : "주기를 선택하면 접힌 곡선을 확인할 수 있어요."
            : stage === 2
              ? "드래그로 구간 선택 · 양 끝 핸들로 조절 · Shift+드래그로 보기 이동"
              : "그래프 조회 가능 · 구간 수정은 상단 2 구간 선택에서"}
        </p>
      </FoldedCurvePanel>
      <AnalysisJudgment
        context={context}
        getViewport={() => viewport.current}
      />
    </>
  );
}
