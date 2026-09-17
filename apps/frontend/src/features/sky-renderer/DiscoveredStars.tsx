import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import {
  discoveredPath,
  readDiscoveredPage,
  type DiscoveredPage,
} from "./discovered";

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
  const heading = useRef<HTMLHeadingElement>(null),
    focusPage = useRef(false);
  const cursor = cursors.at(-1)!;
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
    setResult(null);
    void api<unknown>(discoveredPath(cursor), { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const page = readDiscoveredPage(value);
        if (page.nextCursor && cursors.includes(page.nextCursor))
          throw new Error(
            "같은 목록이 반복되었습니다. 처음부터 새로 불러와 주세요.",
          );
        setResult({ page });
        if (focusPage.current) {
          heading.current?.parentElement?.scrollTo({ top: 0 });
          heading.current?.focus({ preventScroll: true });
          focusPage.current = false;
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            error:
              error instanceof Error
                ? error
                : new Error("별 목록을 불러오지 못했습니다."),
          });
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
      <h2 id="discovered-title" ref={heading} tabIndex={-1}>
        발견한 별 목록
      </h2>
      <p>
        아직 분석하지 않은 별도 포함합니다. 최근 활동 순서로 20개씩 보여드려요.
      </p>
      <div className="discovered-status" role="status" aria-live="polite">
        {data.needsRefresh
          ? "최신 발견 목록을 확인하고 있습니다."
          : !result
            ? "별 목록을 불러오고 있습니다."
            : page
              ? `${page.items.length}개의 별을 불러왔습니다.${!page.hasNext ? " 마지막 목록입니다." : ""}`
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
        aria-busy={!result || data.needsRefresh}
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
                    in_progress: "탐색 중",
                    completed: "탐색 완료",
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
      </ul>
      <nav aria-label="발견 별 이어읽기">
        <button
          disabled={cursors.length < 2 || !result || data.needsRefresh}
          onClick={() => {
            focusPage.current = true;
            setCursors((s) => s.slice(0, -1));
          }}
        >
          이전 별 목록
        </button>
        <button
          disabled={!page?.hasNext}
          onClick={() => {
            if (page?.nextCursor) {
              focusPage.current = true;
              setCursors((s) => [...s, page.nextCursor]);
            }
          }}
        >
          다음 별 목록
        </button>
      </nav>
    </section>
  );
}
