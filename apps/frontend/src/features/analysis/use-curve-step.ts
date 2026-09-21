import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import {
  contextKey,
  curvePath,
  decodeCurve,
  type AnalysisContext,
  type CurveContext,
  type CurveData,
} from "./analysis-data";
import { needsResidual, sameContext, stepMoves } from "./curve-step";
import {
  runResidualJob,
  type ResidualOutcome,
  type ResidualProgress,
} from "./residual-job";

export type StepTransition =
  | { phase: "idle" }
  /** 계산을 기다리는 중. **곡선은 아직 바꾸지 않는다.** */
  | {
      phase: "running";
      target: CurveContext;
      progress: ResidualProgress | null;
    }
  /** 계산이 실패했다. 보고 있던 곡선은 그대로다. */
  | {
      phase: "failed";
      target: CurveContext;
      message: string;
      /** 거짓이면 [다시 시도]를 내지 않는다. 눌러도 같은 결과다. */
      retryable: boolean;
    }
  /**
   * 잔차 계산 기반이 아직 연결되지 않았다(503 `DEPENDENCY_UNAVAILABLE`).
   * **실패가 아니라 준비되지 않은 것이다.** `S15P21C206-88`이 붙기 전까지
   * 영구적이라 다시 시도를 권하지 않는다.
   */
  | { phase: "unavailable"; target: CurveContext; message: string }
  /** 대기열이 찼다. `activeJobId`가 있으면 내가 이미 돌리고 있는 작업이다. */
  | {
      phase: "queue-full";
      target: CurveContext;
      retryAfterSeconds: number;
      activeJobId: string | null;
      /** 거절이 온 시각. 화면이 남은 시간을 셀 때 쓴다. */
      refusedAt: number;
    }
  /** 판이 바뀌었다. 최신 판을 다시 불러와야 한다. */
  | { phase: "bundle-changed"; currentBundleId: string | null };

/**
 * 곡선 단계 이동(7.1·7.2절). 개발 안내 「곡선 단계 전환」을 실행한다.
 *
 * **`COMPLETED`에서만 보는 곡선을 바꾼다.** 그 전까지 화면은 마지막 정상
 * 곡선을 그대로 두고 진행만 알린다. 실패해도 바꾸지 않는다.
 *
 * **늦은 응답은 세대 번호로 버린다.** 중단(`AbortSignal`)만으로는 이미
 * 네트워크를 떠난 응답을 막지 못해 과거 단계의 곡선이 현재와 섞일 수 있다.
 */
/**
 * 목표 문맥의 곡선을 읽는다. `decodeCurve`가 **응답이 그 목표의 것인지**
 * 대조하므로 과거 단계의 곡선이 섞이지 않는다. 읽지 못하면 null이다.
 */
async function readCurve(
  context: AnalysisContext,
  target: CurveContext,
  signal: AbortSignal,
): Promise<CurveData | null> {
  try {
    let status = 0;
    const body = await api<unknown>(curvePath(context, target), {
      signal,
      onResponse: (response) => void (status = response.status),
    });
    const curve = decodeCurve(
      body,
      { ...context, curveContext: target },
      status,
    );
    // 계산이 끝난 직후인데 아직 준비되지 않았다면 바꾸지 않는다.
    return curve.kind === "ready" ? curve : null;
  } catch {
    return null;
  }
}

/**
 * @param onBundleChanged 판이 바뀐 것을 알았을 때. **곡선 조회가 하던 것을
 * 폴링도 하게 한다** — 자동으로 5.1절을 다시 조회한다. 같은 사건에 두 가지
 * 반응을 두면 어느 경로로 감지됐느냐에 따라 화면이 달라진다.
 */
