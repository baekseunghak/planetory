import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { CommunityFeed } from "./CommunityFeed";
import type { CursorPage, FeedItem } from "./contracts";

type Item = FeedItem & { matchedBy?: ("MEMBER" | "STAR")[] };
export function ExpandableFeed({
  initial,
  path,
  decode,
  hot = false,
}: {
  initial: CursorPage<Item>;
  path: string;
  decode: (value: unknown, cursor: string | null) => CursorPage<Item>;
  hot?: boolean;
}) {
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setPage(initial);
    setBusy(false);
    setError("");
    setNotice("");
  }, [initial]);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function more() {
    if (pending.current || !page.hasNext || !page.nextCursor) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    const cursor = page.nextCursor;
    const [base, query] = path.split("?");
    const params = new URLSearchParams(query);
    params.set("cursor", cursor);
    try {
      const next = decode(
        await api(`${base}?${params}`, { signal: controller.signal }),
        cursor,
      );
      if (controller.signal.aborted) return;
      const known = new Set(
        page.items.map((item) => `${item.type}:${item.id}`),
      );
      const added = next.items.filter((item) => {
        const key = `${item.type}:${item.id}`;
        if (known.has(key)) return false;
        known.add(key);
        return true;
      });
      setPage({ ...next, items: [...page.items, ...added] });
      setNotice(`${added.length}개의 글을 더 불러왔습니다.`);
    } catch {
      if (!controller.signal.aborted)
        setError("글을 더 불러오지 못했습니다. 다시 시도해 주세요.");
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <CommunityFeed items={page.items} hot={hot} />
      <div className="community-load-more">
        {error && <p role="alert">{error}</p>}
        {page.hasNext && (
          <button type="button" disabled={busy} onClick={() => void more()}>
            {busy ? "불러오는 중…" : error ? "다시 시도" : "더 보기"}
          </button>
        )}
        <span role="status" className="sr-only">
          {notice}
        </span>
      </div>
    </>
  );
}
