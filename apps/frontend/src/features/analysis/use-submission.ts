import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import type { AnalysisContext } from "./analysis-data";
import type { SubmissionInput } from "./submission-input";
import type { SubmissionKind } from "./submission-data";
import {
  checkSubmission,
  submitAnalysis,
  type SubmissionResult,
} from "./submit-analysis";
import {
  markSubmissionAccepted,
  readPendingSubmission,
  releaseRequestId,
  reserveRequestId,
  submissionFingerprint,
  submissionStorageKey,
} from "./submission-request";

/** 되살린 기록은 무엇을 보냈는지 모를 수 있다(판 1). 그래서 null을 허용한다. */
type Kind = SubmissionKind | null;
export type SubmissionState =
  | { phase: "idle" }
  | { phase: "sending"; kind: Kind }
  | { phase: "checking"; kind: Kind }
  | ({ phase: "settled"; kind: Kind } & SubmissionResult);

/**
 * 제출 한 번의 수명을 화면에 연결한다. 요청 ID 예약과 복구는
 * [submission-request](submission-request.ts)·[submit-analysis](submit-analysis.ts)가
 * 하고, 여기서는 진행 상태와 초안 잠금만 다룬다.
 */
export function useSubmission(context: AnalysisContext) {
  const auth = useSession();
  const memberId = auth.member?.memberId ?? null;
  const [state, setState] = useState<SubmissionState>({ phase: "idle" });
  // 결과를 모르는 채로 화면을 떠나도 ID는 저장소에 남는다. 중단은 화면 갱신만 멈춘다.
  const running = useRef<AbortController | null>(null);
  const last = useRef<{ requestId: string; kind: Kind } | null>(null);
  const [volatileId, setVolatileId] = useState(false);
  const key = useMemo(
    () => (memberId ? submissionStorageKey(memberId, context.ticId) : null),
    [memberId, context.ticId],
  );
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );
  /**
   * 별이 바뀌거나 화면에 들어올 때 이 회원·이 별의 기록을 되살린다.
   *
   * 결과를 모르는 요청은 새로고침으로 사라지면 안 된다. 사라지면 복구
   * 경로가 없어지고, 사용자는 접수됐는지 모르는 채로 다른 제출을 하게 된다.
   *
   * **조회를 자동으로 보내지는 않는다.** 되살리는 것은 상태와 [접수 결과
   * 확인]까지고, 요청을 보낼지는 사용자가 정한다.
   */
  useEffect(() => {
    running.current?.abort();
    running.current = null;
    setVolatileId(false);
    const pending = key ? readPendingSubmission(key) : null;
    if (!pending || pending.state !== "pending") {
      last.current = null;
      setState({ phase: "idle" });
      return;
    }
    last.current = { requestId: pending.requestId, kind: pending.kind };
    setState({
      phase: "settled",
      kind: pending.kind,
      state: "unresolved",
      requestId: pending.requestId,
      reason: "lost",
      // 접수되지 않았다고 단정하지 않는다. 확인해야 알 수 있다.
      message:
        "결과를 확인하지 못한 제출이 있습니다. 다시 제출하지 말고 접수 결과를 확인해 주세요.",
    });
  }, [context.ticId, memberId, key]);

  const run = useCallback(
    async (
      kind: Kind,
      phase: "sending" | "checking",
      work: (signal: AbortSignal) => Promise<SubmissionResult>,
    ) => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      setState({ phase, kind });
      try {
        const result = await work(controller.signal);
        if (controller.signal.aborted) return;
        // 확정된 기록은 다른 본문의 예약을 막지 않는다. 미확인만 막는다.
        if (result.state === "accepted" && key) markSubmissionAccepted(key);
        setState({ phase: "settled", kind, ...result });
      } catch (error) {
        if (controller.signal.aborted) return;
        // 읽을 수 없는 응답과 뜻밖의 실패. 접수 여부는 모르므로 ID를 지키고
        // 「확인이 필요하다」로 남긴다. 실패로 적어 두면 사용자가 다시 보낸다.
        setState({
          phase: "settled",
          kind,
          state: "unresolved",
          requestId: last.current?.requestId ?? "",
          reason: "lost",
          message: `${(error as Error).message} 다시 제출하지 말고 접수 결과를 확인해 주세요.`,
        });
      } finally {
        if (running.current === controller) running.current = null;
      }
    },
    [key],
  );

  const submit = useCallback(
    (input: SubmissionInput) => {
      if (!key) return;
      const reserved = reserveRequestId(key, submissionFingerprint(input), {
        kind: input.submissionKind,
        body: { ...input },
      });
      // 앞선 요청의 결과를 모른다. 보내지 않고 그 요청의 확인으로 돌린다.
      if (reserved.status === "blocked") {
        const { pending } = reserved;
        last.current = { requestId: pending.requestId, kind: pending.kind };
        setState({
          phase: "settled",
          kind: pending.kind,
          state: "unresolved",
          requestId: pending.requestId,
          reason: "lost",
          message:
            "결과를 확인하지 못한 제출이 있어 이번 제출을 보내지 않았습니다. 먼저 접수 결과를 확인해 주세요.",
        });
        return;
      }
      last.current = {
        requestId: reserved.requestId,
        kind: input.submissionKind,
      };
      setVolatileId(reserved.volatile);
      return run(input.submissionKind, "sending", (signal) =>
        submitAnalysis({
          request: api,
          ticId: context.ticId,
          input,
          requestId: reserved.requestId,
          signal,
          releaseRequestId: () => releaseRequestId(key),
        }),
      );
    },
    [key, context.ticId, run],
  );

  /** 보내지 않고 접수 결과만 확인한다. 중복 접수를 만들 수 없는 경로다. */
  const check = useCallback(() => {
    const pending = last.current;
    if (!pending?.requestId) return;
    return run(pending.kind, "checking", (signal) =>
      checkSubmission({
        request: api,
        ticId: context.ticId,
        requestId: pending.requestId,
        signal,
      }),
    );
  }, [context.ticId, run]);

  /** 입력을 고쳐 다시 제출할 수 있는 상태로 되돌린다. */
  const dismiss = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setState({ phase: "idle" });
  }, []);

  const settled = state.phase === "settled" ? state : null;
  return {
    state,
    volatileId,
    submit,
    check,
    dismiss,
    /**
     * 초안을 잠글지. 보내는 중과 결과 불명에서 잠근다. 결과를 모르는 동안
     * 본문이 바뀌면 복구 재전송이 `IDEMPOTENCY_CONFLICT`가 되어 이미 접수된
     * 결과를 확인할 길이 사라진다. 접수를 마친 뒤에도 잠근다.
     */
    locked:
      state.phase === "sending" ||
      state.phase === "checking" ||
      settled?.state === "accepted" ||
      settled?.state === "unresolved",
    /** 결과를 모르는 상태. [접수 결과 확인]을 내놓아야 한다. */
    unresolved: settled?.state === "unresolved" ? settled : null,
    accepted: settled?.state === "accepted" ? settled : null,
  };
}
