import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import type { AnalysisContext, CurveData } from "./analysis-data";
import { loadPeriodogram, type PeriodogramLoad } from "./load-periodogram";
import {
  PeriodogramBundleChanged,
  PeriodogramContextChanged,
} from "./periodogram-data";
import { PeriodSelectionWorkspace } from "./PeriodSelection";
import type { PeriodSelectionChange } from "./period-selection";
import "./periodogram.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: Error }
  | { kind: "loaded"; data: PeriodogramLoad };
export function PeriodogramPanel({
  context,
  curve,
  reloadAnalysis,
  onPeriodChange,
  recoverBundle,
}: {
  context: AnalysisContext;
  curve: CurveData;
  reloadAnalysis: () => void;
  onPeriodChange?: (change: PeriodSelectionChange) => void;
  recoverBundle: () => boolean;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const headingId = useId();
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "loading" });
    loadPeriodogram(api, context, curve, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: "loaded", data });
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        if (error instanceof PeriodogramBundleChanged && recoverBundle()) {
          setState({ kind: "loading" });
          return;
        }
        setState({ kind: "error", error });
      });
    return () => controller.abort();
  }, [context, curve, attempt, recoverBundle]);
  const retry = () => {
    controllerRef.current?.abort();
    setState({ kind: "loading" });
    setAttempt((value) => value + 1);
  };
  let message = "주기도와 봉우리를 불러오고 있습니다…";
  let needsContext = false;
  if (state.kind === "error") {
    const error = state.error;
    needsContext = error instanceof PeriodogramContextChanged;
    message = needsContext
      ? error instanceof PeriodogramBundleChanged
        ? "데이터 판이 계속 바뀌어 주기도 조회를 중단했습니다. 잠시 후 분석 자료를 다시 불러와 주세요."
        : "시간 곡선과 주기도의 문맥이 달라 표시를 중단했습니다. 분석 자료를 다시 불러와 주세요."
      : error instanceof ApiError && error.status === 403
        ? "이 주기도를 볼 권한이 없습니다. 접근 상태를 확인한 뒤 다시 불러와 주세요."
        : error instanceof ApiError && error.status === 404
          ? "주기도 자료를 찾을 수 없거나 볼 수 없습니다. 잠시 후 다시 불러와 주세요."
          : `주기도를 불러오지 못했습니다. ${error.message}`;
  } else if (state.kind === "loaded" && state.data.kind === "unavailable") {
    const { reason, pending } = state.data;
    needsContext =
      reason === "rules-unavailable" || reason === "curve-not-ready";
    message =
      reason === "rules-unavailable"
        ? "이 곡선의 주기도와 선택 규칙은 아직 연결되지 않았습니다. 자료가 준비되면 분석 자료를 다시 불러와 주세요."
        : reason === "curve-not-ready"
          ? "유효한 시간 곡선이 준비되어야 주기도를 표시할 수 있습니다. 분석 자료를 다시 불러와 주세요."
          : reason === "empty-peaks"
            ? "표시할 추천 봉우리 자료가 없습니다. 신호가 없다는 뜻은 아닙니다. 자료를 다시 불러와 주세요."
            : pending?.status === "FAILED"
              ? "주기도 계산에 실패했습니다. 잠시 후 주기도를 다시 불러와 주세요."
              : pending?.status
                ? "주기도를 준비하고 있습니다. 잠시 후 다시 불러와 주세요."
                : "이 단계의 주기도 계산 결과가 없습니다. 자료가 준비되면 다시 불러와 주세요.";
  }
  const ready =
    state.kind === "loaded" && state.data.kind === "ready" ? state.data : null;
  return (
    <section
      className={
        ready
          ? "analysis-periodogram"
          : "analysis-periodogram periodogram-unavailable"
      }
      aria-labelledby={headingId}
    >
      <h2 className="analysis-sr-only" id={headingId}>
        반복 주기 그래프
      </h2>
      <p
        aria-live="polite"
        aria-atomic="true"
        className={ready ? "analysis-sr-only" : "periodogram-state"}
      >
        {ready
          ? "주기도를 불러왔습니다. 그래프 탐색은 주기 선택값을 변경하지 않습니다."
          : message}
      </p>
      {ready ? (
        <PeriodSelectionWorkspace
          data={ready}
          context={context}
          curve={curve}
          onPeriodChange={onPeriodChange}
        />
      ) : state.kind !== "loading" ? (
        <button type="button" onClick={needsContext ? reloadAnalysis : retry}>
          {needsContext ? "분석 자료 다시 불러오기" : "주기도 다시 불러오기"}
        </button>
      ) : null}
    </section>
  );
}
