import { MaterialCards } from "./MaterialCards";
import { useCallback, useState } from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "../../api";
import { pagePath, safeReturnTo } from "../../app/paths";
import { ErrorState, LoadingState } from "../../components/RequestState";
import {
  assertIdentity,
  endpoint,
  judgmentLabels,
  judgments,
  readAnalyses,
  readFeed,
  readPost,
  readThread,
  type Author,
  type Summary,
} from "./contracts";
import { useReadModel } from "./useReadModel";
import { usePageScroll } from "./usePageScroll";
import "./community.css";
import { Pager } from "./CommunityPagination";
import { Discussion } from "./Discussion";
import { PostReactions } from "./PostReactions";
import { PostActions } from "./PostActions";

function DateTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
function AuthorLink({ author }: { author: Author }) {
  const location = useLocation();
  return (
    <Link
      to={pagePath(
        "member",
        { memberId: author.memberId },
        { returnTo: location.pathname + location.search },
      )}
    >
      {author.nickname}
    </Link>
  );
}
function StarLink({ ticId }: { ticId: string }) {
  return (
    <Link className="community-tic" to={pagePath("starBoard", { ticId })}>
      TIC {ticId}
    </Link>
  );
}
function ReadState({
  state,
}: {
  state: { loading: boolean; error: Error | null; reload: () => void };
}) {
  return state.error ? (
    <ErrorState error={state.error} retry={state.reload} />
  ) : (
    <LoadingState />
  );
}

