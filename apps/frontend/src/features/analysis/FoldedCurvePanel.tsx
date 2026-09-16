import { useId } from "react";
import type { CurveData } from "./analysis-data";
import type { useFoldSession } from "./use-fold-session";
import { FoldedCurveChart } from "./FoldedCurveChart";

export function FoldedCurvePanel({
  curve,
  session,
  onRetry,
}: {
  curve: CurveData;
  session: ReturnType<typeof useFoldSession>;
  onRetry: () => void;
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
      : status === "pending"
        ? "선택한 주기로 곡선을 접고 있습니다… 마지막 성공 그래프가 있으면 그대로 표시합니다. 계산 중에는 구간 선택·판단·제출을 진행할 수 없습니다."
        : status === "error"
          ? `접기에 실패했습니다. ${state.message}${restored} 다시 계산하면 실패한 주기를 재시도합니다.`
          : status === "cancelled"
            ? `접기를 취소했습니다.${restored} 다시 계산하면 취소한 주기를 재시도합니다.`
            : !state.change
              ? "주기를 선택하면 현재 곡선을 접어 표시합니다."
              : "선택한 주기로 곡선을 접었습니다.";
  return (
    <section
      className="fold-panel"
      aria-labelledby={headingId}
      data-testid="fold-panel"
      data-fold-ready={ready}
    >
      <h3 id={headingId}>주기로 접은 밝기 변화</h3>
      <p role="status" data-testid="fold-status">
        {message}
      </p>
      {status === "pending" && (
        <button type="button" onClick={cancel}>
          접기 취소
        </button>
      )}
      {(status === "error" || status === "cancelled") && (
        <button type="button" onClick={onRetry}>
          접기 다시 계산
        </button>
      )}
      {success &&
      input.data &&
      curve.kind === "ready" &&
      success.result.dataId === input.data.dataId ? (
        <FoldedCurveChart
          data={input.data}
          result={success.result}
          view={state.view}
          setView={setView}
          fluxUnit={curve.fluxUnit}
        />
      ) : null}
      <p>구간 선택·판단·제출은 아직 연결되지 않았습니다.</p>
    </section>
  );
}
