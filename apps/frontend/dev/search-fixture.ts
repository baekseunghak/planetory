// Synthetic S16 contract data. Not an implementation of the production backend.
type Searchable = {
  id: string;
  type: string;
  title: string;
  body?: string;
  ticId: string | null;
  purposeTag?: string;
  author: { nickname?: string; type?: string };
  createdAt: string;
};
export function searchFixtureFeed<T extends Searchable>(
  items: T[],
  params: URLSearchParams,
) {
  const q = params.get("q")?.trim(),
    scope = params.get("searchIn") ?? "TITLE_BODY";
  const author = params.get("author"),
    tag = params.get("tag"),
    board = params.get("board"),
    tic = params.get("ticId"),
    type = params.get("type");
  if (
    (params.has("type") && !["POST", "SIGNAL_THREAD"].includes(type ?? "")) ||
    (type === "SIGNAL_THREAD" && (author || tag || board === "FREE")) ||
    (params.has("q") && (!q || Array.from(q).length > 100)) ||
    (params.has("searchIn") && !q) ||
    !["TITLE_BODY", "TITLE", "BODY"].includes(scope) ||
    (board && !["STAR", "FREE"].includes(board)) ||
    (tag &&
      ![
        "ANALYSIS",
        "QUESTION",
        "DISCUSSION",
        "INFORMATION",
        "GENERAL",
      ].includes(tag))
  )
    return null;
  return items
    .filter((item) => {
      if (type && item.type !== type) return false;
      if (tic && tic !== item.ticId) return false;
      if (board && (board === "FREE") !== (item.ticId === null)) return false;
      if (
        author &&
        (item.type !== "POST" ||
          item.author.nickname?.toLowerCase() !== author.toLowerCase())
      )
        return false;
      if (tag && (item.type !== "POST" || item.purposeTag !== tag))
        return false;
      if (!q) return true;
      const texts =
        scope === "TITLE"
          ? [item.title]
          : scope === "BODY"
            ? [item.body ?? ""]
            : [item.title, item.body ?? ""];
      return texts.some((text) => text.toLowerCase().includes(q.toLowerCase()));
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
}
