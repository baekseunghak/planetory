import { useEffect, useId, useState } from "react";
import type { AnalysisContext, CurveData } from "./analysis-data";
import type { ReadyPeriodogram } from "./period-selection";
import { PhaseSelectionProvider } from "./PhaseSelection";
import type { useFoldSession } from "./use-fold-session";
import { FoldedCurveChart } from "./FoldedCurveChart";

// Presentation delay only; the session locks follow-up actions immediately.
const PROGRESS_NOTICE_DELAY_MS = 1000;
const FOLD_GUIDANCE =
  "주기를 조정하면 그래프를 갱신합니다. 그래프에는 마지막 계산 완료 결과를 표시합니다.";

function FoldFeedback({
  pending,
  retry,
  message,
  onAction,
}: {
  pending: boolean;
  retry: boolean;
  message: string;
  onAction: () => void;
}) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!pending) {
      setDelayed(false);
      return;
    }
    const timer = window.setTimeout(
      () => setDelayed(true),
      PROGRESS_NOTICE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pending]);
  // New periods during one pending interval must not restart this timer.
  const showProgress = pending && delayed;
  const showAction = showProgress || retry;
  return (
    <div className="fold-feedback">
      <p role="status" data-testid="fold-status">
        {showProgress
          ? "선택한 주기로 곡선을 접고 있습니다… 계산이 끝나면 구간 선택·판단·제출을 진행할 수 있습니다."
          : message}
      </p>
      <button
        type="button"
        className={showAction ? undefined : "fold-action-idle"}
        disabled={!showAction}
        onClick={onAction}
      >
        {retry ? "접기 다시 계산" : "접기 취소"}
      </button>
    </div>
  );
}

export function FoldedCurvePanel({
  curve,
  session,
  onRetry,
  context,
  periodogram,
}: {
  curve: CurveData;
  session: ReturnType<typeof useFoldSession>;
  onRetry: () => void;
  context: AnalysisContext;
  periodogram: ReadyPeriodogram;
}) {
  const { input, state, ready, cancel, setView } = session;
  const { success, status } = state;
  const headingId = useId();
  const restored = success
    ? " 마지막으로 성공한 주기와 그래프·확대 위치로 복구했습니다."
    : " 아직 성공한 접기 결과가 없습니다.";
  const message = input.error
    ? input.error
    : !input.data?.points.length
      ? "접을 유효 관측 데이터가 없습니다. 신호가 없다는 뜻은 아닙니다."
      : status === "error"
        ? `접기에 실패했습니다. ${state.message}${restored} 다시 계산하면 실패한 주기를 재시도합니다.`
        : status === "cancelled"
          ? `접기를 취소했습니다.${restored} 다시 계산하면 취소한 주기를 재시도합니다.`
          : !state.change
            ? "주기를 선택하면 현재 곡선을 접어 표시합니다."
            : FOLD_GUIDANCE;
  return (
    <section
      className="fold-panel"
      aria-labelledby={headingId}
      data-testid="fold-panel"
      data-fold-ready={ready}
    >
      <h3 id={headingId}>주기로 접은 밝기 변화</h3>
      <FoldFeedback
        pending={status === "pending"}
        retry={status === "error" || status === "cancelled"}
        message={message}
        onAction={status === "pending" ? cancel : onRetry}
      />
      {success &&
      input.data &&
      curve.kind === "ready" &&
      success.result.dataId === input.data.dataId ? (
        <PhaseSelectionProvider
          context={context}
          data={periodogram}
          change={success.change}
          ready={ready}
        >
          <FoldedCurveChart
            data={input.data}
            result={success.result}
            view={state.view}
            setView={setView}
            fluxUnit={curve.fluxUnit}
          />
        </PhaseSelectionProvider>
      ) : null}
      <p>판단·제출은 다음 단계에서 연결합니다.</p>
    </section>
  );
}
