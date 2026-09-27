import { ExpandableFeed } from "./ExpandableFeed";
import { CommunityTabs } from "./CommunityTabs";
import { useCallback, useState, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import { pagePath } from "../../app/paths";
import { ErrorState } from "../../components/RequestState";
import { endpoint, readHotTopics } from "./contracts";
import { usePageScroll } from "./usePageScroll";
import { useReadModel } from "./useReadModel";
import "./community.css";
import { CommunityAside } from "./CommunityAside";

export function HotTopicsPage() {
  const [search] = useSearchParams();
  const location = useLocation();
  const cursor = search.get("cursor");
  const invalidCursor = search.getAll("cursor").length > 1 || cursor === "";
  const path = endpoint("/v1/community/hot-topics", { size: "20", cursor });
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (invalidCursor)
        throw new ApiError(
          400,
          "VALIDATION_FAILED",
          "목록의 처음 페이지에서 다시 확인해 주세요.",
        );
      return readHotTopics(await api(path, { signal }), cursor);
    },
    [path, cursor, invalidCursor],
  );
  const state = useReadModel(path + (invalidCursor ? ":invalid" : ""), load);
  const current = location.pathname + location.search;
  const restoration = location.state?.communityRestore;
  usePageScroll(
    Boolean(state.data),
    restoration?.path === current && typeof restoration.key === "string"
      ? restoration.key
      : undefined,
  );
  return (
    <div className="community-page">
      <header className="community-heading community-top-heading service-section-heading">
        <h1>커뮤니티</h1>
        <p>서로의 관측을 읽고, 같은 신호에 대한 생각을 나눠 보세요.</p>
      </header>
<CommunityTabs active="hot" />
      <div className="community-columns">
        <div className="community-main">
          <section
            className="hot-topic-panel"
            aria-label="핫 토픽 목록"
            aria-busy={state.loading}
          >
            <div className="hot-topic-toolbar">
              <h2>핫 토픽</h2>
              <p role="status">
                {state.loading
                  ? "핫 토픽을 불러오고 있습니다…"
                  : state.error
                    ? "핫 토픽을 불러오지 못했습니다."
                    : "공개 분석 참여자 많은 순"}
              </p>
              <HotTopicHelp />
              {!state.error && (
                <button
                  className="hot-topic-refresh"
                  aria-label="최신 목록 확인"
                  title="최신 목록 확인"
                  onClick={state.reload}
                  disabled={state.loading}
                >
                  <svg
                    aria-hidden="true"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7v5l-4-4" />
                  </svg>
                </button>
              )}
            </div>
            {state.error && (
              <ErrorState error={state.error} retry={state.reload} />
            )}
            {cursor !== null &&
              (state.error || state.data?.items.length === 0) && (
                <Link to={pagePath("hotTopics")} state={null}>
                  핫 토픽 처음 페이지로
                </Link>
              )}
            {state.data && (
              <>
                {!state.data.items.length && (
                  <p className="community-empty">
                    {cursor
                      ? "이 페이지에 표시할 핫 토픽이 없습니다. 처음 페이지에서 다시 확인해 주세요."
                      : "아직 선정된 핫 토픽이 없습니다. 공개 분석 참여자가 10명 이상인 신호가 생기면 여기에 표시됩니다."}
                  </p>
                )}
                <ExpandableFeed
                  key={path}
                  initial={state.data}
                  path={path}
                  decode={readHotTopics}
                  hot
                />
              </>
            )}
          </section>
        </div>
        <CommunityAside hot={false} />
      </div>
    </div>
  );
}

function HotTopicHelp() {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="hot-topic-help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPinned(false);
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          trigger.current?.focus();
          setPinned(false);
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="핫 토픽 선정 기준"
        aria-expanded={open}
        aria-controls="hot-topic-help-content"
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6" strokeLinecap="round" />
          <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <div
        id="hot-topic-help-content"
        className="hot-topic-help-bubble"
        hidden={!open}
      >
        <strong>핫 토픽 선정 기준</strong>
        <p>공개 분석 참여자 10명 이상 · 참여자 많은 순 · 기간 제한 없음</p>
        <details>
          <summary>세부 기준 보기</summary>{" "}
          <p>
            같은 신호에 공개 분석을 남긴 회원의 가장 최근 유효 판단을 한 건씩
            셉니다. ‘행성 같음’, ‘아닌 것 같음’, ‘모르겠음’을 모두 합쳐 10명
            이상이면 선정됩니다. 같은 회원이 여러 번 제출하거나 판단을 바꿔도
            인원은 늘지 않습니다.
          </p>
          <p>
            기간 제한 없이 현재 참여자 수가 많은 순으로 보여줍니다. 인원이
            같으면 스레드 생성 시각, 스레드 ID가 최신인 순입니다. 일반
            글·댓글·동의·비동의 수는 선정에 사용하지 않습니다.
          </p>
          <p>
            공개 취소나 숨김으로 유효 참여자가 10명 미만이 되면 다음 조회에서
            제외되며, 다시 10명 이상이면 돌아옵니다. 삭제되거나 숨겨진 스레드는
            표시하지 않습니다. 참여자 수와 판단 분포는 행성일 확률이나 성과
            점수가 아닙니다.
          </p>
        </details>
      </div>
    </div>
  );
}
