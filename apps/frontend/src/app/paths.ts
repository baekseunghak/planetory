export const routeDefinitions = [
  { key: "sky", path: "/sky", title: "별지도", owner: "하서진" },
  {
    key: "profile",
    path: "/me",
    title: "마이페이지",
    owner: "하서진 · 내 별/History 목록은 백지웅",
  },
  { key: "settings", path: "/settings", title: "설정", owner: "하서진" },
  {
    key: "member",
    path: "/members/:memberId",
    title: "탐사자 프로필",
    owner: "하서진",
  },
  { key: "community", path: "/community", title: "커뮤니티", owner: "하서진" },
  {
    key: "starBoard",
    path: "/community/stars/:ticId",
    title: "별 게시판",
    owner: "하서진",
  },
  {
    key: "thread",
    path: "/signal-threads/:threadId",
    title: "공식 신호 스레드",
    owner: "하서진",
  },
  { key: "postCreate", path: "/posts/new", title: "글쓰기", owner: "하서진" },
  {
    key: "postEdit",
    path: "/posts/:postId/edit",
    title: "글 수정",
    owner: "하서진",
  },
  { key: "post", path: "/posts/:postId", title: "게시글", owner: "하서진" },
  {
    key: "postAttachment",
    path: "/posts/:postId/history-attachments/:historyId",
    title: "글에 첨부된 분석 기록",
    owner: "하서진 · 그래프는 백지웅",
  },
  {
    key: "commentAttachment",
    path: "/comments/:commentId/history-attachments/:historyId",
    title: "댓글에 첨부된 분석 기록",
    owner: "하서진 · 그래프는 백지웅",
  },
  { key: "analysis", path: "/analysis/:ticId", title: "분석", owner: "백지웅" },
  {
    key: "starResults",
    path: "/results/:ticId",
    title: "별 결과",
    owner: "백지웅",
  },
  {
    key: "submissionResult",
    path: "/submissions/:submissionId/result",
    title: "제출 결과",
    owner: "백지웅",
  },
  { key: "historyList", path: "/history", title: "분석 기록", owner: "백지웅" },
  {
    key: "historyDetail",
    path: "/history/:historyId",
    title: "분석 기록 상세",
    owner: "백지웅",
  },
  {
    key: "publication",
    path: "/publication/:historyId",
    title: "분석 공개 검토",
    owner: "백지웅",
  },
  {
    key: "publicAnalysis",
    path: "/public-analyses/:analysisId",
    title: "공개 분석",
    owner: "백지웅",
  },
  { key: "statistics", path: "/statistics", title: "통계", owner: "백지웅" },
] as const;
export type PageKey = (typeof routeDefinitions)[number]["key"];
export type NavigationContext = {
  returnTo?: string;
  ticId?: string;
  historyId?: string;
  postId?: string;
};

export function safeReturnTo(value: unknown, fallback = "/sky"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return fallback;
  try {
    const url = new URL(value, "https://planetory.invalid");
    if (
      url.origin !== "https://planetory.invalid" ||
      !/^\/(sky|me|settings|members|community|signal-threads|posts|comments|analysis|results|submissions|history|publication|public-analyses|statistics)(\/|$)/.test(
        url.pathname,
      )
    )
      return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

// These are frontend routes, not backend API paths. IDs are never coerced to numbers.
export function pagePath(
  key: PageKey,
  params: Record<string, string> = {},
  context: NavigationContext = {},
): string {
  const definition = routeDefinitions.find((route) => route.key === key)!;
  const path = definition.path.replace(
    /:([A-Za-z]+)/g,
    (_match, name: string) => {
      const id = params[name];
      if (typeof id !== "string" || !id.trim())
        throw new Error(`${name} 문자열이 필요합니다.`);
      return encodeURIComponent(id);
    },
  );
  const search = new URLSearchParams();
  for (const key of ["ticId", "historyId", "postId"] as const) {
    if (context[key] !== undefined) search.set(key, context[key]);
  }
  if (context.returnTo) search.set("returnTo", safeReturnTo(context.returnTo));
  return path + (search.size ? `?${search}` : "");
}
