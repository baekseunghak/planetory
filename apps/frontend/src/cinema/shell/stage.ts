// Which scene stage a route is. Pure, so the director and tests share it.
//
// - galaxy    /sky with no star
// - system    /sky?star=<tic> (or the older ?focus=<tic>)
// - analysis  /analysis/:ticId
// - backdrop  every other page, over a dimmed galaxy
import type { SkyMeta } from "../../features/sky-data/contracts";
import type { SkyView } from "../../features/sky-data/store";

export type ShellStage = "galaxy" | "system" | "analysis" | "backdrop";
export type StageTarget = { stage: ShellStage; ticId: string | null };

const tic = (value: string | null | undefined) =>
  value && /^\d{1,19}$/.test(value) ? value : null;

export function readStage(
  pathname: string,
  search: string,
  options: { skyOverride?: boolean } = {},
): StageTarget {
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
