import { useEffect, useState } from "react";
import { api } from "../../api";
import { discoveredPath, readDiscoveredPage, type DiscoveredPage } from "../sky-renderer/discovered";

export function PostStarPicker({ value, onSelect }: { value: string; onSelect(ticId: string): void }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<DiscoveredPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void api(discoveredPath(cursor), { signal: controller.signal }).then((raw) => {
      if (controller.signal.aborted) return;
      const next = readDiscoveredPage(raw);
      if (next.hasNext && next.nextCursor === cursor) throw new Error("Repeated cursor");
      setPage((previous) => ({ ...next, items: [...new Map([...(cursor ? previous?.items ?? [] : []), ...next.items].map((star) => [star.ticId, star])).values()] }));
    }).catch(() => {
      if (!controller.signal.aborted) setError("별 목록을 불러오지 못했습니다.");
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    const explored = page?.items.filter((star) => star.progressStage !== "unexplored") ?? [];
  return () => controller.abort();
  }, [open, cursor, retry]);
  const explored = page?.items.filter((star) => star.progressStage !== "unexplored") ?? [];
  return (
    <details className="post-star-picker" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>내 별 목록에서 선택</summary>
      <p>탐사 중이거나 탐사를 완료한 내 별을 최근 활동 순으로 보여 드립니다.</p>
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((n) => n + 1)}>다시 불러오기</button></p>}
      <div className="post-star-options" aria-busy={busy}>
        {explored.map((star) => (
          <button type="button" key={star.ticId} aria-pressed={value === star.ticId} onClick={() => { onSelect(star.ticId); setOpen(false); }}>
            <strong>TIC {star.ticId}</strong>
            <span>{{ unexplored: "미탐사", in_progress: "탐사 중", completed: "탐사 완료" }[star.progressStage]} · 행성 {star.planetCount}개</span>
          </button>
        ))}
        {page?.hasNext && !error && <button type="button" disabled={busy} onClick={() => setCursor(page.nextCursor)}>더 보기</button>}
      </div>
      <p role="status">{busy ? "별 목록을 불러오는 중…" : page && explored.length === 0 ? (page.hasNext ? "현재 불러온 목록에는 탐사한 별이 없습니다. 더 보기로 다음 목록을 확인해 주세요." : "탐사한 별이 없습니다.") : ""}</p>
    </details>
  );
}