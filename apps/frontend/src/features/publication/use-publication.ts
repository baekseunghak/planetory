import { useEffect, useRef, useState } from "react";
import { ApiError, http } from "../../api";
import { historyPath } from "../analysis/history-data";
import { publishSkyChange } from "../sky-data/events";
import {
  candidatesPath,
  MAX_PUBLICATION_BATCH_SIZE,
  readBatch,
  readCandidates,
  readPreview,
  readReceipt,
  readVisibility,
  type Preview,
  type Receipt,
} from "./publication-data";

export type ReviewItem = {
  historyId: string;
  candidateId?: string;
  preview?: Preview;
  selected: boolean;
  loading: boolean;
  error?: string;
  outcome?: "received" | "failed" | "unknown";
  receipt?: Receipt;
  notice?: string;
  retryable?: boolean;
  stale?: boolean;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
export function canPublish(item: ReviewItem) {
  return (
    !!item.preview &&
    !item.loading &&
    !item.stale &&
    !item.outcome &&
    item.preview.detail.explanation.publication.state === "UNPUBLISHED" &&
    !item.preview.detail.explanation.publication.publicAnalysisId
  );
}

export function canRetryPublication(item: ReviewItem) {
  return (
    item.outcome === "failed" &&
    item.retryable === true &&
    canPublish({ ...item, outcome: undefined })
  );
}

export function usePublication(
  historyId: string | undefined,
  ticId: string | undefined,
  memberId: string,
) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requests = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const patch = (id: string, change: Partial<ReviewItem>) =>
    setItems((old) =>
      old.map((item) =>
        item.historyId === id ? { ...item, ...change } : item,
      ),
    );

  async function preview(
    id: string,
    signal: AbortSignal,
    candidateId?: string,
  ) {
    return readPreview(
      await http.request(historyPath(id), { signal }),
      id,
      ticId,
      candidateId,
    );
  }
  async function fill(item: ReviewItem, signal: AbortSignal) {
    try {
      const value = await preview(item.historyId, signal, item.candidateId);
      if (!signal.aborted)
        patch(item.historyId, {
          preview: value,
          loading: false,
          stale: false,
          error: undefined,
        });
    } catch (error) {
      if (!signal.aborted)
        patch(item.historyId, {
          loading: false,
          stale: true,
          error: errorText(error),
        });
    }
  }
  async function load(signal: AbortSignal, next: string | null = null) {
    setLoading(true);
    setError(undefined);
    try {
      if (historyId) {
        const item = { historyId, selected: true, loading: true };
        setItems([item]);
        await fill(item, signal);
      } else {
        if (!ticId)
          throw new Error(
            "공개 검토할 별 정보가 없습니다. 별 결과에서 다시 열어 주세요.",
          );
        const page = readCandidates(
          await http.request(candidatesPath(ticId, next), { signal }),
          ticId,
        );
        if (signal.aborted) return;
        if (next && page.nextCursor === next)
          throw new Error("목록의 다음 페이지를 확인할 수 없습니다.");
        // A moving list may repeat a candidate across pages. Keep the user's chosen representative.
        const fresh = page.items
          .filter(
            (candidate) =>
              !next ||
              !items.some((item) => item.candidateId === candidate.candidateId),
          )
          .map((candidate) => ({
            ...candidate,
            selected: false,
            loading: true,
          }));
        setItems((old) => (next ? [...old, ...fresh] : fresh));
        setCursor(page.nextCursor);
        await Promise.all(fresh.map((item) => fill(item, signal)));
      }
    } catch (error) {
      if (!signal.aborted) setError(errorText(error));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    void load(controller.signal);
    return () => controller.abort();
    // The page is keyed by route and authenticated member; requests belong to that instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = requests.current?.signal;
    if (!signal || signal.aborted || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await action(signal);
    } finally {
      if (!signal.aborted) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function receive(receipt: Receipt) {
    patch(receipt.historyId, {
      receipt,
      outcome: "received",
      retryable: false,
      stale: true,
      notice: "게시 요청 응답을 받았습니다. 아래 공개 상태는 다시 조회합니다.",
    });
    publishSkyChange(memberId, { skyVersion: receipt.skyVersion });
  }
  function publish(targets: ReviewItem[], retry = false) {
    const eligible = targets.filter((item) =>
      retry ? canRetryPublication(item) : canPublish(item),
    );
    if (
      !eligible.length ||
      eligible.length > MAX_PUBLICATION_BATCH_SIZE ||
      eligible.length !== targets.length
    )
      return;
    void run(async (signal) => {
      const ids = eligible.map((item) => item.historyId);
      eligible.forEach((item) =>
        patch(item.historyId, { notice: "게시 중입니다.", error: undefined }),
      );
      try {
        if (historyId) {
          const receipt = readReceipt(
            await http.request("/v1/public-analyses", {
              method: "POST",
              json: { historyId: ids[0] },
              signal,
            }),
            ids[0],
          );
          if (signal.aborted) return;
          receive(receipt);
        } else {
          const results = readBatch(
            await http.request("/v1/public-analyses/batch", {
              method: "POST",
              json: { ticId, items: ids.map((historyId) => ({ historyId })) },
              signal,
            }),
            ids,
          );
          if (signal.aborted) return;
          for (const result of results) {
            if (result.status === "FAILED")
              patch(result.historyId, {
                outcome: "failed",
                notice: result.message,
                retryable: result.retryable,
              });
            else receive(result.receipt);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        // An unparseable success or lost write response is not evidence of failure.
        const unknown =
          !(error instanceof ApiError) ||
          error.outcomeUnknown ||
          error.status >= 500;
        ids.forEach((id) =>
          patch(id, {
            outcome: unknown ? "unknown" : "failed",
            retryable: false,
            notice: unknown
              ? "요청 결과를 확인하지 못했습니다. 현재 공개 상태를 확인해 주세요. 성과 인정 여부도 아직 확인되지 않았습니다."
              : errorText(error),
          }),
        );
      }
      if (!signal.aborted)
        await Promise.all(eligible.map((item) => fill(item, signal)));
    });
  }
  function visibility(item: ReviewItem, isPublic: boolean) {
    const analysisId =
      item.preview?.detail.explanation.publication.publicAnalysisId;
    if (!analysisId || item.stale) return;
    void run(async (signal) => {
      patch(item.historyId, {
        error: undefined,
        notice: isPublic ? "재공개 중입니다." : "공개를 취소하는 중입니다.",
      });
      try {
        readVisibility(
          await http.request(
            `/v1/public-analyses/${encodeURIComponent(analysisId)}/visibility`,
            {
              method: "PUT",
              json: { isPublic },
              signal,
            },
          ),
          analysisId,
        );
        if (signal.aborted) return;
        patch(item.historyId, {
          notice: "공개 설정을 변경했습니다. 성과와 제출 기록은 유지됩니다.",
          stale: true,
        });
      } catch (error) {
        if (signal.aborted) return;
        patch(item.historyId, {
          notice: `${errorText(error)} 현재 공개 상태를 확인해 주세요.`,
          stale: true,
        });
      }
      await fill(item, signal);
    });
  }
  return {
    items,
    loading,
    error,
    cursor,
    busy,
    publish,
    visibility,
    select: (id: string, selected: boolean) => patch(id, { selected }),
    reload: () => {
      void run((signal) =>
        load(signal, items.length && !historyId ? cursor : null),
      );
    },
    more: () => {
      if (cursor) void run((signal) => load(signal, cursor));
    },
    refresh: (item: ReviewItem) => {
      void run((signal) => fill(item, signal));
    },
    reviewUnknown: (item: ReviewItem) => {
      if (
        busy ||
        item.stale ||
        item.outcome !== "unknown" ||
        !item.preview ||
        item.preview.detail.explanation.publication.publicAnalysisId
      )
        return;
      patch(item.historyId, {
        outcome: undefined,
        selected: false,
        notice:
          "현재 조회에 공개 기록이 없습니다. 앞선 요청이 처리 중일 수도 있습니다. 같은 기록을 다시 보내도 중복 게시나 취소한 공개의 복원은 일어나지 않습니다.",
      });
    },
    replace: (item: ReviewItem, id: string) => {
      if (busy || item.outcome || items.some((other) => other.historyId === id))
        return;
      const replacement = {
        historyId: id,
        candidateId: item.candidateId,
        selected: false,
        loading: true,
      };
      setItems((old) =>
        old.map((value) =>
          value.historyId === item.historyId ? replacement : value,
        ),
      );
      void run((signal) => fill(replacement, signal));
    },
  };
}
