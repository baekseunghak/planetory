// Which app a visit loads: the cinema shell (./main-cinema.tsx) or develop's
// app (./legacy/main.tsx). ./main.tsx decides before anything renders, so a
// visit downloads one app's code and styles only.
//
// - Build-time VITE_CINEMA overrides everything: "true" = cinema,
//   "false" = legacy (main.tsx also checks these literally, so such a build
//   keeps one app only). `npm run dev:cinema` sets "true".
// - Otherwise (the production image sets no VITE_CINEMA) the visitor chooses:
//     ?ui=cinema  remembers localStorage["planetory:ui"] = "cinema" -> cinema
//     ?ui=legacy  forgets it                                        -> legacy
//     nothing     cinema only when remembered                      -> else legacy
//   The default is legacy: the page production serves today.
// - Storage can be missing or throw (private mode, blocked site data). Then
//   `?ui=cinema` still opens cinema for that page load, and without the
//   parameter the visit is legacy.

export type UiChoice = "cinema" | "legacy";

export const UI_STORAGE_KEY = "planetory:ui";
export const UI_PARAM = "ui";

type UiStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `?ui=` of a query string: "cinema", "legacy" or null for anything else. */
export function uiParam(search: string): UiChoice | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get(UI_PARAM);
  } catch {
    return null;
  }
  const normalized = value?.trim().toLowerCase();
  return normalized === "cinema" || normalized === "legacy" ? normalized : null;
}

export function chooseUi(
  build: string | undefined,
  search: string,
  storage: UiStorage | null,
): UiChoice {
  if (build === "true") return "cinema";
  if (build === "false") return "legacy";
  const asked = uiParam(search);
  if (asked === "cinema") {
    try {
      storage?.setItem(UI_STORAGE_KEY, "cinema");
    } catch {
      // Not remembered; this page load still opens the cinema app.
    }
    return "cinema";
  }
  if (asked === "legacy") {
    try {
      storage?.removeItem(UI_STORAGE_KEY);
    } catch {
      // Nothing to forget.
    }
    return "legacy";
  }
  try {
    return storage?.getItem(UI_STORAGE_KEY) === "cinema" ? "cinema" : "legacy";
  } catch {
    return "legacy";
  }
}

/**
 * The address without `?ui=` (other parameters kept byte for byte, hash
 * kept), or null when there is none. The choice is remembered, so the app
 * never sees it.
 */
export function withoutUiParam(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const parts = url.search.replace(/^\?/, "").split("&");
  const kept = parts.filter((part) => {
    const name = part.split("=", 1)[0].replace(/\+/g, " ");
    try {
      return decodeURIComponent(name) !== UI_PARAM;
    } catch {
      return true;
    }
  });
  if (kept.length === parts.length) return null;
  const search = kept.filter(Boolean).join("&");
  return url.pathname + (search ? `?${search}` : "") + url.hash;
}

/** localStorage, or null where reading the property itself throws. */
export function browserStorage(): UiStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The runtime choice for this page load; drops `?ui=` from the address. */
export function chooseUiForPage(build: string | undefined): UiChoice {
  const choice = chooseUi(build, window.location.search, browserStorage());
  const clean = withoutUiParam(window.location.href);
  if (clean !== null) {
    try {
      window.history.replaceState(window.history.state, "", clean);
    } catch {
      // The parameter stays in the address; the apps ignore it.
    }
  }
  return choice;
}