export function CommunityPage() {
  const { ticId } = useParams<"ticId">();
  const [search] = useSearchParams();
  const location = useLocation();
  const board = ticId
    ? "STAR"
    : search.get("board") === "FREE"
      ? "FREE"
      : search.get("board") === "STAR"
        ? "STAR"
        : null;
  const cursor = search.get("cursor");
  const path = endpoint("/v1/community/feed", {
    board,
    ticId,
    cursor,
    size: "20",
  });
  const load = useCallback(
    async (signal: AbortSignal) =>
      readFeed(await api(path, { signal }), cursor),
    [path, cursor],
  );
  const state = useReadModel(path, load);
  usePageScroll(!state.loading);
  const current = location.pathname + location.search;
  return (
    <div className="community-page">
      <header className="community-heading">
        <p className="eyebrow">COMMUNITY · 함께 살펴보는 신호</p>
        <h1>{ticId ? `TIC ${ticId}` : "탐사 이야기"}</h1>
        <p>
          {ticId
            ? "이 별의 이야기와 공식 신호 스레드를 모았습니다."
            : "서로의 관측을 읽고, 같은 신호에 대한 생각을 나눠 보세요."}
        </p>
      </header>
      <div className="post-actions">
        <Link
          to={
            pagePath("postCreate", {}, { ticId, returnTo: current }) +
            (!ticId && board === "STAR" ? "&board=STAR" : "")
          }
        >
          새 글 쓰기
        </Link>
      </div>
      <nav className="community-tabs" aria-label="게시판 종류">
        <Link to="/community" aria-current={!board ? "page" : undefined}>
          전체
        </Link>
        <Link
          to="/community?board=STAR"
          aria-current={board === "STAR" ? "page" : undefined}
        >
          별 게시판
        </Link>
        <Link
          to="/community?board=FREE"
          aria-current={board === "FREE" ? "page" : undefined}
        >
          자유 게시판
        </Link>
      </nav>
      <section aria-label="게시글 목록">
        {!state.data ? (
          <ReadState state={state} />
        ) : (
          <>
            {!state.data.items.length && (
              <p className="community-empty">
                {cursor
                  ? "이 페이지에 표시할 글이 없습니다. 처음 페이지에서 다시 확인해 주세요."
                  : "아직 게시글이 없습니다."}
              </p>
            )}
            <ul className="community-feed">
              {state.data.items.map((item) => (
                <li key={`${item.type}:${item.id}`}>
                  <div className="community-row-meta">
                    <span
                      className={
                        item.type === "SIGNAL_THREAD"
                          ? "community-official"
                          : ""
                      }
                    >
                      {item.type === "SIGNAL_THREAD"
                        ? "공식 신호 스레드 · SYSTEM"
                        : "일반 글"}
                    </span>
                    {item.ticId ? (
                      <StarLink ticId={item.ticId} />
                    ) : (
                      <span>자유 게시판</span>
                    )}
                  </div>
                  <h2>
                    <Link
                      state={location.state}
                      to={
                        item.type === "POST"
                          ? pagePath(
                              "post",
                              { postId: item.id },
                              { returnTo: current },
                            )
                          : pagePath(
                              "thread",
                              { threadId: item.id },
                              { returnTo: current },
                            )
                      }
                    >
                      {item.title}
                    </Link>
                  </h2>
                  <div className="community-row-meta">
                    {"memberId" in item.author && (
                      <AuthorLink author={item.author} />
                    )}
                    <DateTime value={item.createdAt} />
                    <span>토론 {item.commentCount.toLocaleString()}개</span>
                    {item.judgmentSummary && (
                      <span>
                        {item.judgmentSummary.participantCount
                          ? `공개 분석 참여자 ${item.judgmentSummary.participantCount.toLocaleString()}명`
                          : "아직 공개된 분석이 없습니다"}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <Pager page={state.data} name="cursor" label="게시글 페이지" />
          </>
        )}
      </section>
    </div>
  );
}

function DetailBack() {
  const [search] = useSearchParams();
  const location = useLocation();
  return (
    <Link
      className="community-back"
      to={safeReturnTo(search.get("returnTo"), "/community")}
      state={location.state}
    >
      ← 이전 화면
    </Link>
  );
}
export function PostPage() {
  const { postId = "" } = useParams<"postId">();
  const path = `/v1/posts/${encodeURIComponent(postId)}`;
  const [denied, setDenied] = useState<{ id: string; error: Error } | null>(
    null,
  );
  const onUnavailable = useCallback(
    (error: Error) => setDenied({ id: postId, error }),
    [postId],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      const post = readPost(await api(path, { signal }));
      assertIdentity(post.postId, postId);
      return { post };
    },
    [path, postId],
  );
  const state = useReadModel(path, load);
  usePageScroll(!state.loading);
  return (
    <div className="community-page community-detail">
      <DetailBack />
      <PostActions
        key={postId}
        postId={postId}
        post={denied?.id === postId ? null : (state.data?.post ?? null)}
        onUnavailable={onUnavailable}
      />
      {denied?.id === postId ? (
        <ErrorState
          retry={() => window.location.reload()}
          error={denied.error}
        />
      ) : !state.data ? (
        <ReadState state={state} />
      ) : (
        <>
          <article>
            <header className="community-heading">
              <div className="community-row-meta">
                <span>일반 글</span>
                {state.data.post.ticId ? (
                  <StarLink ticId={state.data.post.ticId} />
                ) : (
                  <span>자유 게시판</span>
                )}
              </div>
              <h1>{state.data.post.title}</h1>
              <div className="community-row-meta">
                <AuthorLink author={state.data.post.author} />
                <DateTime value={state.data.post.createdAt} />
                {state.data.post.updatedAt !== state.data.post.createdAt && (
                  <span>수정됨</span>
                )}
              </div>
            </header>
            <p className="community-body community-post-body">
              {state.data.post.body}
            </p>
            <MaterialCards
              value={state.data.post}
              ticId={state.data.post.ticId}
              parentType="POST"
              parentId={postId}
              author={state.data.post.author}
            />
          </article>
        </>
      )}
      <PostReactions
        key={`reactions:${postId}`}
        postId={postId}
        active={denied?.id !== postId && !!state.data}
        onUnavailable={onUnavailable}
      />
      <Discussion
        key={`comments:${postId}`}
        parent={{ parentType: "POST", parentId: postId }}
        ticId={state.data?.post.ticId ?? null}
        active={denied?.id !== postId && !!state.data}
        onUnavailable={onUnavailable}
      />
    </div>
  );
}

function JudgmentSummary({ summary }: { summary: Summary }) {
  const rows = [
    ["likelyPlanet", "행성 같음"],
    ["unlikelyPlanet", "아닌 것 같음"],
    ["unsure", "모르겠음"],
  ] as const;
  return (
    <section className="community-summary" aria-label="공개 판단 요약">
      <div>
        <p className="eyebrow">공개 분석의 판단</p>
        <h2>참여자 {summary.participantCount.toLocaleString()}명</h2>
        <p>
          회원마다 가장 최근의 유효한 공개 제출 한 건을 집계합니다.
          <br />
          행성일 확률이나 성과 점수가 아닙니다.
        </p>
        {summary.asOf && (
          <small>
            <DateTime value={summary.asOf} /> 기준
          </small>
        )}
      </div>
      {!summary.participantCount ? (
        <p className="community-empty">아직 공개된 분석이 없습니다.</p>
      ) : (
        <dl className="community-distribution">
          {rows.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                <span>
                  {summary[key].toLocaleString()}명 ·{" "}
                  {summary.percentages?.[key]}%
                </span>
                <span className={`community-meter ${key}`} aria-hidden="true">
                  <i style={{ width: `${summary.percentages?.[key] ?? 0}%` }} />
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
export function SignalThreadPage() {
  const { threadId = "" } = useParams<"threadId">();
  const [search] = useSearchParams();
  const location = useLocation();
  const selected =
    judgments.find((value) => value === search.get("judgment")) ?? null;
  const cursor = search.get("analysesCursor");
  const path = `/v1/signal-threads/${encodeURIComponent(threadId)}`;
  const [denied, setDenied] = useState<{ id: string; error: Error } | null>(
    null,
  );
  const onUnavailable = useCallback(
    (error: Error) => setDenied({ id: threadId, error }),
    [threadId],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      const thread = readThread(await api(path, { signal }));
      assertIdentity(thread.threadId, threadId);
      // A hidden/missing parent never renders child data, including partial successes.
      const analyses = await api(
        endpoint(`${path}/analyses`, {
          judgment: selected,
          cursor,
          size: "20",
        }),
        { signal },
      ).then((value) => readAnalyses(value, cursor));
      return { thread, analyses };
    },
    [path, threadId, selected, cursor],
  );
  const state = useReadModel(`${path}:${selected}:${cursor}`, load);
  usePageScroll(!state.loading);
  const filterLink = (value: string | null) => {
    const next = new URLSearchParams(search);
    next.delete("analysesCursor");
    if (value) next.set("judgment", value);
    else next.delete("judgment");
    return location.pathname + (next.size ? `?${next}` : "");
  };
  return (
    <div className="community-page community-detail">
      <DetailBack />
      {denied?.id === threadId ? (
        <ErrorState
          retry={() => window.location.reload()}
          error={denied.error}
        />
      ) : !state.data ? (
        <ReadState state={state} />
      ) : (
        <>
          <header className="community-heading">
            <div className="community-row-meta">
              <span className="community-official">
                공식 신호 스레드 · SYSTEM
              </span>
              <StarLink ticId={state.data.thread.ticId} />
            </div>
            <h1>{state.data.thread.title}</h1>
            <p>
              신호 {state.data.thread.candidateId} · 같은 신호를 분석한 회원들의
              공개 기록과 토론입니다.
            </p>
          </header>
          <JudgmentSummary summary={state.data.thread.judgmentSummary} />
          <section aria-label="공개 분석">
            <h2>공개 분석</h2>
            <p>
              목록에는 과거 공개 기록도 포함됩니다. 필터를 바꿔도 전체 참여자
              수는 달라지지 않습니다.
            </p>
            <nav className="community-tabs" aria-label="판단 필터">
              {[null, ...judgments].map((value) => (
                <Link
                  key={value ?? "ALL"}
                  to={filterLink(value)}
                  state={{
                    ...location.state,
                    communityCursors: {
                      ...location.state?.communityCursors,
                      analysesCursor: [],
                    },
                  }}
                  aria-current={selected === value ? "page" : undefined}
                >
                  {value ? judgmentLabels[value] : "전체"}
                </Link>
              ))}
            </nav>
            {!state.data.analyses.items.length && (
              <p className="community-empty">
                {selected
                  ? "이 판단으로 공개된 분석이 없습니다."
                  : "이 페이지에 공개된 분석이 없습니다."}
              </p>
            )}
            <ul className="community-analyses">
              {state.data.analyses.items.map((item) => (
                <li key={item.analysisId}>
                  <div>
                    <Link
                      className="community-analysis-title"
                      to={pagePath(
                        "publicAnalysis",
                        { analysisId: item.analysisId },
                        { returnTo: location.pathname + location.search },
                      )}
                    >
                      {item.author.nickname}님의 공개 분석
                    </Link>
                    <div className="community-row-meta">
                      <AuthorLink author={item.author} />
                      <span>
                        제출 <DateTime value={item.submittedAt} />
                      </span>
                      {item.contributesToSummary === true && (
                        <span>현재 판단 집계에 반영</span>
                      )}
                      {item.contributesToSummary === false && (
                        <span>과거 공개 기록</span>
                      )}
                    </div>
                  </div>
                  <span>{judgmentLabels[item.judgment]}</span>
                </li>
              ))}
            </ul>
            <Pager
              page={state.data.analyses}
              name="analysesCursor"
              label="공개 분석 페이지"
            />
          </section>
        </>
      )}
      <Discussion
        key={threadId}
        parent={{ parentType: "SIGNAL_THREAD", parentId: threadId }}
        ticId={state.data?.thread.ticId ?? null}
        active={denied?.id !== threadId && !!state.data}
        onUnavailable={onUnavailable}
      />
    </div>
  );
}
