import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AnalysisContext, CurveData } from "./analysis-data";
import { buildFoldData } from "./fold-data";
import { FoldClient, type FoldResult } from "./fold-client";
import type { PeriodSelectionChange } from "./period-selection";
import { FoldedCurveChart } from "./FoldedCurveChart";

// Provisional liveness guard, not a latency SLA. Reassess with production data in stage 4.
const FOLD_WATCHDOG_MS = 30_000;
type Success = { result: FoldResult; operation: PeriodSelectionChange["kind"] };
export function FoldedCurvePanel({
  context,
  curve,
  change,
}: {
  context: AnalysisContext;
  curve: CurveData;
  change: PeriodSelectionChange | null;
}) {
  const input = useMemo(() => {
    try {
      return { data: buildFoldData(context, curve), error: null };
    } catch (error) {
      return { data: null, error: (error as Error).message };
    }
  }, [context, curve]);
  const client = useRef<FoldClient | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);
  const [status, setStatus] = useState<{
    kind: "idle" | "pending" | "success" | "error" | "cancelled";
    message?: string;
  }>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const resetZoom = useRef(false);
  const headingId = useId();
  useEffect(() => {
    const next = input.data?.points.length
      ? new FoldClient(input.data, { timeoutMs: FOLD_WATCHDOG_MS })
      : null;
    client.current = next;
    setSuccess(null);
    return () => {
      ++sequence.current;
      next?.dispose();
      if (client.current === next) client.current = null;
    };
  }, [input]);
  useEffect(() => {
    const next = client.current;
    const ticket = ++sequence.current;
    if (!change || !next) {
      setStatus({ kind: "idle" });
      return;
    }
    setStatus({ kind: "pending" });
    if (change.kind === "reselect") resetZoom.current = true;
    next
      .request(change.selection.periodDays)
      .then((result) => {
        if (!result || sequence.current !== ticket || !next.isCurrent(result))
          return;
        setSuccess({
          result,
          operation: resetZoom.current ? "reselect" : change.kind,
        });
        resetZoom.current = false;
        setStatus({ kind: "success" });
      })
      .catch((error: Error) => {
        if (sequence.current === ticket)
          setStatus({ kind: "error", message: error.message });
      });
    return () => {
      ++sequence.current;
    };
  }, [change, input, attempt]);
  const cancel = () => {
    ++sequence.current;
    client.current?.cancel();
    setStatus({ kind: "cancelled" });
  };
  const message = input.error
    ? input.error
    : !input.data?.points.length
      ? "접을 유효 관측 데이터가 없습니다. 신호가 없다는 뜻은 아닙니다."
      : !change
        ? "주기를 선택하면 현재 곡선을 접어 표시합니다."
        : status.kind === "pending"
          ? "선택한 주기로 곡선을 접고 있습니다… 마지막 성공 그래프가 있으면 그대로 표시합니다."
          : status.kind === "error"
            ? `접기에 실패했습니다. ${status.message} 다시 계산하거나 다른 주기를 선택해 주세요.`
            : status.kind === "cancelled"
              ? "접기를 취소했습니다. 다시 계산하거나 다른 주기를 선택해 주세요."
              : "선택한 주기로 곡선을 접었습니다.";
  return (
    <section className="fold-panel" aria-labelledby={headingId}>
      <h3 id={headingId}>주기로 접은 밝기 변화</h3>
      <p role="status" data-testid="fold-status">
        {message}
      </p>
      {status.kind === "pending" && (
        <button type="button" onClick={cancel}>
          접기 취소
        </button>
      )}
      {(status.kind === "error" || status.kind === "cancelled") && (
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>
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
          operation={success.operation}
          fluxUnit={curve.fluxUnit}
        />
      ) : null}
      <p>구간 선택·판단·제출은 아직 연결되지 않았습니다.</p>
    </section>
  );
}
