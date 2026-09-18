import { useEffect, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api, ApiError } from "../../api";
import { pagePath, safeReturnTo } from "../../app/paths";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState } from "../../components/RequestState";
import { assertIdentity, readPost } from "./contracts";
import { usePostWrite } from "./usePostWrite";
import "./post-editor.css";

export function PostActions({
  postId,
  post,
  onUnavailable,
}: {
  postId: string;
  post: ReturnType<typeof readPost> | null;
  onUnavailable: (error: Error) => void;
}) {
  const { member } = useSession();
  const location = useLocation(),
    navigate = useNavigate();
  const [search] = useSearchParams();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false),
    [exists, setExists] = useState(false);
  const write = usePostWrite(),
    check = usePostWrite();
  const path = `/v1/posts/${encodeURIComponent(postId)}`;
  const fallback = post?.ticId
    ? pagePath("starBoard", { ticId: post.ticId })
    : "/community?board=FREE";
  const proposed = safeReturnTo(search.get("returnTo"), fallback);
  const returnPath = new URL(proposed, window.location.origin).pathname;
  const deletedPath = `/posts/${encodeURIComponent(postId)}`;
  const back =
    returnPath === deletedPath || returnPath.startsWith(deletedPath + "/")
      ? fallback
      : proposed;
  useEffect(() => {
    if (open && post) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open, post]);
  useEffect(() => {
    for (const error of [write.error, check.error])
      if (error instanceof ApiError && [403, 404].includes(error.status))
        onUnavailable(error);
  }, [write.error, check.error, onUnavailable]);
  if (!post || !member || member.memberId !== post.author.memberId) return null;
  const remove = async () => {
    setExists(false);
    const result = await write.run((signal) =>
      api(path, { method: "DELETE", signal }),
    );
    if (result) navigate(back, { replace: true });
  };
  const verify = async () => {
    const result = await check.run(async (signal) => {
      const current = readPost(await api(path, { signal }));
      assertIdentity(current.postId, post.postId);
      if (current.author.memberId !== member.memberId)
        throw new ApiError(403, "FORBIDDEN", "삭제 권한을 확인할 수 없습니다.");
      return current;
    });
    if (result) setExists(true);
  };
  return (
    <div className="post-actions">
      <Link
        to={pagePath(
          "postEdit",
          { postId: post.postId },
          { returnTo: location.pathname + location.search },
        )}
      >
        글 수정
      </Link>
      <button onClick={() => setOpen(true)}>글 삭제</button>
      <dialog
        ref={dialog}
        className="post-dialog"
        aria-labelledby="delete-title"
        onCancel={(event) => {
          if (write.pending) event.preventDefault();
          else setOpen(false);
        }}
      >
        <h2 id="delete-title">이 글을 삭제할까요?</h2>
        <p>
          삭제하면 본인도 다시 볼 수 없고 복원할 수 없습니다. 분석 기록과
          성과에는 영향을 주지 않습니다.
        </p>
        {write.error && <ErrorState error={write.error} />}
        {check.error && <ErrorState error={check.error} />}
        {write.uncertain && (
          <>
            <button
              disabled={check.pending || write.pending}
              onClick={() => void verify()}
            >
              삭제 결과 확인
            </button>
            {exists && (
              <p role="status">
                현재 글이 조회됩니다. 이전 요청의 처리가 끝나지 않았을 수도
                있습니다. 필요한 경우 직접 다시 삭제할 수 있습니다.
              </p>
            )}
          </>
        )}
        <div className="post-actions">
          <button
            autoFocus
            disabled={write.pending}
            onClick={() => setOpen(false)}
          >
            돌아가기
          </button>
          <button
            disabled={
              write.pending || check.pending || (write.uncertain && !exists)
            }
            onClick={() => void remove()}
          >
            {write.pending
              ? "삭제 결과 확인 중…"
              : write.uncertain
                ? "다시 삭제"
                : "삭제하기"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
