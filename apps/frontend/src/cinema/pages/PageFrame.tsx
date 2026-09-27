// The product frame every page over the dimmed galaxy sits in: one column
// width, one title style, panels, lists, forms and request states on the
// cinema tokens (pages.css). The feature component inside keeps its data,
// rules and markup; the frame only places and dresses it.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MySkyPreviewSlot } from "../../features/sky-data/MySkyPreview";
import type { SkySnapshot } from "../../features/sky-data/store";
import { useCinemaSky } from "../shell/sky";

export type FrameWidth = "wide" | "standard" | "reading";

export type FrameHead = {
  eyebrow?: string;
  title: string;
  lede?: string;
};

export function PageFrame({
  page,
  width = "standard",
  head,
  children,
}: {
  /** Page name for scoped styles (`data-page`). */
  page: string;
  width?: FrameWidth;
  /** Title area for feature pages that have no page title of their own. */
  head?: FrameHead;
  children: ReactNode;
}) {
  return (
    <MySkyPreviewSlot.Provider value={SkyCard}>
      <div className="cp-page" data-page={page} data-width={width}>
        {head && (
          <header className="cp-head">
            {head.eyebrow && <p className="cp-eyebrow">{head.eyebrow}</p>}
            <h1>{head.title}</h1>
            {head.lede && <p className="cp-lede">{head.lede}</p>}
          </header>
        )}
        {children}
      </div>
    </MySkyPreviewSlot.Provider>
  );
}

/** Planets are counted once every star of this sky version is loaded. */
function planetTotal(data: SkySnapshot) {
  if (!data.meta || data.phase !== "ready") return null;
  if (data.loadedCount !== data.meta.starCount) return null;
  return data.stars.reduce((sum, star) => sum + star.planetCount, 0);
}

/**
 * "My galaxy" card in place of the old 2D preview: the galaxy itself is on
 * screen behind the page, and the shell already holds its data.
 */
export function SkyCard() {
  const { data } = useCinemaSky();
  const stars = data.meta?.starCount ?? null;
  const planets = planetTotal(data);
  const format = (value: number | null) =>
    value === null ? "–" : value.toLocaleString("ko-KR");
  return (
    <section className="cp-sky-card" aria-label="나의 은하">
      <p className="cp-eyebrow">나의 은하</p>
      <dl>
        <div>
          <dt>발견한 별</dt>
          <dd className="cp-num">{format(stars)}</dd>
        </div>
        <div>
          <dt>찾은 행성</dt>
          <dd className="cp-num">{format(planets)}</dd>
        </div>
      </dl>
      {data.error && !data.meta ? (
        <p role="status">은하 정보를 불러오지 못했습니다.</p>
      ) : (
        <p>
          {stars === 0
            ? "첫 발견으로 은하를 채워 보세요."
            : "발견한 별들이 모여 나만의 은하가 됩니다."}
        </p>
      )}
      <Link className="cp-button" to="/sky">
        나의 은하로
      </Link>
    </section>
  );
}
