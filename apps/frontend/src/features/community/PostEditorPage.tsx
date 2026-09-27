import { PostStarPicker } from "./PostStarPicker";
import { MaterialPicker } from "./MaterialPicker";
import { emptyMaterials, materialError } from "./materialContracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, ApiError } from "../../api";
import { pagePath, safeReturnTo } from "../../app/paths";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { assertIdentity, endpoint, readFeed } from "./contracts";
import {
  changedPostFields,
  codePoints,
  patchIsVisible,
  postTags,
  postValues,
  readCreatedPost,
  readEditablePost,
  toDraft,
  validatePost,
  type EditablePost,
  type PostDraft,
  type PostErrors,
  type PostValues,
} from "./postContracts";
import { useReadModel } from "./useReadModel";
import { decodeWritten, usePostWrite } from "./usePostWrite";
import "./post-editor.css";

function RecentOwnPosts({
  values,
  onChecked,
}: {
  values: PostValues;
  onChecked: () => void;
}) {
  const { member } = useSession();
  const [cursor, setCursor] = useState<string | null>(null);
  const path = endpoint("/v1/community/feed", {
    board: values.ticId ? "STAR" : "FREE",
    ticId: values.ticId,
    size: "20",
    cursor,
  });
  const load = useCallback(
    async (signal: AbortSignal) =>
      readFeed(await api(path, { signal }), cursor),
    [path, cursor],
  );
  const state = useReadModel(path, load);
  useEffect(() => {
    if (state.data) onChecked();
  }, [state.data, onChecked]);
  if (!state.data)
    return state.error ? (
      <ErrorState error={state.error} retry={state.reload} />
    ) : (
      <LoadingState />
    );
  const mine = state.data.items.filter(
    (item) =>
      item.type === "POST" &&
      "memberId" in item.author &&
      item.author.memberId === member?.memberId,
  );
  return (
    <section aria-label="게시 여부 확인 목록">
      <h3>이 게시판에 올라온 내 글</h3>
      <p>
        제목이 같아도 같은 요청으로 작성된 글이라고 확정할 수 없습니다. 글
        내용을 열어 확인해 주세요. 목록에 없어도 게시되지 않았다고 단정할 수
        없습니다.
      </p>
      <ul>
        {mine.map((item) => (
          <li key={item.id}>
            <Link
              target="_blank"
              rel="noopener"
              to={pagePath("post", { postId: item.id })}
            >
              {item.title} (새 탭)
            </Link>
          </li>
        ))}
      </ul>
      {!mine.length && <p>이 페이지에는 내 글이 없습니다.</p>}
      <div className="post-actions">
        <button type="button" onClick={state.reload}>
          목록 새로고침
        </button>
        {cursor && (
          <button type="button" onClick={() => setCursor(null)}>
            처음 목록
          </button>
        )}
        {state.data.hasNext && (
          <button
            type="button"
            onClick={() => setCursor(state.data!.nextCursor)}
          >
            다음 목록
          </button>
        )}
      </div>
    </section>
  );
}

export function PostEditorPage() {
  const { postId } = useParams<"postId">();
  const location = useLocation();
  // Changing routes never carries another post's private draft into the editor.
  return (
    <PostEditor key={`${postId ?? "new"}:${location.search}`} postId={postId} />
  );
}

