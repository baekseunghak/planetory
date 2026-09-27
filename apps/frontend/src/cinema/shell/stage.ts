// Which scene stage a route is. Pure, so the director and tests share it.
//
// - galaxy    /sky with no star
// - system    /sky?star=<tic> (or the older ?focus=<tic>)
// - analysis  /analysis/:ticId
// - public    /members/:memberId/sky, another member's galaxy in the same
//             scene (only with `publicGalaxy`; see shell/public-galaxy). The
//             public view owns the scene's stars, system and flights there.
// - backdrop  every other page, over a dimmed galaxy
import type { SkyMeta } from "../../features/sky-data/contracts";
import type { SkyView } from "../../features/sky-data/store";

export type ShellStage =
  "galaxy" | "system" | "analysis" | "public" | "backdrop";
export type StageTarget = {
  stage: ShellStage;
  ticId: string | null;
  /** `public` only: whose galaxy. */
  memberId?: string;
};

const tic = (value: string | null | undefined) =>
  value && /^\d{1,19}$/.test(value) ? value : null;

export function readStage(
  pathname: string,
  search: string,
  options: { skyOverride?: boolean; publicGalaxy?: boolean } = {},
): StageTarget {
  const publicSky = options.publicGalaxy
    ? /^\/members\/([^/]+)\/sky\/?$/.exec(pathname)
    : null;
  if (publicSky) {
    let memberId: string | null = null;
    try {
      memberId = decodeURIComponent(publicSky[1]);
    } catch {
      memberId = null;
    }
    if (memberId) return { stage: "public", ticId: null, memberId };
  }
  if (pathname === "/sky" && !options.skyOverride) {
    const params = new URLSearchParams(search);
    const selected = tic(params.get("star")) ?? tic(params.get("focus"));
    return selected
      ? { stage: "system", ticId: selected }
      : { stage: "galaxy", ticId: null };
  }
  const analysis = /^\/analysis\/([^/]+)\/?$/.exec(pathname);
  if (analysis) {
    let id: string | null = null;
    try {
      id = tic(decodeURIComponent(analysis[1]));
    } catch {
      id = null;
    }
    return { stage: "analysis", ticId: id };
  }
  return { stage: "backdrop", ticId: null };
}

/** `/sky` search without the star selection, keeping filters and the rest. */
export function galaxySearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("star");
  params.delete("focus");
  params.delete("view");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** `/sky?star=<tic>`, keeping search filters. */
export function starSearch(search: string, ticId: string): string {
  const params = new URLSearchParams(search);
  params.delete("focus");
  params.delete("view");
  params.set("star", ticId);
  return `?${params}`;
}

/**
 * The whole galaxy in one view at the coarsest level. The persistent scene
 * shows every star, so the store loads the full stored bounds once.
 */
export function fullSkyView(meta: SkyMeta): SkyView {
  const b = meta.bounds,
    size = meta.tileSize;
  return {
    level: meta.zoomLevels[0].level,
    box: {
      x: b.minX,
      y: b.minY,
      w: Math.max(size, b.maxX - b.minX),
      h: Math.max(size, b.maxY - b.minY),
    },
  };
}

/** Old page container classes, so the classic pages keep their layout. */
export function legacyMainClass(pathname: string): string {
  if (pathname.startsWith("/analysis/")) return "page analysis-page-container";
  if (pathname === "/sky" || /^\/members\/[^/]+\/sky$/.test(pathname))
    return "page sky-page-container";
  if (
    /^(\/community|\/posts|\/signal-threads|\/stars\/[^/]+\/board|\/me$|\/members\/)/.test(
      pathname,
    )
  )
    return "page service-page";
  return "page";
}

/**
 * The browser tab title of a cinema screen: "나의 은하 · Planetory",
 * "TIC 149603524 분석 · Planetory"… Unknown paths get the bare name.
 */
export function cinemaTitle(pathname: string, search = ""): string {
  const tic = (value: string | null | undefined) =>
    value && /^\d{1,19}$/.test(value) ? value : null;
  let name: string | null = null;
  const analysis = /^\/analysis\/([^/]+)\/?$/.exec(pathname);
  const results = /^\/results\/([^/]+)\/?$/.exec(pathname);
  if (pathname === "/login" || pathname === "/oauth/callback") name = "로그인";
  else if (pathname === "/sky") {
    const star = tic(new URLSearchParams(search).get("star"));
    name = star ? `TIC ${star} · 나의 은하` : "나의 은하";
  } else if (analysis)
    name = tic(analysis[1]) ? `TIC ${analysis[1]} 분석` : "분석";
  else if (results)
    name = tic(results[1]) ? `TIC ${results[1]} 분석 결과` : "분석 결과";
  else if (
    /^\/(community|posts|signal-threads|public-analyses|comments)(\/|$)/.test(
      pathname,
    )
  )
    name = "커뮤니티";
  else if (/^\/members\/[^/]+\/sky\/?$/.test(pathname))
    name = "다른 탐사자의 은하";
  else if (/^\/members\/[^/]+\/?$/.test(pathname)) name = "탐사자 프로필";
  else if (/^\/history(\/|$)/.test(pathname)) name = "분석 기록";
  else if (/^\/publication(\/|$)/.test(pathname)) name = "분석 공개";
  else if (/^\/settings(\/|$)/.test(pathname)) name = "설정";
  else if (pathname === "/me" || pathname.startsWith("/me/"))
    name = "마이페이지";
  else if (pathname === "/notifications") name = "알림";
  else if (pathname === "/statistics") name = "통계";
  return name ? `${name} · Planetory` : "Planetory";
}
