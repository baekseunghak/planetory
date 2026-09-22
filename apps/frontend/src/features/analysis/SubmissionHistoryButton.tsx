import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { http } from "../../api";
import { pagePath } from "../../app/paths";

/** Aggregate 8.4 supplies all submission IDs but only the latest History ID. */
export function SubmissionHistoryButton({
  submissionId,
  ticId,
  returnTo,
}: {
  submissionId: string;
  ticId: string;
  returnTo: string;
}) {
  const navigate = useNavigate();
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  useEffect(() => () => request.current?.abort(), []);
  async function open() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState("loading");
    try {
      const body = await http.request<{
        submissionId?: unknown;
        ticId?: unknown;
        historyId?: unknown;
      }>(`/v1/submissions/${encodeURIComponent(submissionId)}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (
        body?.submissionId !== submissionId ||
        body.ticId !== ticId ||
        typeof body.historyId !== "string" ||
        !body.historyId.trim()
      )
        throw new Error("기록 불일치");
      navigate(
        pagePath(
          "historyDetail",
          { historyId: body.historyId },
          { ticId, returnTo },
        ),
      );
    } catch {
      if (!controller.signal.aborted) setState("error");
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={state === "loading"}
        onClick={() => void open()}
      >
        {submissionId} 기록 보기
      </button>
      {state === "loading" && (
        <span role="status"> 기록을 확인하는 중입니다.</span>
      )}
      {state === "error" && (
        <p role="alert">
          이 제출 기록을 열 수 없습니다. 다시 시도하거나 다른 기록을 확인해
          주세요.
        </p>
      )}
    </>
  );
}
