import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { postTags } from "./postContracts";
import {
  searchScopes,
  validateFeedSearch,
  type FeedSearch,
} from "./feedSearch";

import { useCinemaWording } from "../../shared/cinema-wording";

export function FeedSearchForm({
  initial,
  addressError,
  routeTic,
  official = false,
  resetTo,
  onSearch,
}: {
  initial: FeedSearch;
  addressError: string | null;
  routeTic?: string;
  official?: boolean;
  resetTo: string;
  onSearch: (values: FeedSearch) => void;
}) {
  const [values, setValues] = useState(initial);
  const cinema = useCinemaWording();
  const [error, setError] = useState<string | null>(addressError);
  const feedback = useRef<HTMLParagraphElement>(null);
  const update = (field: keyof FeedSearch, value: string) => {
    setValues((old) => ({ ...old, [field]: value }));
    setError(null);
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    const message = validateFeedSearch(values);
    setError(message);
    if (message) requestAnimationFrame(() => feedback.current?.focus());
    else onSearch(values);
  }
  return (
    <form
      className="community-search"
      role="search"
      aria-label="커뮤니티 검색"
      onSubmit={submit}
    >
      <div className="community-search-main">
        <label>
          검색 범위
          <select
            value={values.searchIn}
            onChange={(e) => update("searchIn", e.target.value)}
          >
            {Object.entries(searchScopes).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="community-search-query">
          검색어
          <input
            type="search"
            value={values.q}
            onChange={(e) => update("q", e.target.value)}
            placeholder="함께 살펴볼 이야기를 찾아보세요"
            aria-describedby="feed-search-help"
          />
        </label>
        <button type="submit">검색</button>
        <Link to={resetTo} state={null} className="community-search-reset">
          초기화
        </Link>
      </div>
      <details
        open={Boolean(
          initial.author ||
          initial.tag ||
          (!routeTic && initial.ticId) ||
          addressError,
        )}
      >
        <summary>
          {official ? "상세 조건 · TIC" : "상세 조건 · 작성자, TIC, 태그"}
        </summary>
        <div className="community-search-filters">
          {!official && (
            <label>
              작성자 닉네임
              <input
                value={values.author}
                onChange={(e) => update("author", e.target.value)}
                placeholder="현재 닉네임 전체"
              />
            </label>
          )}
          <label>
            TIC 번호
            <input
              inputMode="numeric"
              value={values.ticId}
              readOnly={Boolean(routeTic)}
              onChange={(e) => update("ticId", e.target.value)}
              placeholder="예: 259377017"
            />
          </label>
          {!official && (
            <label>
              글 태그
              <select
                value={values.tag}
                onChange={(e) => update("tag", e.target.value)}
              >
                <option value="">모든 태그</option>
                {Object.entries(postTags).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p>
          {official
            ? "검색어와 TIC 조건을 모두 만족하는 공식 스레드를 찾습니다."
            : "입력한 조건을 모두 만족하는 글을 찾습니다. 작성자나 태그를 지정하면 일반 글만 표시됩니다."}
        </p>
      </details>
      {cinema ? (
        <p id="feed-search-help" className="community-search-help">
          검색어는 1~100자이며 댓글은 찾지 않습니다.
        </p>
      ) : (
        <p id="feed-search-help" className="community-search-help">
          검색어 1~100자 · 댓글 제외 · 영문 대소문자 구분 없음 · %, _도 입력한
          문자 그대로 검색
        </p>
      )}
      {error && (
        <p
          ref={feedback}
          tabIndex={-1}
          role="alert"
          className="community-search-error"
        >
          {error}
        </p>
      )}
    </form>
  );
}
