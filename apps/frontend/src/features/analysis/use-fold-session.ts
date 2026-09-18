import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { AnalysisContext, CurveData } from "./analysis-data";
import { buildFoldData } from "./fold-data";
import { FoldClient } from "./fold-client";
import {
  canUseFold,
  foldSessionReducer,
  initialFoldSession,
} from "./fold-session";
import type { FoldView } from "./folded-curve";

// Provisional liveness guard, not a latency SLA. Reassess with production data.
const FOLD_WATCHDOG_MS = 30_000;

// AnalysisPage keys the parent by curve context; data reloads unmount this workspace.
export function useFoldSession(context: AnalysisContext, curve: CurveData) {
  const input = useMemo(() => {
    try {
      return { data: buildFoldData(context, curve), error: null };
    } catch (error) {
      return { data: null, error: (error as Error).message };
    }
  }, [context, curve]);
  const [state, dispatch] = useReducer(foldSessionReducer, initialFoldSession);
  const client = useRef<FoldClient | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    const next = input.data?.points.length
      ? new FoldClient(input.data, { timeoutMs: FOLD_WATCHDOG_MS })
      : null;
    client.current = next;
    return () => {
      ++sequence.current;
      next?.dispose();
      if (client.current === next) client.current = null;
    };
  }, [input]);
  const request = state.request;
  useEffect(() => {
    if (!request) return;
    const next = client.current;
    const ticket = ++sequence.current;
    if (!next) {
      dispatch({
        type: "error",
        request,
        message: input.error ?? "접을 유효 관측 데이터가 없습니다.",
      });
      return;
    }
    next
      .request(request.change.selection.periodDays)
      .then((result) => {
        if (!result || sequence.current !== ticket || !next.isCurrent(result))
          return;
        dispatch({ type: "success", request, result });
      })
      .catch((error: Error) => {
        if (sequence.current === ticket)
          dispatch({ type: "error", request, message: error.message });
      });
    return () => {
      ++sequence.current;
    };
  }, [request, input]);
  const cancel = () => {
    ++sequence.current;
    client.current?.cancel();
    dispatch({ type: "cancel" });
  };
  const setView = useCallback((update: (view: FoldView) => FoldView) => {
    dispatch({ type: "view", update });
  }, []);
  return {
    input,
    state,
    dispatch,
    cancel,
    setView,
    ready:
      canUseFold(state) && state.success?.result.dataId === input.data?.dataId,
  };
}
