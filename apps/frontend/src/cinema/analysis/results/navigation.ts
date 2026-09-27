import { pagePath, safeReturnTo } from "../../../app/paths";

const transient = /^\/(analysis|results|history\/[^/]+|submissions)(\/|$)/;

/** Keep the entry list/galaxy and its filters, not a chain of result/detail visits. */
export function explorationOrigin(value: string, ticId: string): string {
  const fallback = `/sky?star=${encodeURIComponent(ticId)}`;
  let path = safeReturnTo(value, fallback);
  for (let depth = 0; depth < 16; depth++) {
    const url = new URL(path, "https://planetory.invalid");
    if (!transient.test(url.pathname)) {
      url.searchParams.delete("returnTo");
      return url.pathname + url.search + url.hash;
    }
    path = safeReturnTo(url.searchParams.get("returnTo"), fallback);
  }
  return fallback;
}

/** A record may return to its star result or analysis, but only one level deep. */
export function recordParent(value: string, ticId: string): string {
  const path = safeReturnTo(value);
  const url = new URL(path, "https://planetory.invalid");
  const origin = explorationOrigin(path, ticId);
  if (/^\/(results|analysis)\/[^/]+\/?$/.test(url.pathname)) {
    url.searchParams.set("returnTo", origin);
    return url.pathname + url.search + url.hash;
  }
  return origin;
}

export function starResultsLocation(ticId: string, returnTo: string): string {
  return pagePath("starResults", { ticId }, {
    returnTo: explorationOrigin(returnTo, ticId),
  });
}

export function explorationBackLabel(path: string): string {
  if (path.startsWith("/results/")) return "이 별의 탐사 결과로 돌아가기";
  if (path.startsWith("/analysis/")) return "분석으로 돌아가기";
  if (/^\/history(?:\?|$)/.test(path)) return "내 분석 기록으로 돌아가기";
  if (/^\/me(?:\?|$)/.test(path)) return "마이페이지로 돌아가기";
  if (path.startsWith("/sky")) return "나의 은하로 돌아가기";
  if (/^\/(posts|comments)\//.test(path)) return "글로 돌아가기";
  return "이전 화면으로 돌아가기";
}