export function useCurveStep(
  context: AnalysisContext,
  entry: CurveData,
  onBundleChanged?: () => void,
) {
  const [viewing, setViewing] = useState<CurveContext>(context.curveContext);
  /**
   * 지금 보고 있는 곡선. **`viewing`과 함께 바뀐다.** 단계 이름만 바꾸고
   * 곡선을 그대로 두면 표시와 실제가 달라진다.
   */
  const [curve, setCurve] = useState<CurveData>(entry);
  // 판이 바뀌어 진입 자료를 다시 읽으면 보던 단계도 그 판의 것으로 돌아간다.
  const entryKey = contextKey(context.curveContext);
  const lastEntry = useRef(entryKey);
  useEffect(() => {
    if (lastEntry.current === entryKey) return;
    lastEntry.current = entryKey;
    setViewing(context.curveContext);
    setCurve(entry);
    setVisited([]);
  }, [entryKey, context.curveContext, entry]);
  const [transition, setTransition] = useState<StepTransition>({
    phase: "idle",
  });
  /** 이번 세션에서 지나온 문맥. 마지막이 [이전 단계]의 대상이다. */
  const [visited, setVisited] = useState<CurveContext[]>([]);
  const generation = useRef(0);
  const running = useRef<AbortController | null>(null);

  // 별이나 판이 바뀌면 이 별의 이동 기록은 뜻이 없다.
  useEffect(() => {
    running.current?.abort();
    running.current = null;
    generation.current += 1;
    setViewing(context.curveContext);
    setVisited([]);
    setTransition({ phase: "idle" });
  }, [context.ticId, context.curveContext]);

  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  const moves = useMemo(
    () =>
      stepMoves({
        viewing,
        next: context.nextCurveContext,
        visited,
      }),
    [viewing, context.nextCurveContext, visited],
  );

  const goTo = useCallback(
    async (target: CurveContext, cameFrom: CurveContext | "back" | "stay") => {
      // `stay`는 이동이 아니라 **제자리 계산**이다. 보고 있는 단계의 잔차가
      // 없어 제출이 거절됐을 때 쓴다. 같은 문맥이어도 그냥 돌아가면 안 된다.
      if (cameFrom !== "stay" && sameContext(target, viewing)) return;
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      const mine = ++generation.current;
      // 자기 세대가 아닌 결과는 버린다. 늦게 도착한 과거 단계의 응답이
      // 지금 보고 있는 곡선을 덮어쓰면 안 된다.
      const current = () => generation.current === mine;

      /**
       * 목표의 곡선을 **손에 넣은 뒤에** 보는 곳을 바꾼다. 이름만 먼저
       * 바꾸면 표시줄은 다음 단계인데 차트·제출은 이전 문맥이 된다.
       *
       * @param resolved 계산이 끝났으면 서버가 준 `resultCurveContext`,
       * 캐시로 곧바로 가는 경우에는 목표 그대로. **서버가 준 값이 있으면
       * 그것으로 조회한다**(7.2절). 지금은 5.2절이 제거 조합 순서를 똑같이
       * 정규화해 결과가 같지만, 서버가 조합을 대체하거나 정규화를 바꾸면
       * 그때 갈린다.
       */
      const commit = async (resolved: CurveContext) => {
        if (cameFrom !== "stay") {
          const loaded = await readCurve(context, resolved, controller.signal);
          if (!current()) return;
          if (loaded === null) {
            setTransition({
              phase: "failed",
              target,
              message:
                "계산은 끝났지만 곡선을 불러오지 못했습니다. 다시 시도해 주세요.",
              // 계산은 이미 끝났다. 곡선 조회만 다시 하면 된다.
              retryable: true,
            });
            return;
          }
          setCurve(loaded);
          // 보는 곳도 서버가 준 문맥이다. 조회한 것과 보고 있다고 말하는
          // 것이 다르면 다음 이동이 엉뚱한 곳을 가리킨다.
          setViewing(resolved);
          setVisited((list) =>
            cameFrom === "back" ? list.slice(0, -1) : [...list, cameFrom],
          );
        }
        setTransition({ phase: "idle" });
      };

      const cached =
        context.nextCurveContext &&
        sameContext(target, context.nextCurveContext)
          ? context.nextResidual
          : sameContext(target, context.curveContext)
            ? context.currentResidual
            : null;
      if (!needsResidual(target, cached)) {
        // 계산이 필요 없으면 서버에 물은 적이 없다. 목표가 곧 문맥이다.
        await commit(target);
        return;
      }

      setTransition({ phase: "running", target, progress: null });
      let outcome: ResidualOutcome;
      try {
        outcome = await runResidualJob({
          request: api,
          ticId: context.ticId,
          target,
          signal: controller.signal,
          entryBundleId: context.curveContext.bundleId,
          onProgress: (progress) => {
            if (current())
              setTransition({ phase: "running", target, progress });
          },
        });
      } catch (error) {
        if (controller.signal.aborted || !current()) return;
        // 계산 기반이 아직 없는 것과 계산이 실패한 것은 다르다. 앞은
        // 눌러도 같은 결과라 「잠시 후 다시」가 거짓말이 된다.
        if (
          error instanceof ApiError &&
          error.code === "DEPENDENCY_UNAVAILABLE"
        ) {
          setTransition({
            phase: "unavailable",
            target,
            message: error.message,
          });
          return;
        }
        setTransition({
          phase: "failed",
          target,
          message: `${(error as Error).message} 잠시 후 다시 시도해 주세요.`,
          retryable: true,
        });
        return;
      }
      if (!current()) return;
      switch (outcome.state) {
        case "ready":
          await commit(outcome.curveContext);
          return;
        case "failed":
          setTransition({
            phase: "failed",
            target,
            message: outcome.message,
            retryable: outcome.retryable,
          });
          return;
        case "queue-full":
          setTransition({
            phase: "queue-full",
            target,
            retryAfterSeconds: outcome.retryAfterSeconds,
            activeJobId: outcome.activeJobId,
            refusedAt: Date.now(),
          });
          return;
        case "bundle-changed":
          setTransition({
            phase: "bundle-changed",
            currentBundleId: outcome.currentBundleId,
          });
          // 돌던 작업은 옛 판 목표라 결과를 쓰지 않는다. 서버 작업은
          // 계속 돌지만 UI 이탈을 취소로 처리하지 않는다는 규칙 그대로다.
          controller.abort();
          onBundleChanged?.();
          return;
      }
    },
    [viewing, context, onBundleChanged],
  );

  return {
    /** 지금 보고 있는 문맥. 계산이 끝나야 바뀐다. */
    viewing,
    curve,
    transition,
    moves,
    next: useCallback(
      () => (moves.next ? goTo(moves.next, viewing) : undefined),
      [moves.next, goTo, viewing],
    ),
    previous: useCallback(
      () => (moves.previous ? goTo(moves.previous, "back") : undefined),
      [moves.previous, goTo],
    ),
    original: useCallback(
      () => (moves.original ? goTo(moves.original, viewing) : undefined),
      [moves.original, goTo, viewing],
    ),
    /**
     * 목표를 직접 주고 옮긴다. 제출 결과의 [다음 곡선 단계로]가 쓴다.
     * 진입 때 받은 `nextCurveContext`는 제출 전 값이라 방금 매칭한 후보가
     * 빠져 있다. 접수 결과의 매칭 집합으로 만든 목표를 여기로 넘긴다.
     */
    goTo: useCallback(
      (target: CurveContext) => goTo(target, viewing),
      [goTo, viewing],
    ),
    /**
     * 지금 보고 있는 단계의 잔차를 계산시킨다. 옮기지 않는다.
     * 제출이 `SUBMISSION_CONTEXT_NOT_READY`로 거절됐을 때 쓴다.
     */
    prepare: useCallback(() => goTo(viewing, "stay"), [goTo, viewing]),
    /** 실패·대기열에서 같은 목표로 다시 시도한다. */
    retry: useCallback(() => {
      if (transition.phase === "failed" || transition.phase === "queue-full")
        return goTo(transition.target, viewing);
    }, [transition, goTo, viewing]),
    dismiss: useCallback(() => setTransition({ phase: "idle" }), []),
  };
}
