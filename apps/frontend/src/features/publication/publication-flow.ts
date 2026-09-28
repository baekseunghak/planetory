import type { ReviewItem } from "./use-publication";

export function isPublished(item: ReviewItem) {
  return !item.loading && !item.stale && !item.error &&
    item.preview?.detail.explanation.publication.state === "PUBLISHED";
}

export function allPublished(review: {
  items: ReviewItem[]; loading: boolean; busy: boolean; error?: string; cursor: string | null;
}) {
  return !review.loading && !review.busy && !review.error && !review.cursor &&
    review.items.length > 0 && review.items.every(isPublished);
}

export function publicationNotice(item: ReviewItem) {
  if (item.outcome !== "received") return item.notice;
  if (item.loading || item.stale || item.error)
    return "게시 요청 후 공개 상태를 확인하고 있습니다. 확인되지 않으면 현재 상태를 다시 확인해 주세요.";
  return isPublished(item) ? "게시가 완료되었습니다." : item.notice;
}
