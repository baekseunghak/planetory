import { safeReturnTo } from "../../app/paths";
import type { createApiClient } from "../../api/client";

/** The post API enforces hidden/deleted access; TIC identity is checked again here. */
export async function checkedAnalysisReturn(
  request: ReturnType<typeof createApiClient>["request"],
  ticId: string,
  destination: string,
  signal: AbortSignal,
) {
  const safe = safeReturnTo(destination, "/sky");
  const path = safe.split("?")[0];
  const match = /^\/posts\/([^/]+)(?:\/history-attachments\/[^/]+)?$/.exec(
    path,
  );
  if (!match || match[1] === "new") return safe;
  const postId = decodeURIComponent(match[1]);
  const post = await request<{ postId: string; ticId: string | null }>(
    `/v1/posts/${encodeURIComponent(postId)}`,
    { signal },
  );
  signal.throwIfAborted();
  if (!post || post.postId !== postId || post.ticId !== ticId)
    throw new Error("원래 글의 항성이 현재 분석과 달라 돌아갈 수 없습니다.");
  return safe;
}
