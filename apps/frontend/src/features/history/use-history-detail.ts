import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, http } from "../../api";
import {
  historyPath,
  readHistoryDetail,
  type HistoryDetail,
} from "../analysis/history-data.ts";
import {
  historyGraphPath,
  readHistoryGraphView,
  type HistoryGraphView,
} from "../analysis/history-graph.ts";
import type { GraphMode } from "./HistoryGraph.tsx";

// #190 기록 상세 조회. 상세와 그래프는 **따로** 온다(8.2·8.3). 모드를 바꿀
// 때 상세를 다시 부르지 않는다. 일시 오류 재시도는 상세만 다시 읽는다.

export type DetailState =
  | { phase: "loading" }
  | { phase: "ready"; detail: HistoryDetail }
  /** 최초 응답이 없는 기록. 다시 시도해도 같다(8.2절 503 정책). */
  | { phase: "unreadable"; message: string }
  | { phase: "denied"; message: string }
  | { phase: "error"; message: string };

export type GraphState =
  | { phase: "loading" }
  | { phase: "ready"; view: HistoryGraphView }
  /** 판 전환 중이라 한 판으로 못 맞췄다. 다시 시도할 수 있다. */
  | { phase: "retryable"; message: string }
  | { phase: "error"; message: string };

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.message ? error.message : fallback;

export function useHistoryDetail(historyId: string) {
  const [detail, setDetail] = useState<DetailState>({ phase: "loading" });
  const [mode, setMode] = useState<GraphMode>("CURRENT");
  const [graph, setGraph] = useState<GraphState>({ phase: "loading" });
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const graphRequest = useRef<AbortController | null>(null);
  // 모드를 바꾸면 앞선 조회가 늦게 돌아올 수 있다. 세대가 다르면 버린다.
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setDetail({ phase: "loading" });
    void (async () => {
      try {
        const body = await http.request<unknown>(historyPath(historyId), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail({
          phase: "ready",
          detail: readHistoryDetail(body, { historyId }),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 503)
          return setDetail({
            phase: "unreadable",
            message:
              // 이 화면은 상세가 없으면 그래프도 열지 않는다. `ticId`가
              // 상세에서만 오므로 조회가 시작조차 되지 않는다. 기다리면
              // 나올 것처럼 말하지 않는다.
              "최초 응답이 없어 상세를 제공할 수 없는 기록입니다. 이 화면에서는 그래프도 볼 수 없습니다. 목록에서는 그대로 보입니다.",
          });
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        )
          return setDetail({
            phase: "denied",
            message: message(error, "이 기록을 볼 수 없습니다."),
          });
        setDetail({
          phase: "error",
          message: message(error, "기록을 불러오지 못했습니다."),
        });
      }
    })();
    return () => controller.abort();
  }, [historyId, detailAttempt]);

  const ticId = detail.phase === "ready" ? detail.detail.ticId : null;

  const loadGraph = useCallback(
    (next: GraphMode) => {
      if (!ticId) return () => {};
      graphRequest.current?.abort();
      const controller = new AbortController();
      graphRequest.current = controller;
      const mine = ++generation.current;
      setGraph({ phase: "loading" });
      void (async () => {
        try {
          const body = await http.request<unknown>(
            historyGraphPath(historyId, next),
            { signal: controller.signal },
          );
          if (controller.signal.aborted || mine !== generation.current) return;
          const view = readHistoryGraphView(body, historyId, ticId, next);
          if (next === "SUBMITTED" && view.dto.snapshot === null)
            setSnapshotMissing(true);
          setGraph({
            phase: "ready",
            view,
          });
        } catch (error) {
          if (controller.signal.aborted || mine !== generation.current) return;
          // 판 전환 중이면 서버가 이미 한 번 다시 시도한 뒤다. 사용자가 다시
          // 눌러 볼 수는 있다.
          if (
            error instanceof ApiError &&
            error.code === "GRAPH_TEMPORARILY_UNAVAILABLE"
          )
            return setGraph({
              phase: "retryable",
              message:
                "자료 판이 바뀌는 중이라 그래프를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
            });
          setGraph({
            phase: "error",
            message: message(error, "그래프를 불러오지 못했습니다."),
          });
        }
      })();
      return () => controller.abort();
    },
    [historyId, ticId],
  );

  useEffect(() => loadGraph(mode), [loadGraph, mode]);
  useEffect(() => () => graphRequest.current?.abort(), []);

  return {
    detail,
    graph,
    mode,
    setMode,
    snapshotMissing,
    retryDetail: () => setDetailAttempt((attempt) => attempt + 1),
    retryGraph: () => loadGraph(mode),
  };
}
