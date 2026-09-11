import { useEffect, useState, type FormEvent } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ArrowUpRight, MessageSquare, Plus, Search } from "lucide-react";
import type {
  Post,
  PostDetail,
  Page,
  History,
  SourceRef,
  SourceCard,
  PublicAnalysis,
  Distribution,
  Tag,
  Comment,
} from "../../shared/types";
import { JUDGMENTS, TAGS, OUTCOMES } from "../../shared/types";
import { api, mutation, query } from "../api/client";
import { useResource } from "../api/hooks";
import { useApp } from "../App";
import {
  ActionError,
  AI,
  Back,
  DistributionView,
  Empty,
  Field,
  Modal,
  PageTitle,
  Pager,
  RequestState,
  date,
  useAction,
} from "../components/ui";
import { RecordView } from "../components/RecordView";
export function CommunityPage() {
  const { starId } = useParams(),
    [search, setSearch] = useSearchParams();
  const tab = search.get("tab") || "all",
    q = search.get("q") || "",
    kind = search.get("kind") || "all",
    tag = search.get("tag") || "all",
    page = Number(search.get("page") || 1);
  const r = useResource<Page<Post> & { hotRule: string }>(
    "/community/posts?" + query({ starId, tab, q, kind, tag, page }),
  );
  const change = (key: string, value: string) =>
    setSearch((s) => {
      s.set(key, value);
      if (key !== "page") s.set("page", "1");
      return s;
    });
  return (
    <main className="page community-page">
      <PageTitle
        eyebrow={starId ? "STAR COMMUNITY" : "TOGETHER, WE EXPLORE"}
        title={starId ? "TIC " + starId + " 게시판" : "함께 살펴보는 우주"}
        description={
          starId
            ? "같은 별의 기록과 생각을 나누는 공간"
            : "하나의 신호, 서로 다른 시선. 기록을 나누고 함께 질문하세요."
        }
        actions={
          <Link
            className="button primary"
            to={"/community/new" + (starId ? "?star=" + starId : "")}
          >
            <Plus size={16} />
            글쓰기
          </Link>
        }
      />
      {starId && <Back to="/community" label="전체 커뮤니티" />}
      <nav className="tabs" aria-label="피드 종류">
        {[
          ["all", "전체"],
          ["following", "팔로우"],
          ["hot", "핫 스레드"],
          ["mine", "내 스레드"],
        ].map(([k, label]) => (
          <button
            key={k}
            aria-pressed={tab === k}
            onClick={() => change("tab", k)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="커뮤니티 검색"
            value={q}
            onChange={(e) => change("q", e.target.value)}
            placeholder="제목, 본문, 작성자, TIC 검색"
          />
        </label>
        <select
          aria-label="게시판 종류"
          value={kind}
          onChange={(e) => change("kind", e.target.value)}
        >
          <option value="all">모든 게시판</option>
          <option value="star">별 게시판</option>
          <option value="free">자유 게시판</option>
          <option value="system_thread">공식 신호 스레드</option>
        </select>
        <select
          aria-label="목적 태그"
          value={tag}
          onChange={(e) => change("tag", e.target.value)}
        >
          <option value="all">모든 목적</option>
          {Object.entries(TAGS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {tab === "hot" && <p className="notice">{r.data?.hotRule}</p>}
      <RequestState state={r} />
      {r.data && !r.data.total && (
        <Empty title="아직 게시글이 없습니다">
          <p>
            {tab === "following"
              ? "회원이나 별을 팔로우하면 새 글이 여기에 모입니다."
              : "첫 번째 이야기를 남겨 보세요."}
          </p>
        </Empty>
      )}
      <div className="feed">
        {r.data?.items.map((post) => (
          <article key={post.id} className={"post-card " + post.kind}>
            <div className="post-meta">
              <span className="tag">
                {post.kind === "system_thread"
                  ? "공식 신호 스레드"
                  : TAGS[post.tag]}
              </span>
              {post.starId ? (
                <Link
                  className="star-chip"
                  to={"/community/stars/" + post.starId}
                >
                  TIC {post.starId}
                </Link>
              ) : (
                <span>자유 게시판</span>
              )}
              <time>{date(post.createdAt)}</time>
            </div>
            <Link className="post-title" to={"/community/posts/" + post.id}>
              <h2>{post.title}</h2>
              <ArrowUpRight size={18} />
            </Link>
            <p className="post-excerpt">{post.body}</p>
            <footer>
              {post.memberId ? (
                <Link to={"/members/" + post.memberId}>{post.author}</Link>
              ) : (
                <span>SYSTEM · 공통 공간</span>
              )}
              <span>
                <MessageSquare size={14} />
                {post.commentCount}
                {post.kind === "general" && (
                  <>
                    {" "}
                    · 동의 {post.agree} · 비동의 {post.disagree}
                  </>
                )}
              </span>
            </footer>
          </article>
        ))}
      </div>
      {r.data && (
        <Pager data={r.data} onPage={(n) => change("page", String(n))} />
      )}
    </main>
  );
}
function Source({ source }: { source: SourceCard }) {
  if (!source.available)
    return (
      <div className="source-card unavailable">현재 볼 수 없는 출처입니다.</div>
    );
  return (
    <div className="source-card">
      <small>공개 출처 · {source.author || "SYSTEM"}</small>
      <Link
        to={
          source.kind === "thread"
            ? "/community/posts/" + source.id
            : "/community/analyses/" + source.id
        }
      >
        <strong>{source.title}</strong> ↗
      </Link>
      {source.signalSummary && (
        <p className="source-summary">
          반복 주기 {source.signalSummary.period}일 · 가려진 시간{" "}
          {source.signalSummary.duration * 24}시간 · 어두워진 정도{" "}
          {source.signalSummary.depth}%
          <small>데이터 판: {source.signalSummary.bundleId}</small>
        </p>
      )}
      {source.distribution && <DistributionView data={source.distribution} />}
      <div className="source-filters">
        {source.kind === "thread" &&
          Object.entries(JUDGMENTS).map(([j, label]) => (
            <Link
              key={j}
              to={"/community/posts/" + source.id + "?judgment=" + j}
            >
              {label} 분석 보기
            </Link>
          ))}
      </div>
    </div>
  );
}
export function Attachment({
  postId,
  historyId,
  commentId,
}: {
  postId: string;
  historyId: string;
  commentId?: string;
}) {
  const [open, setOpen] = useState(false);
  const r = useResource<History>(
    open
      ? "/community/attachment?" + query({ postId, historyId, commentId })
      : null,
  );
  return (
    <div className="attachment">
      <button onClick={() => setOpen(!open)}>
        내 분석 기록 첨부 · {historyId} {open ? "접기" : "열기"}
      </button>
      {open && (
        <>
          <RequestState state={r} />
          {r.data && (
            <RecordView
              history={r.data}
              actions={false}
              replayPath={query("/community/attachment", {
                postId,
                historyId,
                commentId,
                replay: true,
              })}
            />
          )}
        </>
      )}
    </div>
  );
}
function CommentCard({
  comment: c,
  postId,
  starId,
  reload,
}: {
  comment: Comment;
  postId: string;
  starId: string | null;
  reload: () => void;
}) {
  const { member } = useApp(),
    [edit, setEdit] = useState(false),
    [remove, setRemove] = useState(false),
    a = useAction();
  return (
    <article className="comment">
      <div className="comment-meta">
        <Link to={"/members/" + c.memberId}>{c.author}</Link>
        <small>{date(c.createdAt)}</small>
        {c.memberId === member.id && (
          <div className="actions">
            <button className="text-button" onClick={() => setEdit(!edit)}>
              수정
            </button>
            <button className="text-button" onClick={() => setRemove(true)}>
              삭제
            </button>
          </div>
        )}
      </div>
      {edit ? (
        <CommentEditor
          postId={postId}
          starId={starId}
          initial={c}
          done={() => {
            setEdit(false);
            reload();
          }}
        />
      ) : (
        <p className="post-body">{c.body}</p>
      )}
      {c.attachments.map((id) => (
        <Attachment key={id} postId={postId} historyId={id} commentId={c.id} />
      ))}
      {c.sources.map((ref) => (
        <LoadedSource key={ref.kind + ref.id} reference={ref} />
      ))}
      {remove && (
        <Modal title="댓글을 삭제할까요?" onClose={() => setRemove(false)}>
          <p>첨부한 개인 분석 기록은 유지됩니다.</p>
          <ActionError message={a.error} />
          <div className="actions">
            <button onClick={() => setRemove(false)}>취소</button>
            <button
              className="danger"
              disabled={a.pending}
              onClick={() =>
                a.run(async () => {
                  await api("/community/comments/" + c.id, {
                    method: "DELETE",
                  });
                  setRemove(false);
                  reload();
                })
              }
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}
function LoadedSource({ reference }: { reference: SourceRef }) {
  const r = useResource<SourceCard>(
    "/community/source?" + query({ ...reference }),
  );
  return r.data ? <Source source={r.data} /> : <RequestState state={r} />;
}
function LinkPicker({
  starId,
  attachments,
  sources,
  onAttachments,
  onSources,
}: {
  starId: string | null;
  attachments: string[];
  sources: SourceRef[];
  onAttachments: (v: string[]) => void;
  onSources: (v: SourceRef[]) => void;
}) {
  const [historyPage, setHistoryPage] = useState(1);
  useEffect(() => setHistoryPage(1), [starId]);
  const histories = useResource<Page<History>>(
      starId
        ? "/history?" + query({ starId, page: historyPage, pageSize: 20 })
        : null,
    ),
    refs = useResource<{ items: SourceCard[] }>(
      starId ? "/community/sources?" + query({ starId }) : null,
    );
  if (!starId) return null;
  return (
    <div className="link-picker">
      <details>
        <summary>같은 별의 내 분석 기록 첨부 ({attachments.length})</summary>
        <RequestState state={histories} />
        {histories.data && !histories.data.total && (
          <p className="muted">이 별에 제출한 내 기록이 없습니다.</p>
        )}
        {histories.data?.items.map((h) => (
          <label className="checkbox-line" key={h.id}>
            <input
              type="checkbox"
              checked={attachments.includes(h.id)}
              onChange={(e) =>
                onAttachments(
                  e.target.checked
                    ? [...attachments, h.id]
                    : attachments.filter((x) => x !== h.id),
                )
              }
            />
            {date(h.submittedAt)} ·{" "}
            {h.judgment ? JUDGMENTS[h.judgment] : "판단 없음"} ·{" "}
            {OUTCOMES[h.outcome]}
          </label>
        ))}
        {histories.data && (
          <Pager data={histories.data} onPage={setHistoryPage} />
        )}
      </details>
      <details>
        <summary>공개 출처 링크 ({sources.length})</summary>
        <RequestState state={refs} />
        {refs.data && !refs.data.items.length && (
          <p className="muted">연결할 수 있는 공개 출처가 없습니다.</p>
        )}
        {refs.data?.items.map((ref) => (
          <label className="checkbox-line" key={ref.kind + ref.id}>
            <input
              type="checkbox"
              checked={sources.some(
                (r) => r.id === ref.id && r.kind === ref.kind,
              )}
              onChange={(e) =>
                onSources(
                  e.target.checked
                    ? [...sources, { kind: ref.kind, id: ref.id }]
                    : sources.filter(
                        (r) => r.id !== ref.id || r.kind !== ref.kind,
                      ),
                )
              }
            />
            {ref.title} · {ref.author || "SYSTEM"}
            {ref.submittedAt && (
              <>
                {" "}
                · {date(ref.submittedAt)} ·{" "}
                {ref.judgment ? JUDGMENTS[ref.judgment] : "판단 없음"}
              </>
            )}
          </label>
        ))}
      </details>
      <small>
        일반 첨부·출처 연결은 분석 공개나 성과 인정으로 처리되지 않습니다.
      </small>
    </div>
  );
}
function CommentEditor({
  postId,
  starId,
  initial,
  suggestedHistoryId,
  done,
}: {
  postId: string;
  starId: string | null;
  initial?: Comment;
  suggestedHistoryId?: string | null;
  done: () => void;
}) {
  const [body, setBody] = useState(initial?.body || ""),
    [attachments, setAttachments] = useState<string[]>(
      initial?.attachments || [],
    ),
    [sources, setSources] = useState<SourceRef[]>(initial?.sources || []),
    a = useAction();
  const suggested = useResource<History>(
    !initial && suggestedHistoryId && starId
      ? "/history/" + encodeURIComponent(suggestedHistoryId)
      : null,
  );
  const { member } = useApp();
  const [dismissed, setDismissed] = useState(false);
  const validSuggestion =
    suggested.data?.starId === starId && suggested.data?.memberId === member.id;
  return (
    <form
      className="comment-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await mutation(
            "/community/posts/" +
              postId +
              "/comments" +
              (initial ? "/" + initial.id : ""),
            { body, attachments, sources },
            initial ? "PATCH" : "POST",
          );
          setBody("");
          setAttachments([]);
          setSources([]);
          setDismissed(true);
          done();
        });
      }}
    >
      {suggestedHistoryId && !initial && !dismissed && (
        <aside className="notice attachment-suggestion">
          <RequestState state={suggested} />
          {suggested.data &&
            (validSuggestion ? (
              <>
                <p>
                  방금 만든 분석 기록을 댓글에 첨부할 수 있습니다. 선택해도
                  댓글이 자동 등록되지는 않습니다.
                </p>
                <button
                  type="button"
                  disabled={attachments.includes(suggested.data.id)}
                  onClick={() =>
                    setAttachments((a) => [
                      ...new Set([...a, suggested.data!.id]),
                    ])
                  }
                >
                  {attachments.includes(suggested.data.id)
                    ? "첨부 후보 선택됨"
                    : "방금 만든 기록 첨부"}
                </button>
              </>
            ) : (
              <p>이 별의 본인 기록만 첨부할 수 있습니다.</p>
            ))}
          <button type="button" onClick={() => setDismissed(true)}>
            제안 닫기
          </button>
        </aside>
      )}
      <label className="field">
        <span>{initial ? "댓글 수정" : "토론에 참여하기"}</span>
        <textarea
          aria-label="댓글 내용"
          required
          maxLength={10000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="질문이나 의견을 남겨 주세요."
        />
      </label>
      <LinkPicker
        starId={starId}
        attachments={attachments}
        sources={sources}
        onAttachments={setAttachments}
        onSources={setSources}
      />
      <ActionError message={a.error} />
      <button className="primary" disabled={a.pending}>
        {a.pending ? "저장 중…" : initial ? "댓글 수정 저장" : "댓글 등록"}
      </button>
    </form>
  );
}
export function PostPage() {
  const { postId } = useParams(),
    [params] = useSearchParams();
  return (
    <PostContent
      key={
        postId +
        ":" +
        (params.get("returnStarId") || "") +
        ":" +
        (params.get("suggestHistoryId") || "")
      }
    />
  );
}
function PostContent() {
  const { postId } = useParams(),
    [params, setParams] = useSearchParams(),
    returnStarId = params.get("returnStarId"),
    r = useResource<PostDetail>(
      returnStarId
        ? query("/community/posts/" + postId, { returnStarId })
        : "/community/posts/" + postId,
    ),
    { member } = useApp(),
    navigate = useNavigate(),
    a = useAction(),
    [remove, setRemove] = useState(false),
    [reactors, setReactors] = useState<{
      title: string;
      items: { id: string; nickname: string }[];
    } | null>(null),
    [analysisPage, setAnalysisPage] = useState(1);
  if (!r.data)
    return (
      <main className="page">
        <Back
          to={returnStarId ? "/results/" + returnStarId : "/community"}
          label={returnStarId ? "분석한 별 결과로 돌아가기" : "돌아가기"}
        />
        <RequestState state={r} />
      </main>
    );
  const { post, comments, signal, distribution } = r.data;
  // Recheck in the UI too: a stale or incompatible API must not display another TIC.
  if (returnStarId && post.starId !== returnStarId)
    return (
      <main className="page">
        <Back
          to={"/results/" + returnStarId}
          label="분석한 별 결과로 돌아가기"
        />
        <p role="alert" className="error-box">
          게시글의 별이 변경되어 원래 글로 돌아갈 수 없습니다.
        </p>
        <Link className="button" to={"/community/stars/" + returnStarId}>
          분석한 별의 게시판 보기
        </Link>
      </main>
    );
  const judgment = params.get("judgment") || "all";
  const filtered = r.data.analyses.filter(
    (a) => judgment === "all" || a.history.judgment === judgment,
  );
  return (
    <main className="page post-page">
      <Back
        to={post.starId ? "/community/stars/" + post.starId : "/community"}
      />
      <article className="post-full">
        <div className="post-meta">
          <span className="tag">
            {post.kind === "system_thread"
              ? "공식 신호 스레드"
              : TAGS[post.tag]}
          </span>
          {post.starId && (
            <Link to={"/community/stars/" + post.starId}>
              TIC {post.starId}
            </Link>
          )}
          <time>{date(post.createdAt)}</time>
        </div>
        <h1>{post.title}</h1>
        <div className="post-author">
          {post.memberId ? (
            <Link to={"/members/" + post.memberId}>{post.author}</Link>
          ) : (
            <strong>SYSTEM · 모든 참여자의 공통 공간</strong>
          )}
          <div className="actions">
            {post.memberId && post.memberId !== member.id && (
              <button
                disabled={a.pending}
                onClick={() =>
                  a.run(async () => {
                    await mutation("/follows", {
                      kind: "member",
                      id: post.memberId,
                      active: !post.followingAuthor,
                    });
                    r.reload();
                  })
                }
              >
                {post.followingAuthor ? "회원 팔로우 취소" : "회원 팔로우"}
              </button>
            )}
            {post.starId && (
              <button
                disabled={a.pending}
                onClick={() =>
                  a.run(async () => {
                    await mutation("/follows", {
                      kind: "star",
                      id: post.starId,
                      active: !post.followingStar,
                    });
                    r.reload();
                  })
                }
              >
                {post.followingStar ? "별 팔로우 취소" : "별 팔로우"}
              </button>
            )}
            {post.memberId === member.id && (
              <>
                <Link
                  className="button"
                  to={"/community/posts/" + post.id + "/edit"}
                >
                  수정
                </Link>
                <button onClick={() => setRemove(true)}>삭제</button>
              </>
            )}
          </div>
        </div>
        <p className="post-body">{post.body}</p>
        {signal && (
          <>
            <dl className="facts">
              <div>
                <dt>반복 주기</dt>
                <dd>{signal.period}일</dd>
              </div>
              <div>
                <dt>어두워진 정도</dt>
                <dd>{signal.depth}%</dd>
              </div>
            </dl>
            <AI signal={signal} />
          </>
        )}
        {post.attachments.map((id) => (
          <Attachment key={id} postId={post.id} historyId={id} />
        ))}
        {r.data.sourceCards.map((s) => (
          <Source key={s.kind + s.id} source={s} />
        ))}
        {post.starId && (
          <div className="analysis-entry">
            {post.canAnalyze ? (
              <Link
                className="button"
                to={"/analysis/" + post.starId + "?returnPostId=" + post.id}
              >
                이 별 분석하기 <ArrowUpRight size={15} />
              </Link>
            ) : (
              <>
                <button disabled>아직 못 찾은 별</button>
                <small>
                  게시판은 읽을 수 있지만, 내 밤하늘에서 발견한 뒤 분석할 수
                  있습니다.
                </small>
              </>
            )}
          </div>
        )}
        {post.kind === "general" && (
          <div className="reactions">
            {(["agree", "disagree"] as const).map((value) => (
              <div key={value}>
                <button
                  aria-pressed={post.myReaction === value}
                  disabled={a.pending}
                  onClick={() =>
                    a.run(async () => {
                      await mutation(
                        "/community/posts/" + post.id + "/reaction",
                        { value: post.myReaction === value ? null : value },
                      );
                      r.reload();
                    })
                  }
                >
                  {value === "agree" ? "동의" : "비동의"}
                </button>
                <button
                  aria-label={
                    (value === "agree" ? "동의" : "비동의") + "한 회원 목록"
                  }
                  onClick={() =>
                    a.run(async () => {
                      const data = await api<{
                        items: { id: string; nickname: string }[];
                      }>(
                        "/community/posts/" +
                          post.id +
                          "/reactors?value=" +
                          value,
                      );
                      setReactors({
                        title:
                          value === "agree" ? "동의한 회원" : "비동의한 회원",
                        items: data.items,
                      });
                    })
                  }
                >
                  {post[value]}
                </button>
              </div>
            ))}
            <small>의견에 대한 반응이며 성과·행성 판단과는 별개입니다.</small>
          </div>
        )}
      </article>
      {post.kind === "system_thread" && (
        <section className="panel">
          <DistributionView data={distribution} />
          <div className="section-heading">
            <h2>
              공개 분석 <small>{r.data.analyses.length}</small>
            </h2>
            <select
              aria-label="공개 분석 판단 필터"
              value={judgment}
              onChange={(e) => {
                setParams((previous) => {
                  previous.set("judgment", e.target.value);
                  return previous;
                });
                setAnalysisPage(1);
              }}
            >
              <option value="all">전체 판단</option>
              {Object.entries(JUDGMENTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            목록 필터는 위 전체 판단 분포를 바꾸지 않습니다.
          </p>
          {!filtered.length && (
            <Empty title="조건에 맞는 공개 분석이 없습니다" />
          )}
          {filtered
            .slice((analysisPage - 1) * 10, analysisPage * 10)
            .map((a) => (
              <article key={a.publication.id} className="analysis-card">
                <div>
                  <Link to={"/members/" + a.author.id}>
                    {a.author.nickname}
                  </Link>
                  <small>
                    제출 {date(a.history.submittedAt)} · 공개{" "}
                    {date(a.publication.publishedAt)}
                  </small>
                </div>
                <h3>{JUDGMENTS[a.history.judgment!]}</h3>
                <p>
                  반복 주기 {a.history.period}일 ·{" "}
                  {a.history.evidence.join(" · ") || "선택한 근거 없음"}
                </p>
                <Link to={"/community/analyses/" + a.publication.id}>
                  공개 분석 보기 →
                </Link>
                <PublicRecordPreview analysis={a} />
              </article>
            ))}
          <Pager
            data={{
              items: filtered,
              total: filtered.length,
              page: analysisPage,
              pageSize: 10,
            }}
            onPage={setAnalysisPage}
          />
        </section>
      )}
      <section className="panel">
        <h2>
          토론 <small>{comments.length}</small>
        </h2>
        <p className="muted">
          공개 분석과 별도로 질문·의견을 나누는 공간입니다.
        </p>
        {comments.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            postId={post.id}
            starId={post.starId}
            reload={r.reload}
          />
        ))}
        {!comments.length && (
          <p className="empty-line">아직 댓글이 없습니다.</p>
        )}
        <CommentEditor
          key={post.id + ":" + post.starId}
          postId={post.id}
          starId={post.starId}
          suggestedHistoryId={
            returnStarId === post.starId ? params.get("suggestHistoryId") : null
          }
          done={r.reload}
        />
      </section>
      <ActionError message={a.error} />
      {remove && (
        <Modal title="이 글을 삭제할까요?" onClose={() => setRemove(false)}>
          <p>개인 분석 기록과 이미 인정된 성과는 유지됩니다.</p>
          <ActionError message={a.error} />
          <div className="actions">
            <button onClick={() => setRemove(false)}>취소</button>
            <button
              className="danger"
              disabled={a.pending}
              onClick={() =>
                a.run(async () => {
                  await api("/community/posts/" + post.id, {
                    method: "DELETE",
                  });
                  navigate("/community");
                })
              }
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
      {reactors && (
        <Modal title={reactors.title} onClose={() => setReactors(null)}>
          {reactors.items.length ? (
            reactors.items.map((m) => (
              <p key={m.id}>
                <Link to={"/members/" + m.id} onClick={() => setReactors(null)}>
                  {m.nickname}
                </Link>
              </p>
            ))
          ) : (
            <p>아직 반응한 회원이 없습니다.</p>
          )}
        </Modal>
      )}
    </main>
  );
}
export function ComposePage() {
  const { postId } = useParams(),
    [params] = useSearchParams(),
    navigate = useNavigate(),
    { member } = useApp(),
    r = useResource<PostDetail>(postId ? "/community/posts/" + postId : null);
  const [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [tag, setTag] = useState<Tag>((params.get("tag") as Tag) || "DISCUSSION"),
    [starId, setStarId] = useState<string | null>(params.get("star")),
    [attachments, setAttachments] = useState<string[]>(
      params.get("history") ? [params.get("history")!] : [],
    ),
    [sources, setSources] = useState<SourceRef[]>([]),
    [starQuery, setStarQuery] = useState(""),
    [changeNotice, setChangeNotice] = useState(""),
    a = useAction();
  const stars = useResource<{ items: { id: string; name: string }[] }>(
    "/community/stars?" + query({ q: starQuery }),
  );
  useEffect(() => {
    if (r.data) {
      const p = r.data.post;
      setTitle(p.title);
      setBody(p.body);
      setTag(p.tag);
      setStarId(p.starId);
      setAttachments(p.attachments);
      setSources(p.sources);
    }
  }, [r.data]);
  if (postId && (r.loading || r.error))
    return (
      <main className="page">
        <RequestState state={r} />
      </main>
    );
  if (
    r.data &&
    (r.data.post.memberId !== member.id || r.data.post.kind !== "general")
  )
    return (
      <main className="page">
        <Empty title="이 글을 수정할 수 없습니다" />
      </main>
    );
  const changeStar = (id: string) => {
    setStarId(id || null);
    if (attachments.length || sources.length)
      setChangeNotice("관련 별이 바뀌어 기존 첨부와 출처를 해제했습니다.");
    setAttachments([]);
    setSources([]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const saved = await mutation<Post>(
        "/community/posts" + (postId ? "/" + postId : ""),
        { title, body, tag, starId, attachments, sources },
        postId ? "PATCH" : "POST",
      );
      navigate("/community/posts/" + saved.id);
    });
  };
  return (
    <main className="page compose-page">
      <Back to={postId ? "/community/posts/" + postId : "/community"} />
      <PageTitle
        eyebrow="YOUR PERSPECTIVE"
        title={postId ? "글 수정" : "새로운 이야기"}
        description="관측한 것, 궁금한 것, 함께 나누고 싶은 생각을 기록하세요."
      />
      <form onSubmit={submit}>
        <div className="panel">
          <Field
            label="관련 별 선택"
            hint="별을 선택하지 않으면 자유 게시판에 게시됩니다."
          >
            <input
              aria-label="관련 별 검색"
              placeholder="TIC ID로 검색"
              value={starQuery}
              onChange={(e) => setStarQuery(e.target.value)}
            />
            <select
              aria-label="관련 별"
              value={starId || ""}
              onChange={(e) => changeStar(e.target.value)}
            >
              <option value="">별 선택 안 함 · 자유 게시판</option>
              {starId && !stars.data?.items.some((s) => s.id === starId) && (
                <option value={starId}>TIC {starId}</option>
              )}
              {stars.data?.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <RequestState state={stars} />
          {changeNotice && (
            <p className="notice" role="status">
              {changeNotice}
            </p>
          )}
          <Field label="대표 목적">
            <select value={tag} onChange={(e) => setTag(e.target.value as Tag)}>
              {Object.entries(TAGS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="제목">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={120}
              placeholder="이야기의 제목을 입력해 주세요."
            />
          </Field>
          <Field label="본문">
            <textarea
              className="post-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              maxLength={40000}
              placeholder="관측 내용과 생각을 자유롭게 남겨 주세요."
            />
          </Field>
          <LinkPicker
            starId={starId}
            attachments={attachments}
            sources={sources}
            onAttachments={setAttachments}
            onSources={setSources}
          />
        </div>
        <ActionError message={a.error} />
        <div className="form-footer">
          <Link
            className="button"
            to={postId ? "/community/posts/" + postId : "/community"}
          >
            취소
          </Link>
          <button className="primary" disabled={a.pending}>
            {a.pending ? "저장 중…" : postId ? "수정 저장" : "게시하기"}
          </button>
        </div>
      </form>
    </main>
  );
}
function PublicRecordPreview({ analysis }: { analysis: PublicAnalysis }) {
  const [open, setOpen] = useState(false);
  // Revalidate publication/parent visibility when expanded, including stored snapshots.
  const r = useResource<PublicAnalysis>(
    open ? "/publications/" + analysis.publication.id : null,
  );
  return (
    <details
      className="public-record-details"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>구간·메모·곡선·버전 확인</summary>
      {open && (
        <>
          <RequestState state={r} />
          {r.data && (
            <RecordView
              history={r.data.history}
              actions={false}
              replayPath={
                "/publications/" + analysis.publication.id + "/replay"
              }
            />
          )}
        </>
      )}
    </details>
  );
}
export function PublicAnalysisPage() {
  const { publicationId } = useParams(),
    r = useResource<PublicAnalysis & { distribution: Distribution }>(
      "/publications/" + publicationId,
    ),
    { member } = useApp(),
    a = useAction(),
    navigate = useNavigate(),
    [confirm, setConfirm] = useState(false);
  return (
    <main className="page record-page">
      <Back
        to={
          r.data
            ? "/community/posts/" + r.data.publication.threadId
            : "/community"
        }
      />
      <PageTitle
        eyebrow="PUBLISHED ANALYSIS"
        title="공개 분석"
        description={
          r.data ? r.data.author.nickname + "님의 독립된 분석 기록" : undefined
        }
      />
      <RequestState state={r} />
      {r.data && (
        <>
          <div className="panel">
            <RecordView
              history={r.data.history}
              actions={false}
              replayPath={"/publications/" + publicationId + "/replay"}
            />
          </div>
          <div className="panel">
            <DistributionView data={r.data.distribution} />
          </div>
          {r.data.author.id === member.id && (
            <button onClick={() => setConfirm(true)}>공개 취소</button>
          )}
        </>
      )}
      {confirm && r.data && (
        <Modal
          title="분석 공개를 취소할까요?"
          onClose={() => setConfirm(false)}
        >
          <p>
            공개 목록과 판단 통계에서 제외됩니다. 개인 기록·탐색 완료·기존
            성과는 유지됩니다.
          </p>
          <ActionError message={a.error} />
          <button
            disabled={a.pending}
            onClick={() =>
              a.run(async () => {
                await mutation("/publications", {
                  historyId: r.data!.history.id,
                  active: false,
                });
                navigate("/history/" + r.data!.history.id);
              })
            }
          >
            공개 취소하기
          </button>
        </Modal>
      )}
    </main>
  );
}
