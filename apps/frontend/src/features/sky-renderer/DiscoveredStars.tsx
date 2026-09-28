import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import {
  discoveredPath,
  readDiscoveredPage,
  type DiscoveredPage,
} from "./discovered";
import { useCinemaWording } from "../../shared/cinema-wording";

export function DiscoveredStars({
  data,
  active,
  select,
}: SkySceneProps & { active: boolean; select(ticId: string): void }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [result, setResult] = useState<{
    page?: DiscoveredPage;
    error?: Error;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const cursor = cursors.at(-1)!;
  const cinema = useCinemaWording();
  const scope = data.meta;
  const previous = useRef(scope);
  // Reset cursor ownership when the map is refreshed, including same-version refreshes.
  const fresh = previous.current === scope;
  useEffect(() => {
    previous.current = scope;
    setCursors([null]);
    setResult(null);
  }, [scope, data.needsRefresh]);
  useEffect(() => {
    if (!active || data.needsRefresh || !fresh) return;
    const controller = new AbortController();
    setLoading(true);
    setResult((previous) => cursor ? { ...previous, error: undefined } : null);
    void api<unknown>(discoveredPath(cursor), { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const page = readDiscoveredPage(value);
        if (page.nextCursor && cursors.includes(page.nextCursor))
          throw new Error(
            "같은 목록이 반복되었습니다. 처음부터 새로 불러와 주세요.",
          );
        setResult((previous) => {
          const existing = cursor ? previous?.page?.items ?? [] : [];
          const items = [...new Map([...existing, ...page.items].map((star) => [star.ticId, star])).values()];
          return { page: { ...page, items } };
        });
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setResult((previous) => ({
            page: cursor ? previous?.page : undefined,
            error: error instanceof Error ? error : new Error("별 목록을 불러오지 못했습니다."),
          }));
        }
      });
    return () => controller.abort();
  }, [active, scope, data.needsRefresh, fresh, cursor, retry]);
  const page = fresh && !data.needsRefresh ? result?.page : null;
  const error = result?.error;
  return (
    <section
      className="accessible-stars discovered-stars"
      hidden={!active}
      aria-labelledby="discovered-title"
    >
      <h2 id="discovered-title">
        발견한 별 목록
      </h2>
      <p>
        {cinema
          ? "아직 분석하지 않은 별도 포함합니다. 최근 활동 순서로 20개씩 보여 드립니다."
          : "아직 분석하지 않은 별도 포함합니다. 최근 활동 순서로 20개씩 보여드려요."}
      </p>
      <div className="discovered-status" role="status" aria-live="polite">
        {data.needsRefresh
          ? "최신 발견 목록을 확인하고 있습니다."
          : !result
            ? "별 목록을 불러오고 있습니다."
            : page
              ? `${page.items.length}개의 별을 불러왔습니다.`
              : "별 목록을 불러오지 못했습니다."}
      </div>
      {error && (
        <div role="alert">
          <p>
            {error instanceof ApiError && error.status === 403
              ? "이 별 목록에 접근할 수 없습니다."
              : error.message}
          </p>
          <button onClick={() => setRetry((n) => n + 1)}>
            별 목록 다시 불러오기
          </button>
          {cursor && (
            <button onClick={() => setCursors([null])}>
              처음 목록부터 확인
            </button>
          )}
        </div>
      )}
      {page?.items.length === 0 && <p>아직 발견한 별이 없습니다.</p>}
      <ul
        className="discovered-rows"
        aria-label="발견한 별"
        aria-busy={loading || data.needsRefresh}
      >
        {page?.items.map((s) => (
          <li key={s.ticId}>
            <button
              data-tic-id={s.ticId}
              aria-pressed={data.selectedTicId === s.ticId}
              onClick={() => select(s.ticId)}
            >
              <strong>TIC {s.ticId}</strong>
              <span>
                {
                  {
                    unexplored: "미탐사",
                    in_progress: cinema ? "탐사 중" : "탐색 중",
                    completed: cinema ? "탐사 완료" : "탐색 완료",
                  }[s.progressStage]
                }{" "}
                · 내 행성 {s.planetCount}개
              </span>
              <small>
                인정된 성과 {s.achievementCount}건
                {s.grade ? ` · ${s.grade}` : ""}
                {s.reopened ? " · 다시 열린 별" : ""}
                {s.reopenPending ? " · 새 관측 자료 대기" : ""}
              </small>
            </button>
          </li>
        ))}
        {page?.hasNext && (
          <li>
            <button
              disabled={loading || data.needsRefresh}
              onClick={() => {
                if (error) setRetry((n) => n + 1);
                else if (page.nextCursor) setCursors((s) => [...s, page.nextCursor]);
              }}
            >
              {loading ? "불러오는 중…" : error ? "다시 불러오기" : "더 보기"}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
