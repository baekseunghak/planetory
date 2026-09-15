import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { safeReturnTo } from "./paths";

export function usePageContext() {
  const params = useParams<
    | "ticId"
    | "memberId"
    | "historyId"
    | "postId"
    | "analysisId"
    | "submissionId"
    | "threadId"
    | "commentId"
  >();
  const [search] = useSearchParams();
  const location = useLocation();
  return {
    ...params,
    ticId: params.ticId ?? search.get("ticId") ?? undefined,
    historyId: params.historyId ?? search.get("historyId") ?? undefined,
    postId: params.postId ?? search.get("postId") ?? undefined,
    returnTo: safeReturnTo(search.get("returnTo")),
    currentPath: location.pathname + location.search + location.hash,
  };
}
