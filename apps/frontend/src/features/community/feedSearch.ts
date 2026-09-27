import { postTags } from "./postContracts";

export const searchScopes = {
  TITLE_BODY: "제목 + 본문",
  TITLE: "제목",
  BODY: "본문",
} as const;
export type FeedSearch = {
  q: string;
  searchIn: string;
  author: string;
  ticId: string;
  board: string;
  tag: string;
};
const fields = ["q", "searchIn", "author", "ticId", "board", "tag"] as const;
// Navigation-only parameters that other screens attach to feed links (the
// star panel, results page and profiles add returnTo). They are not search
// conditions, so the search check skips them instead of rejecting the URL.
const navigationParams: readonly string[] = ["returnTo"];
export function readFeedSearch(params: URLSearchParams, routeTic?: string) {
  const values: FeedSearch = {
    q: params.get("q") ?? "",
    searchIn: params.get("searchIn") ?? "TITLE_BODY",
    author: params.get("author") ?? "",
    ticId: routeTic ?? params.get("ticId") ?? "",
    board: routeTic ? "STAR" : (params.get("board") ?? ""),
    tag: params.get("tag") ?? "",
  };
  const duplicate = [...fields, "cursor"].some(
    (key) => params.getAll(key).length > 1,
  );
  const invalidDirect = [...params].filter(([key]) => !navigationParams.includes(key)).some(([key, value]) =>
    ![...fields, "cursor", "size"].includes(key) ||
    !value.trim() || value.includes("\0") ||
    (key === "size" && (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100)),
  ) || params.getAll("size").length > 1;
  const invalidScope =
    routeTic &&
    ((params.has("ticId") && params.get("ticId") !== routeTic) ||
      (params.has("board") && params.get("board") !== "STAR"));
  const error =
    duplicate || invalidScope || invalidDirect || (values.ticId && values.board === "FREE")
      ? "검색 주소의 조건이 겹칩니다. 조건을 확인한 뒤 다시 검색해 주세요."
      : params.has("searchIn") && !params.has("q")
        ? "검색 범위를 지정하려면 검색어를 입력해 주세요."
        : params.has("q") && !values.q.trim()
          ? "검색어는 공백을 제외하고 1~100자로 입력해 주세요."
          : validateFeedSearch(values);
  return { values, error };
}
export function validateFeedSearch(values: FeedSearch): string | null {
  const q = values.q.trim();
  if ((values.q.length > 0 && !q) || Array.from(q).length > 100)
    return "검색어는 앞뒤 공백을 제외하고 1~100자로 입력해 주세요.";
  if (!Object.hasOwn(searchScopes, values.searchIn))
    return "검색 범위를 다시 선택해 주세요.";
  if (values.board && !["STAR", "FREE"].includes(values.board))
    return "게시판을 다시 선택해 주세요.";
  if (values.tag && !Object.hasOwn(postTags, values.tag))
    return "글 태그를 다시 선택해 주세요.";
  const ticId = values.ticId.trim();
  if (
    ticId &&
    (!/^[1-9]\d{0,18}$/.test(ticId) || BigInt(ticId) > 9223372036854775807n)
  )
    return "TIC 번호는 1~9223372036854775807 범위의 정수로 입력해 주세요.";
  return null;
}
// Parameters are sent as literal text. Matching, ordering and access control
// belong to the server; never filter a single downloaded page in the browser.
export function feedSearchParams(values: FeedSearch) {
  const params = new URLSearchParams();
  for (const key of fields) {
    const value = values[key].trim();
    if (key === "searchIn" && !values.q.trim()) continue;
    if (value) params.set(key, value);
  }
  return params;
}
export function feedSearchHref(
  path: string,
  values: FeedSearch,
  routeTic?: string,
) {
  const params = feedSearchParams(values);
  if (routeTic) {
    params.delete("ticId");
    params.delete("board");
  }
  return path + (params.size ? `?${params}` : "");
}
