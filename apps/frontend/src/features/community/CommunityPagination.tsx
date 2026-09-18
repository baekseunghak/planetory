import { Link, useLocation } from "react-router-dom";
import type { CursorPage } from "./contracts";
export function Pager({
  page,
  name,
  label,
}: {
  page: CursorPage<unknown>;
  name: string;
  label: string;
}) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const cursor = search.get(name);
  const raw: unknown = location.state?.communityCursors?.[name];
  const trail: string[] =
    Array.isArray(raw) && raw.every((item) => typeof item === "string")
      ? raw
      : [];
  const target = (value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    return location.pathname + (next.size ? `?${next}` : "");
  };
  const state = (values: string[]) => ({
    ...location.state,
    communityRestore: undefined,
    communityCursors: { ...location.state?.communityCursors, [name]: values },
  });
  return (
    <nav className="community-pagination" aria-label={label}>
      {cursor && (
        <Link to={target(null)} state={state([])}>
          처음 페이지
        </Link>
      )}
      {trail.length > 0 && (
        <Link
          to={target(trail[trail.length - 1])}
          state={state(trail.slice(0, -1))}
        >
          이전 페이지
        </Link>
      )}
      {page.hasNext ? (
        <Link
          to={target(page.nextCursor)}
          state={state([...trail, cursor ?? ""])}
        >
          다음 페이지 →
        </Link>
      ) : (
        <span>마지막 페이지</span>
      )}
    </nav>
  );
}