function PostEditor({ postId }: { postId?: string }) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { member } = useSession();
  const returnTo = safeReturnTo(search.get("returnTo"), "/community");
  const initialTic = search.get("ticId") ?? "";
  const [draft, setDraft] = useState<PostDraft>({
    title: "",
    body: "",
    purposeTag: Object.hasOwn(postTags, search.get("purposeTag") ?? "")
      ? search.get("purposeTag")!
      : "GENERAL",
    ticId: initialTic,
    board: initialTic || search.get("board") === "STAR" ? "STAR" : "FREE",
  });
  const [original, setOriginal] = useState<EditablePost | null>(null);
  const initialized = useRef(false);
  const [checking, setChecking] = useState(!!postId);
  const [accessError, setAccessError] = useState<Error | null>(null);
  const [reload, setReload] = useState(0);
  const [errors, setErrors] = useState<PostErrors>({});
  const [submitted, setSubmitted] = useState<Partial<PostValues>>({});
  const [recovered, setRecovered] = useState<EditablePost | null>(null);
  const [showList, setShowList] = useState(false);
  const [listChecked, setListChecked] = useState(false);
  const markChecked = useCallback(() => setListChecked(true), []);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [notice, setNotice] = useState("");
  const write = usePostWrite(),
    recovery = usePostWrite();
  useEffect(() => {
    if (
      postId &&
      write.error instanceof ApiError &&
      [403, 404].includes(write.error.status)
    )
      setReload((value) => value + 1);
  }, [postId, write.error]);
  const path = `/v1/posts/${encodeURIComponent(postId ?? "")}`;
  const decode = useCallback(
    (value: unknown) => {
      const post = readEditablePost(value);
      assertIdentity(post.postId, postId ?? "");
      if (post.author.memberId !== member?.memberId)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "본인이 작성한 글만 수정할 수 있습니다.",
        );
      return post;
    },
    [postId, member?.memberId],
  );
  useEffect(() => {
    if (!postId) return;
    let request: AbortController | undefined;
    const verify = async () => {
      if (document.hidden) return;
      request?.abort();
      const current = new AbortController();
      request = current;
      setChecking(true);
      try {
        const post = decode(await api(path, { signal: current.signal }));
        if (current.signal.aborted) return;
        setAccessError(null);
        if (!initialized.current) {
          initialized.current = true;
          setOriginal(post);
          setDraft(toDraft(post));
        }
        // Focus rechecks permission, but must never overwrite unsaved input/baseline.
      } catch (error) {
        if (!current.signal.aborted)
          setAccessError(
            error instanceof Error
              ? error
              : new Error("글을 확인하지 못했습니다."),
          );
      } finally {
        if (!current.signal.aborted) setChecking(false);
      }
    };
    void verify();
    window.addEventListener("focus", verify);
    document.addEventListener("visibilitychange", verify);
    return () => {
      request?.abort();
      window.removeEventListener("focus", verify);
      document.removeEventListener("visibilitychange", verify);
    };
  }, [postId, path, decode, reload]);
  const dirty = original
    ? Object.keys(changedPostFields(original, draft)).length > 0
    : !!(draft.title || draft.body);
  useEffect(() => {
    if (!dirty && !write.pending && !write.uncertain) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, write.pending, write.uncertain]);
  const unavailable =
    accessError instanceof ApiError && [403, 404].includes(accessError.status);
  const change = <K extends keyof PostDraft>(key: K, value: PostDraft[K]) => {
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(["ticId", "board"].includes(key) ? emptyMaterials() : {}),
    }));
    setErrors({});
    if (!write.uncertain) write.clearError();
    setNotice("");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (write.pending || write.uncertain || checking || accessError) return;
    const materialIssue = materialError(draft, postValues(draft).ticId);
    if (materialIssue) {
      setNotice(materialIssue);
      return;
    }
    const invalid = validatePost(draft);
    setErrors(invalid);
    setNotice("");
    if (Object.keys(invalid).length) {
      document.getElementById(`post-${Object.keys(invalid)[0]}`)?.focus();
      return;
    }
    const json = original
      ? changedPostFields(original, draft)
      : postValues(draft);
    if (!Object.keys(json).length) {
      setNotice("변경한 내용이 없습니다.");
      return;
    }
    setSubmitted(json);
    setRecovered(null);
    setListChecked(false);
    setShowList(false);
    setRiskAccepted(false);
    const result = await write.run(async (signal) => {
      const value = await api(original ? path : "/v1/posts", {
        method: original ? "PATCH" : "POST",
        json,
        signal,
      });
      return decodeWritten(value, original ? decode : readCreatedPost);
    });
    if (result)
      navigate(
        postId &&
          new URL(returnTo, window.location.origin).pathname ===
            `/posts/${encodeURIComponent(postId)}`
          ? returnTo
          : pagePath("post", { postId: result.value.postId }, { returnTo }),
        { replace: true },
      );
  };
  const reconcile = async () => {
    const result = await recovery.run(async (signal) =>
      decode(await api(path, { signal })),
    );
    if (result) setRecovered(result.value);
  };
  const deniedRecovery =
    recovery.error instanceof ApiError &&
    [403, 404].includes(recovery.error.status);
  const fieldErrors: PostErrors = { ...errors };
  if (write.error instanceof ApiError && !write.uncertain)
    for (const entry of write.error.fieldErrors) {
      if (["title", "body", "purposeTag", "ticId"].includes(entry.field))
        fieldErrors[entry.field as keyof PostErrors] = entry.reason;
    }
  const leave = () => {
    if (
      (!dirty && !write.uncertain) ||
      window.confirm(
        "입력한 내용을 저장하지 않고 나갈까요? 응답을 확인하지 못한 요청은 이미 처리되었을 수 있습니다.",
      )
    )
      navigate(returnTo);
  };
  if (unavailable || deniedRecovery)
    return (
      <div className="community-page">
        <ErrorState error={(deniedRecovery ? recovery.error : accessError)!} />
        <Link to={returnTo}>이전 화면으로</Link>
      </div>
    );
  return (
    <div className="community-page post-editor">
      <header className="community-heading">
        <p className="eyebrow">COMMUNITY · 나누는 관측</p>
        <h1>{postId ? "글 수정" : "새 이야기 쓰기"}</h1>
        <p>
          관측한 내용이나 궁금한 점을 나눠 보세요. 일반 글 작성은 분석 제출이나
          성과 인정에 영향을 주지 않습니다.
        </p>
      </header>
      {accessError && (
        <ErrorState
          error={accessError}
          retry={() => setReload((value) => value + 1)}
        />
      )}
      {postId && !original ? (
        checking && <LoadingState />
      ) : (
        <form onSubmit={submit} noValidate>
          <fieldset
            disabled={
              write.pending || write.uncertain || checking || !!accessError
            }
          >
            <div className="post-field-row">
              <label>
                게시판
                <select
                  aria-label="게시판"
                  value={draft.board}
                  onChange={(event) =>
                    change("board", event.target.value as "FREE" | "STAR")
                  }
                >
                  <option value="FREE">자유 게시판</option>
                  <option value="STAR">별 게시판</option>
                </select>
              </label>
              <label>
                글 종류
                <select
                  id="post-purposeTag"
                  value={draft.purposeTag}
                  onChange={(event) => change("purposeTag", event.target.value)}
                >
                  {Object.entries(postTags).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {fieldErrors.purposeTag && (
              <p role="alert">{fieldErrors.purposeTag}</p>
            )}
            {draft.board === "STAR" && (
              <div className="post-star-field">
              <PostStarPicker value={draft.ticId} onSelect={(ticId) => change("ticId", ticId)} />
              <label>
                별의 TIC 번호
                <input
                  id="post-ticId"
                  inputMode="numeric"
                  value={draft.ticId}
                  aria-invalid={!!fieldErrors.ticId}
                  aria-describedby="post-tic-help"
                  onChange={(event) => change("ticId", event.target.value)}
                />
                <small id="post-tic-help">
                  공개된 별 게시판에 연결됩니다. {fieldErrors.ticId}
                </small>
              </label>
              </div>
            )}
            {original?.hasAttachments && (
              <p>
                게시판이나 별을 변경하면 선택한 분석 기록과 출처가 모두
                해제됩니다.
              </p>
            )}
            <label>
              제목
              <input
                aria-label="제목"
                id="post-title"
                value={draft.title}
                aria-invalid={!!fieldErrors.title}
                aria-describedby="post-title-help"
                onChange={(event) => change("title", event.target.value)}
              />
              <small id="post-title-help">
                {codePoints(postValues(draft).title)} / 100자{" "}
                {fieldErrors.title}
              </small>
            </label>
            <label>
              본문
              <textarea
                aria-label="본문"
                id="post-body"
                rows={14}
                value={draft.body}
                aria-invalid={!!fieldErrors.body}
                aria-describedby="post-body-help"
                onChange={(event) => change("body", event.target.value)}
              />
              <small id="post-body-help">
                {codePoints(draft.body).toLocaleString()} / 10,000자 · 입력한
                글은 일반 텍스트로 표시됩니다. {fieldErrors.body}
              </small>
            </label>
            <MaterialPicker
              ticId={draft.board === "STAR" ? draft.ticId : null}
              value={draft}
              onChange={(materials) =>
                setDraft((previous) => ({ ...previous, ...materials }))
              }
            />
          </fieldset>
          {write.error && <ErrorState error={write.error} />}
          {notice && <p role="status">{notice}</p>}
          <div className="post-actions">
            <button type="button" disabled={write.pending} onClick={leave}>
              취소
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                write.pending || write.uncertain || checking || !!accessError
              }
            >
              {write.pending
                ? "저장 결과 확인 중…"
                : postId
                  ? "수정 저장"
                  : "게시하기"}
            </button>
          </div>
        </form>
      )}
      {write.uncertain && (
        <section className="post-recovery" aria-label="저장 여부 확인">
          <h2>저장 여부를 먼저 확인해 주세요</h2>
          <p>자동으로 다시 보내지 않습니다. 입력은 이 화면에 유지됩니다.</p>
          {!postId ? (
            <>
              <button onClick={() => setShowList(true)}>
                목록에서 게시 여부 확인
              </button>
              {showList && (
                <RecentOwnPosts
                  values={submitted as PostValues}
                  onChecked={markChecked}
                />
              )}
              {listChecked && (
                <>
                  <label className="post-ack">
                    <input
                      type="checkbox"
                      checked={riskAccepted}
                      onChange={(event) =>
                        setRiskAccepted(event.target.checked)
                      }
                    />
                    목록을 확인했고, 중복 게시 가능성을 이해했습니다
                  </label>
                  <button
                    disabled={!riskAccepted}
                    onClick={() => {
                      write.clearError();
                      setShowList(false);
                    }}
                  >
                    입력을 이어서 편집
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                disabled={recovery.pending}
                onClick={() => void reconcile()}
              >
                저장 여부 다시 확인
              </button>
              {recovery.error && <ErrorState error={recovery.error} />}
              {recovered && (
                <>
                  <p role="status">
                    {patchIsVisible(recovered, submitted)
                      ? "현재 조회한 글에 요청한 변경이 반영되어 있습니다."
                      : "현재 서버 내용이 내 요청과 다릅니다. 다른 수정이 있었거나 처리가 끝나지 않았을 수 있습니다."}
                  </p>
                  <h3>현재 서버의 글</h3>
                  <p>
                    {recovered.title} ·{" "}
                    {postTags[recovered.purposeTag as keyof typeof postTags] ??
                      recovered.purposeTag}{" "}
                    ·{" "}
                    {recovered.ticId ? `TIC ${recovered.ticId}` : "자유 게시판"}
                  </p>
                  <p className="community-body">{recovered.body}</p>
                  <div className="post-actions">
                    <button
                      onClick={() => {
                        setOriginal(recovered);
                        setDraft(toDraft(recovered));
                        write.clearError();
                      }}
                    >
                      서버 내용 사용
                    </button>
                    <button
                      onClick={() => {
                        setOriginal(recovered);
                        write.clearError();
                      }}
                    >
                      내 입력으로 다시 편집
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
