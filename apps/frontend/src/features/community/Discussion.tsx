import { MaterialPicker } from "./MaterialPicker";
import { MaterialCards } from "./MaterialCards";
import {
  sameMaterials,
  materialError,
  changedMaterials,
} from "./materialContracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { pagePath } from "../../app/paths";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState, LoadingState } from "../../components/RequestState";
import {
  assertIdentity,
  endpoint,
  readComment,
  readComments,
  readPost,
  readThread,
  type CommentPage,
} from "./contracts";
import {
  commentError,
  readCreatedComment,
  type CommentParent,
  type CommentMaterials,
} from "./commentContracts";
import { codePoints } from "./postContracts";
import { decodeWritten, usePostWrite } from "./usePostWrite";
import { useReadModel } from "./useReadModel";
import "./post-editor.css";
import { Pager } from "./CommunityPagination";

type Comment = CommentPage["items"][number];
type Edit = {
  kind: "create" | "edit" | "delete";
  item?: Comment;
  body: string;
  materials: CommentMaterials;
};
const empty = (): Edit => ({ kind: "create", body: "", materials: {} });

export function Discussion({
  parent,
  ticId,
  active,
  onUnavailable,
}: {
  parent: CommentParent;
  ticId: string | null;
  active: boolean;
  onUnavailable: (error: Error) => void;
}) {
  const { member } = useSession();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const cursor = search.get("discussionCursor");
  const [edit, setEdit] = useState<Edit>(empty);
  const previousTic = useRef(ticId);
  useEffect(() => {
    if (active && previousTic.current !== ticId) {
      previousTic.current = ticId;
      setEdit((e) => ({
        ...e,
        materials: { historyIds: [], sourceLinks: [] },
      }));
    }
  }, [ticId, active]);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState<CommentPage | null>(null);
  const [found, setFound] = useState<Comment | null>(null);
  const [ack, setAck] = useState(false);
  const write = usePostWrite(),
    check = usePostWrite();
  const textArea = useRef<HTMLTextAreaElement>(null);
  const { parentType, parentId } = parent;
  const parentPath =
    parentType === "POST"
      ? `/v1/posts/${encodeURIComponent(parentId)}`
      : `/v1/signal-threads/${encodeURIComponent(parentId)}`;
  const listPath = useCallback(
    (value: string | null) =>
      endpoint("/v1/comments", {
        parentType,
        parentId,
        size: "20",
        cursor: value,
      }),
    [parentType, parentId],
  );
  const readParent = useCallback(
    async (signal: AbortSignal) => {
      const raw = await api(parentPath, { signal });
      if (parentType === "POST") assertIdentity(readPost(raw).postId, parentId);
      else assertIdentity(readThread(raw).threadId, parentId);
    },
    [parentPath, parentType, parentId],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      await readParent(signal);
      return readComments(await api(listPath(cursor), { signal }), cursor);
    },
    [readParent, listPath, cursor],
  );
  const state = useReadModel(listPath(cursor), load);
  useEffect(() => {
    for (const error of [state.error, check.error])
      if (error instanceof ApiError && [403, 404].includes(error.status))
        onUnavailable(error);
  }, [state.error, check.error, onUnavailable]);
  useEffect(() => {
    // A comment write 404 may concern only that comment. Recheck the parent first.
    if (
      write.error instanceof ApiError &&
      [403, 404].includes(write.error.status)
    )
      state.reload();
  }, [write.error, state.reload]);
  useEffect(() => {
    if (!edit.body && !write.uncertain) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edit.body, write.uncertain]);
  function reset(message = "") {
    setEdit(empty());
    write.clearError();
    check.clearError();
    setRecovery(null);
    setFound(null);
    setAck(false);
    setLocalError("");
    setNotice(message);
  }
  function refreshed() {
    const next = new URLSearchParams(search);
    next.delete("discussionCursor");
    setSearch(next, { replace: true });
    state.reload();
  }
  async function submit() {
    if (write.pending || write.uncertain || !active || !state.data) return;
    if (edit.kind !== "delete") {
      const error =
        commentError(edit.body) || materialError(edit.materials, ticId);
      setLocalError(error);
      if (error) {
        textArea.current?.focus();
        return;
      }
      if (
        edit.kind === "edit" &&
        edit.body === edit.item?.body &&
        sameMaterials(edit.materials, edit.item ?? {})
      ) {
        reset("변경한 내용이 없습니다.");
        return;
      }
    }
    setNotice("");
    setRecovery(null);
    setFound(null);
    setAck(false);
    const result = await write.run(async (signal) => {
      if (edit.kind === "create")
        return decodeWritten(
          await api("/v1/comments", {
            method: "POST",
            json: { ...parent, body: edit.body, ...edit.materials },
            signal,
          }),
          readCreatedComment,
        );
      const path = `/v1/comments/${encodeURIComponent(edit.item!.commentId)}`;
      if (edit.kind === "delete")
        return api(path, { method: "DELETE", signal });
      return decodeWritten(
        await api(path, {
          method: "PATCH",
          json: {
            body: edit.body,
            ...changedMaterials(edit.item ?? {}, edit.materials),
          },
          signal,
        }),
        (value) => {
          const item = readComment(value);
          assertIdentity(item.commentId, edit.item!.commentId);
          return item;
        },
      );
    });
    if (result) {
      reset(
        edit.kind === "delete"
          ? "댓글을 삭제했습니다."
          : "댓글을 저장했습니다.",
      );
      refreshed();
    }
  }
  async function verify(next: string | null = null) {
    const result = await check.run(async (signal) => {
      await readParent(signal);
      return readComments(await api(listPath(next), { signal }), next);
    });
    if (result) {
      setRecovery(result.value);
      const item = result.value.items.find(
        (item) => item.commentId === edit.item?.commentId,
      );
      if (!next) setFound(item ?? null);
      else if (item) setFound(item);
    }
  }
  const editable = !!member && !!state.data && active;
  if (!active) return null;
  return (
    <section className="community-discussion" aria-label="토론">
      <h2>토론</h2>
      {notice && <p role="status">{notice}</p>}
      {!state.data ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          <form
            className="comment-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <h3>
              {edit.kind === "create"
                ? "댓글 남기기"
                : edit.kind === "edit"
                  ? "댓글 수정"
                  : "이 댓글을 삭제할까요?"}
            </h3>
            {edit.kind === "delete" ? (
              <p>삭제한 댓글은 다시 볼 수 없으며 복원할 수 없습니다.</p>
            ) : (
              <>
                <label htmlFor="comment-body">댓글 본문</label>
                <textarea
                  ref={textArea}
                  id="comment-body"
                  rows={4}
                  value={edit.body}
                  disabled={!editable || write.pending || write.uncertain}
                  aria-invalid={
                    !!localError ||
                    (write.error instanceof ApiError &&
                      write.error.fieldErrors.some(
                        (item) => item.field === "body",
                      ))
                  }
                  aria-describedby="comment-limit"
                  onChange={(event) => {
                    setEdit({ ...edit, body: event.target.value });
                    setLocalError("");
                    write.clearError();
                  }}
                />
                <MaterialPicker
                  ticId={ticId}
                  value={edit.materials}
                  disabled={!editable || write.pending || write.uncertain}
                  onChange={(materials) => setEdit({ ...edit, materials })}
                />
                <p id="comment-limit">
                  {codePoints(edit.body).toLocaleString()} / 2,000자 · 줄바꿈
                  가능, 일반 텍스트
                </p>
              </>
            )}
            {localError && <p role="alert">{localError}</p>}
            {write.error && <ErrorState error={write.error} />}
            {write.uncertain ? (
              <div className="post-recovery" aria-label="댓글 저장 여부 확인">
                <p>
                  요청 결과가 불명확합니다. 자동으로 다시 보내지 않습니다. 댓글
                  목록에서 저장 여부를 확인해 주세요.
                </p>
                <button
                  type="button"
                  disabled={check.pending}
                  onClick={() => void verify()}
                >
                  최신 댓글 확인
                </button>
                {check.error && <ErrorState error={check.error} />}
                {recovery && (
                  <>
                    <ul>
                      {recovery.items.map((item) => (
                        <li key={item.commentId}>
                          <strong>{item.author.nickname}</strong> ·{" "}
                          {new Date(item.createdAt).toLocaleString("ko-KR")}
                          <p className="community-body">{item.body}</p>
                        </li>
                      ))}
                    </ul>
                    {recovery.hasNext ? (
                      <button
                        type="button"
                        disabled={check.pending}
                        onClick={() => void verify(recovery.nextCursor)}
                      >
                        이전 댓글 더 확인
                      </button>
                    ) : (
                      <p>
                        목록의 끝입니다. 조회되지 않아도 삭제 성공이나 저장
                        실패로 단정할 수 없습니다.
                      </p>
                    )}
                    {found && (
                      <p role="status">
                        {found.body === edit.body &&
                        sameMaterials(found, edit.materials) &&
                        edit.kind === "edit"
                          ? "현재 댓글은 보낸 내용과 같습니다."
                          : "현재 댓글이 조회됩니다."}{" "}
                        다른 창의 변경이나 아직 처리 중인 요청이 있을 수
                        있습니다.
                      </p>
                    )}
                    {edit.kind === "create" ? (
                      <>
                        <p>
                          같은 내용의 댓글은 이전 요청의 성공을 증명하지
                          않습니다. 다시 보내면 중복될 수 있습니다.
                        </p>
                        <label>
                          <input
                            type="checkbox"
                            checked={ack}
                            onChange={(event) => setAck(event.target.checked)}
                          />
                          목록을 확인했으며 다시 보내면 중복될 수 있음을
                          이해했습니다.
                        </label>
                        <button
                          type="button"
                          disabled={!ack}
                          onClick={() => {
                            write.clearError();
                            setRecovery(null);
                          }}
                        >
                          입력 유지하고 다시 편집
                        </button>
                      </>
                    ) : (
                      found && (
                        <>
                          <p className="community-body">
                            현재 서버 내용: {found.body}
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setEdit({ ...edit, item: found });
                              write.clearError();
                              setRecovery(null);
                            }}
                          >
                            현재 상태 확인 후{" "}
                            {edit.kind === "delete"
                              ? "삭제 준비"
                              : "내 입력으로 편집 계속"}
                          </button>
                        </>
                      )
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        reset("조회한 내용을 확인했습니다.");
                        refreshed();
                      }}
                    >
                      확인하고 편집 종료
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="post-actions">
                <button type="submit" disabled={!editable || write.pending}>
                  {write.pending
                    ? "처리 중…"
                    : edit.kind === "create"
                      ? "댓글 등록"
                      : edit.kind === "edit"
                        ? "댓글 저장"
                        : "댓글 삭제 확정"}
                </button>
                {edit.kind !== "create" && (
                  <button
                    type="button"
                    disabled={write.pending}
                    onClick={() => {
                      if (
                        edit.kind === "delete" ||
                        (edit.body === edit.item?.body &&
                          sameMaterials(edit.materials, edit.item ?? {})) ||
                        window.confirm("수정한 내용을 버릴까요?")
                      )
                        reset();
                    }}
                  >
                    취소
                  </button>
                )}
              </div>
            )}
          </form>
          {!state.data.items.length && (
            <p className="community-empty">아직 토론이 없습니다.</p>
          )}
          <ul className="community-comments">
            {state.data.items.map((item) => (
              <li key={item.commentId}>
                <div className="community-row-meta">
                  <Link
                    to={pagePath(
                      "member",
                      { memberId: item.author.memberId },
                      { returnTo: location.pathname + location.search },
                    )}
                  >
                    {item.author.nickname}
                  </Link>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString("ko-KR")}
                  </time>
                  {item.updatedAt !== item.createdAt && <span>수정됨</span>}
                </div>
                <p className="community-body">{item.body}</p>
                <MaterialCards
                  value={item}
                  ticId={ticId}
                  parentType="COMMENT"
                  parentId={item.commentId}
                  author={item.author}
                />
                {member?.memberId === item.author.memberId && (
                  <div className="post-actions">
                    {(["edit", "delete"] as const).map((kind) => (
                      <button
                        key={kind}
                        disabled={
                          write.pending ||
                          write.uncertain ||
                          edit.kind !== "create" ||
                          !!edit.body
                        }
                        onClick={() => {
                          reset();
                          setEdit({
                            kind,
                            item,
                            body: item.body,
                            materials: {
                              historyIds: item.historyIds,
                              sourceLinks: item.sourceLinks,
                              unavailableSources: item.unavailableSources,
                            },
                          });
                          textArea.current?.focus();
                        }}
                      >
                        {kind === "edit" ? "댓글 수정" : "댓글 삭제"}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Pager
            page={state.data}
            name="discussionCursor"
            label="토론 페이지"
          />
        </>
      )}
    </section>
  );
}
