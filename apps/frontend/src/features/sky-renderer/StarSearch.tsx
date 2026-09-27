import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import { readDiscoveredPage, type DiscoveredPage } from "./discovered";
import {
  emptyStarFilters,
  filtersFromSearch,
  normalizeStarFilters,
  searchWithFilters,
  starSearchPath,
  readStarLocation,
  LocateVersionChanged,
  type StarFilters,
  type StarLocation,
} from "./star-search";
import { useCinemaWording } from "../../shared/cinema-wording";
import "./star-search.css";

// Shared filter control: A13 can consume this without importing the galaxy renderer.
export function StarFilterFields({
  value,
  onChange,
  disabled = false,
  actions,
}: {
  value: StarFilters;
  onChange(value: StarFilters): void;
  disabled?: boolean;
  actions?: ReactNode;
}) {
  // Cinema app: 탐사 (src/shared/cinema-wording). Values are unchanged.
  const cinema = useCinemaWording();
  return (
    <fieldset disabled={disabled} className="star-search-fields">
      <legend className="sr-only">발견한 별 검색 조건</legend>

      <label>
        탐사 상태
        <select
          value={value.stage}
          onChange={(e) => onChange({ ...value, stage: e.target.value })}
        >
          <option value="">전체 상태</option>
          <option value="unexplored">미탐사</option>
          <option value="in_progress">{cinema ? "탐사 중" : "탐색 중"}</option>
          <option value="completed">
            {cinema ? "탐사 완료" : "탐색 완료"}
          </option>
        </select>
      </label>
      <label>
        등급
        <select
          value={value.grade}
          onChange={(e) => onChange({ ...value, grade: e.target.value })}
        >
          <option value="">전체 등급</option>
          {["A", "S", "SS", "SSS"].map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </label>
      <div className="star-search-query">
      <label>
        TIC 번호
        <input
          name="ticId"
          value={value.ticId}
          placeholder="예: 259377017"
          onChange={(e) => onChange({ ...value, ticId: e.target.value })}
        />
      </label>
        {actions}
      </div>
    </fieldset>
  );
}
export function StarSearch({
  data,
  store,
  onLocate,
}: SkySceneProps & { onLocate(location: StarLocation): void }) {
  const location = useLocation(),
    navigate = useNavigate();
  const cinema = useCinemaWording();
  let filterError = "",
    applied = emptyStarFilters;
  try {
    applied = filtersFromSearch(location.search);
  } catch (e) {
    filterError = (e as Error).message;
  }
  const query = JSON.stringify(applied),
    scope = `${store.memberId}:${data.meta?.version}:${query}`;
  const [draft, setDraft] = useState(applied),
    [open, setOpen] = useState(() => Object.values(applied).some(Boolean));
  const [cursors, setCursors] = useState<{
    scope: string;
    values: (string | null)[];
  }>({ scope, values: [null] });
  const values = cursors.scope === scope ? cursors.values : [null],
    cursor = values.at(-1)!;
  const [result, setResult] = useState<{
    scope: string;
    cursor: string | null;
    page?: DiscoveredPage;
    error?: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [loading, setLoading] = useState(false),
    [locating, setLocating] = useState(false);
  const pending = useRef<AbortController | null>(null),
    currentScope = useRef(scope);
  currentScope.current = scope;
  const results =
    result?.scope === scope &&
    !data.needsRefresh &&
    !filterError
      ? result
      : null;
  useEffect(() => {
    setDraft(JSON.parse(query));
    setError("");
    pending.current?.abort();
    setLocating(false);
  }, [scope, data.needsRefresh, filterError]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!open || filterError || data.needsRefresh) return;
    const controller = new AbortController();
    setLoading(true);
    setResult((previous) => cursor && previous?.scope === scope ? { ...previous, error: undefined } : null);
    void api<unknown>(starSearchPath(JSON.parse(query), cursor), {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const page = readDiscoveredPage(value);
        if (page.nextCursor && values.includes(page.nextCursor))
          throw new Error("같은 검색 페이지가 반복되었습니다.");
        setResult((previous) => {
          const existing = cursor && previous?.scope === scope ? previous.page?.items ?? [] : [];
          const items = [...new Map([...existing, ...page.items].map((star) => [star.ticId, star])).values()];
          return { scope, cursor, page: { ...page, items } };
        });
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setResult((previous) => ({
            scope, cursor,
            page: cursor && previous?.scope === scope ? previous.page : undefined,
            error: "별 검색 결과를 불러오지 못했습니다.",
          }));
        }
      });
    return () => controller.abort();
  }, [open, scope, cursor, retry, data.needsRefresh, filterError]);
  function apply(filters: StarFilters) {
    try {
      const next = normalizeStarFilters(filters);
      setError("");
      pending.current?.abort();
      setLocating(false);
      setCursors({ scope: "", values: [null] });
      setRetry((n) => n + 1);
      navigate({
        pathname: location.pathname,
        search: searchWithFilters(location.search, next),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function locate(ticId: string) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLocating(true);
    setError("");
    const started = scope;
    try {
      const value = await api<unknown>(
        `/v1/me/sky/locate?${new URLSearchParams({ ticId })}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || currentScope.current !== started) return;
      onLocate(readStarLocation(value, ticId, data.meta!));
    } catch (e) {
      if (controller.signal.aborted || currentScope.current !== started) return;
      if (e instanceof LocateVersionChanged) {
        setError(e.message);
        void store.refresh();
      } else
        setError(
          e instanceof ApiError && e.status === 403
            ? "아직 발견하지 않았거나 접근할 수 없는 별입니다."
            : "별 위치를 불러오지 못했습니다. 다시 선택해 주세요.",
        );
    } finally {
      if (!controller.signal.aborted) setLocating(false);
    }
  }
  return (
    <details
      className="star-search"
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (!e.currentTarget.open) {
          pending.current?.abort();
          setLocating(false);
        }
      }}
    >
      <summary>내 별 찾기</summary>
      <div className="star-search-panel">
      <p>발견한 별에서 TIC 번호·탐사 상태·등급으로 찾아보세요.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
      >
        <StarFilterFields value={draft} onChange={setDraft} actions={
        <div className="star-search-actions">
          <button type="submit">별 검색</button>
          <button
            type="button"
            onClick={() => {
              setDraft(emptyStarFilters);
              apply(emptyStarFilters);
            }}
          >
            초기화
          </button>
        </div>
        } />
      </form>
      {(filterError || error || results?.error) && (
        <div role="alert">
          <p>{filterError || error || results?.error}</p>
          {results?.error && (
            <button onClick={() => setRetry((n) => n + 1)}>
              검색 다시 불러오기
            </button>
          )}
        </div>
      )}
      <p role="status">
        {locating
          ? "별 위치를 확인하고 있습니다."
          : !results && !filterError
            ? "별을 찾고 있습니다."
            : results?.page?.items.length === 0
              ? "조건에 맞는 별이 없습니다."
              : results?.page
                ? `${results.page.items.length}개의 별을 찾았습니다.`
                : ""}
      </p>
      <ul className="star-search-results" aria-label="별 검색 결과">
        {results?.page?.items.map((star) => (
          <li key={star.ticId}>
            <button
              disabled={locating || data.needsRefresh}
              onClick={() => void locate(star.ticId)}
            >
              <strong>TIC {star.ticId}</strong>
              <span>
                {
                  {
                    unexplored: "미탐사",
                    in_progress: cinema ? "탐사 중" : "탐색 중",
                    completed: cinema ? "탐사 완료" : "탐색 완료",
                  }[star.progressStage]
                }
                {star.grade ? ` · ${star.grade}` : ""}{" "}
                <span aria-hidden="true">↗</span>
              </span>
            </button>
          </li>
        ))}
        {results?.page?.hasNext && (
          <li className="star-search-more">
            <button
              disabled={loading || locating || data.needsRefresh}
              onClick={() => {
                if (results.error) setRetry((n) => n + 1);
                else if (results.page?.nextCursor)
                  setCursors({ scope, values: [...values, results.page.nextCursor] });
              }}
            >
              {loading ? "불러오는 중…" : results.error ? "다시 불러오기" : "더 보기"}
            </button>
          </li>
        )}
      </ul>
      </div>
    </details>
  );
}
