import { useCallback, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { PeriodogramChart } from "./PeriodogramChart";
import type { AnalysisContext, CurveData } from "./analysis-data";
import { FoldedCurvePanel } from "./FoldedCurvePanel";
import { useAnalysisFold } from "./AnalysisSession";
import { AnalysisJudgment, AnalysisSteps } from "./AnalysisJudgment";
import { AnalysisDraftPersistence } from "./AnalysisDraftPersistence";
import type { PeriodogramViewport } from "./analysis-judgment";
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
  const numberId = useId(),
    sliderId = useId(),
    hintId = useId(),
    errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const apply = (period: number) => {
    try {
      onTune(period);
      input.current!.value = String(period);
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const field = input.current!;
    const period = field.valueAsNumber;
    if (
      !Number.isFinite(period) ||
      period < selection.minimum ||
      period > selection.maximum
    ) {
      setError(
        "허용 범위 안의 주기를 입력해 주세요. 다른 범위는 새 주기 선택에서 골라 주세요.",
      );
      field.focus();
      return;
    }
    apply(period);
  };
  const step = (direction: -1 | 1) => apply(stepPeriod(selection, direction));
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
    else step(["ArrowRight", "ArrowUp", "PageUp"].includes(event.key) ? 1 : -1);
  };
  if (selection.step === null)
    return (
      <p>
        직접 선택한 주기의 미세 조정은 아직 지원하지 않습니다. 값을 바꾸려면 새
        주기를 선택해 주세요.
      </p>
    );
  return (
    <div className="period-selection-controls">
      <p id={hintId}>
        허용 범위 {format.format(selection.minimum)}~
        {format.format(selection.maximum)}일
        {` · 조정 간격 ${format.format(selection.step)}일`}
      </p>
      <label htmlFor={sliderId}>반복 주기 미세 조정</label>
      <input
        id={sliderId}
        name="period-fine-tune-slider"
        type="range"
        min={selection.minimum}
        max={selection.maximum}
        step="any"
        value={selection.periodDays}
        aria-describedby={hintId}
        aria-valuetext={`${format.format(selection.periodDays)}일`}
        onChange={(event) =>
          apply(sliderPeriod(selection, event.currentTarget.valueAsNumber))
        }
        onKeyDown={sliderKey}
      />
      <div
        className="periodogram-toolbar"
        role="group"
        aria-label="미세 조정 간격 이동"
      >
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={selection.periodDays <= selection.minimum}
        >
          한 간격 줄이기
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={selection.periodDays >= selection.maximum}
        >
          한 간격 늘리기
        </button>
      </div>
      <form className="period-selection-form" onSubmit={submit} noValidate>
        <label htmlFor={numberId}>미세 조정 주기 (일)</label>
        <input
          ref={input}
          id={numberId}
          name="fine-tune-period-days"
          type="number"
          inputMode="decimal"
          autoComplete="off"
          required
          min={selection.minimum}
          max={selection.maximum}
          step="any"
          defaultValue={String(selection.periodDays)}
          aria-invalid={Boolean(error)}
          aria-describedby={`${hintId} ${errorId}`}
        />
        <button type="submit">미세 조정 적용</button>
      </form>
      <p id={errorId} role="status" className="period-selection-error">
        {error}
      </p>
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
      <AnalysisSteps />
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
      />
      <section className="period-selection" aria-label="선택 주기">
        <h3>선택 주기</h3>
        <p
          role="status"
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
        ) : null}
      </section>
      <FoldedCurvePanel
        curve={curve}
        session={session}
        onRetry={retry}
        context={context}
        periodogram={data}
      />
      <AnalysisJudgment
        context={context}
        getViewport={() => viewport.current}
      />
    </>
  );
}
