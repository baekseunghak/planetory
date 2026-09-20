import { useCallback } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import { pagePath } from "../../app/paths";
import { ErrorState } from "../../components/RequestState";
import { CommunityFeed } from "./CommunityFeed";
import { Pager } from "./CommunityPagination";
import { endpoint, readHotTopics } from "./contracts";
import { usePageScroll } from "./usePageScroll";
import { useReadModel } from "./useReadModel";
import "./community.css";

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
      <header className="community-heading">
        <p className="eyebrow">COMMUNITY · 여러 탐사자가 함께 살펴본 신호</p>
        <h1>핫 토픽</h1>
        <p>공개 분석 참여자가 10명 이상인 공식 신호 스레드입니다.</p>
      </header>
      <nav className="community-tabs" aria-label="게시판 종류">
        <Link to="/community" state={null}>
          전체
        </Link>
        <Link to="/community?board=STAR" state={null}>
          별 게시판
        </Link>
        <Link to="/community?board=FREE" state={null}>
          자유 게시판
        </Link>
        <Link to={pagePath("hotTopics")} state={null} aria-current="page">
          핫 토픽
        </Link>
      </nav>
      <details className="hot-topic-guide">
        <summary>핫 토픽은 어떻게 선정되나요?</summary>
        <p>
          같은 신호에 공개 분석을 남긴 회원의 가장 최근 유효 판단을 한 건씩
          셉니다. ‘행성 같음’, ‘아닌 것 같음’, ‘모르겠음’을 모두 합쳐 10명
          이상이면 선정됩니다. 같은 회원이 여러 번 제출하거나 판단을 바꿔도
          인원은 늘지 않습니다.
        </p>
        <p>
          기간 제한 없이 현재 참여자 수가 많은 순으로 보여줍니다. 인원이 같으면
          스레드 생성 시각, 스레드 ID가 최신인 순입니다. 일반
          글·댓글·동의·비동의 수는 선정에 사용하지 않습니다.
        </p>
        <p>
          공개 취소나 숨김으로 유효 참여자가 10명 미만이 되면 다음 조회에서
          제외되며, 다시 10명 이상이면 돌아옵니다. 삭제되거나 숨겨진 스레드는
          표시하지 않습니다. 참여자 수와 판단 분포는 행성일 확률이나 성과 점수가
          아닙니다.
        </p>
      </details>
      <section aria-label="핫 토픽 목록" aria-busy={state.loading}>
        <div className="hot-topic-toolbar">
          <p role="status">
            {state.loading
              ? "핫 토픽을 불러오고 있습니다…"
              : state.error
                ? "핫 토픽을 불러오지 못했습니다."
                : "현재 공개 분석 참여자 순 · 기간 제한 없음"}
          </p>
          {!state.error && (
            <button onClick={state.reload} disabled={state.loading}>
              최신 목록 확인
            </button>
          )}
        </div>
        {state.error && <ErrorState error={state.error} retry={state.reload} />}
        {cursor !== null && (state.error || state.data?.items.length === 0) && (
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
            <CommunityFeed items={state.data.items} hot />
            <Pager page={state.data} name="cursor" label="핫 토픽 페이지" />
          </>
        )}
      </section>
    </div>
  );
}
