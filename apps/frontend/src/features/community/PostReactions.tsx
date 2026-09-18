import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError } from "../../api";
import { pagePath } from "../../app/paths";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { assertIdentity, endpoint, readPost } from "./contracts";
import { readReactors, type Reaction } from "./reactionContracts";
import { ReactionStore } from "./reactionStore";
import { useReadModel } from "./useReadModel";
import "./reactions.css";

export function PostReactions({
  postId,
  active,
  onUnavailable,
}: {
  postId: string;
  active: boolean;
  onUnavailable: (error: Error) => void;
}) {
  const [store, setStore] = useState<ReactionStore | null>(null);
  useEffect(() => {
    const next = new ReactionStore(postId, api);
    setStore(next);
    void next.refresh();
    const focus = () => {
      if (!document.hidden) void next.refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      next.dispose();
    };
  }, [postId]);
  return store ? (
    <ReactionControls
      store={store}
      postId={postId}
      active={active}
      onUnavailable={onUnavailable}
    />
  ) : null;
}
function ReactionControls({
  store,
  postId,
  active,
  onUnavailable,
}: {
  store: ReactionStore;
  postId: string;
  active: boolean;
  onUnavailable: (error: Error) => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [list, setList] = useState<Exclude<Reaction, "NONE"> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const location = useLocation();
  const path = `/v1/posts/${encodeURIComponent(postId)}`;
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!list) return null;
      assertIdentity(readPost(await api(path, { signal })).postId, postId);
      return readReactors(
        await api(
          endpoint(`${path}/reactions`, { reaction: list, size: "20", cursor }),
          { signal },
        ),
        cursor,
      );
    },
    [path, postId, list, cursor],
  );
  const members = useReadModel(`${path}:${list}:${cursor}`, load);
  useEffect(() => {
    for (const error of [state.error, members.error])
      if (error instanceof ApiError && [403, 404].includes(error.status))
        onUnavailable(error);
  }, [state.error, members.error, onUnavailable]);
  useEffect(() => {
    if (list && active) dialog.current?.showModal();
    else dialog.current?.close();
  }, [list, active]);
  if (!active) return null;
  const labels = { AGREE: "동의", DISAGREE: "비동의" } as const;
  return (
    <section className="post-reactions" aria-label="이 글에 대한 의견">
      <p>이 글에 대한 의견 · 발견 성과나 과학적 판정에 반영되지 않습니다.</p>
      {state.loading ? (
        <LoadingState />
      ) : (
        <>
          <div className="reaction-controls">
            {(["AGREE", "DISAGREE"] as const).map((value) => (
              <div key={value}>
                <button
                  aria-pressed={state.wanted === value}
                  disabled={!state.summary || state.uncertain}
                  onClick={() => {
                    setList(null);
                    void store.choose(state.wanted === value ? "NONE" : value);
                  }}
                >
                  {labels[value]}
                  {state.wanted === value ? " 취소" : ""}
                </button>
                {state.summary && (
                  <button
                    className="reaction-count"
                    aria-label={`${labels[value]}한 회원 ${state.summary[value === "AGREE" ? "agree" : "disagree"]}명 보기`}
                    onClick={() => {
                      setCursor(null);
                      setList(value);
                    }}
                  >
                    {state.summary[
                      value === "AGREE" ? "agree" : "disagree"
                    ].toLocaleString()}
                    명
                  </button>
                )}
              </div>
            ))}
          </div>
          {state.pending && (
            <p role="status">마지막 선택을 저장하고 있습니다…</p>
          )}
          {state.error && (
            <ErrorState
              error={state.error}
              retry={() => void store.refresh()}
            />
          )}
          {state.uncertain && (
            <p>
              반응을 자동으로 다시 보내지 않습니다. 다시 불러와 현재 서버 상태를
              확인한 뒤 직접 선택해 주세요.
            </p>
          )}
        </>
      )}
      <dialog
        ref={dialog}
        className="post-dialog reaction-dialog"
        aria-labelledby="reactors-title"
        onCancel={() => setList(null)}
      >
        <div className="post-actions">
          <h2 id="reactors-title">{list ? labels[list] : ""}한 회원</h2>
          <button onClick={() => setList(null)}>닫기</button>
        </div>
        <p>
          현재 닉네임을 표시합니다. 수와 목록은 각 조회 시점에 따라 다를 수
          있습니다.
        </p>
        {!members.data ? (
          members.error ? (
            <ErrorState error={members.error} retry={members.reload} />
          ) : (
            <LoadingState />
          )
        ) : (
          <>
            {!members.data.items.length && <p>표시할 회원이 없습니다.</p>}
            <ul>
              {members.data.items.map((item) => (
                <li key={item.memberId}>
                  <Link
                    to={pagePath(
                      "member",
                      { memberId: item.memberId },
                      { returnTo: location.pathname + location.search },
                    )}
                  >
                    {item.nickname}
                  </Link>
                </li>
              ))}
            </ul>
            <nav aria-label="반응자 페이지">
              {cursor && (
                <button onClick={() => setCursor(null)}>처음 페이지</button>
              )}
              {members.data.hasNext ? (
                <button onClick={() => setCursor(members.data!.nextCursor)}>
                  다음 페이지
                </button>
              ) : (
                <span>마지막 페이지</span>
              )}
            </nav>
          </>
        )}
      </dialog>
    </section>
  );
}
