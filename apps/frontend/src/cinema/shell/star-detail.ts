// GET /v1/me/stars/:tic for the focused star (galaxy selection or analysis).
// Same reading rules as StarDetail.tsx: readStarDetail against the current
// sky meta, abort on change, and only a result for the current star and sky
// version is ever returned, so a late reply for a previous star is ignored.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  DetailVersionChanged,
  readStarDetail,
  type StarDetail,
} from "../../features/sky-renderer/detail";
import type { CinemaSky } from "./sky";

type Result = {
  ticId: string;
  version: string;
  detail?: StarDetail;
  error?: Error;
};
export type FocusedStar = {
  ticId: string | null;
  detail: StarDetail | null;
  error: Error | null;
  loading: boolean;
  retry(): void;
};

export function useStarDetail(
  { store, data }: CinemaSky,
  ticId: string | null,
): FocusedStar {
  const meta = data.meta;
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refreshed = useRef(new Set<string>());
  const stars = useRef(data.stars);
  stars.current = data.stars;

  useEffect(() => {
    setResult(null);
    if (!store || !meta || !ticId || data.needsRefresh) return;
    const controller = new AbortController();
    void api<unknown>(`/v1/me/stars/${encodeURIComponent(ticId)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const detail = readStarDetail(
          value,
          meta,
          ticId,
          stars.current.find((star) => star.ticId === ticId),
        );
        setResult({ ticId, version: meta.version, detail });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof DetailVersionChanged &&
          !refreshed.current.has(meta.version)
        ) {
          refreshed.current.add(meta.version);
          void store.refresh();
        }
        setResult({
          ticId,
          version: meta.version,
          error:
            error instanceof Error
              ? error
              : new Error("별 정보를 불러오지 못했습니다."),
        });
      });
    return () => controller.abort();
  }, [store, meta, ticId, data.needsRefresh, attempt]);

  const scoped =
    ticId &&
    meta &&
    result?.ticId === ticId &&
    result.version === meta.version &&
    !data.needsRefresh
      ? result
      : null;
  const version = meta?.version;
  const retry = useCallback(() => {
    if (version) refreshed.current.delete(version);
    setAttempt((n) => n + 1);
  }, [version]);
  return {
    ticId,
    detail: scoped?.detail ?? null,
    error: scoped?.error ?? null,
    loading: !!ticId && !scoped,
    retry,
  };
}
