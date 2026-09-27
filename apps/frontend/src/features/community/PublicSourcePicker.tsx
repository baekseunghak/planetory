import { useCallback, useState } from "react";
import { api } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { endpoint, readFeed, readAnalyses, judgmentLabels } from "./contracts";
import { useReadModel } from "./useReadModel";
import type { Source } from "./materialContracts";

export function PublicSourcePicker({ ticId, disabled, selected, onSelect }: {
  ticId: string; disabled: boolean; selected: Source[]; onSelect(source: Source): void;
}) {
  const [thread, setThread] = useState<{ id: string; title: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const path = thread
    ? endpoint(`/v1/signal-threads/${encodeURIComponent(thread.id)}/analyses`, { size: "20", cursor })
    : endpoint("/v1/community/feed", { ticId, type: "SIGNAL_THREAD", size: "20", cursor });
  const load = useCallback(async (signal: AbortSignal) => {
    const raw = await api(path, { signal });
    if (thread) {
      const page = readAnalyses(raw, cursor);
      return { ...page, items: page.items.map((item) => ({ id: item.analysisId, title: `${item.author.nickname} · ${judgmentLabels[item.judgment]} · ${new Date(item.submittedAt).toLocaleDateString("ko-KR")}`, type: "PUBLIC_ANALYSIS" as const })) };
    }
    const page = readFeed(raw, cursor);
    return { ...page, items: page.items.filter((item) => item.type === "SIGNAL_THREAD").map((item) => ({ id: item.id, title: item.title, type: "SIGNAL_THREAD" as const })) };
  }, [path, cursor, thread]);
  const state = useReadModel(path, load);
  return <div className="public-source-picker">
    <p>{thread ? `${thread.title}의 공개 분석` : "같은 별의 공식 스레드를 첨부하거나, 스레드 안의 공개 분석을 골라 주세요."}</p>
    {thread && <button type="button" onClick={() => { setThread(null); setCursor(null); }}>공식 스레드 목록으로</button>}
    {!state.data ? state.error ? <ErrorState error={state.error} retry={state.reload} /> : <LoadingState /> : <>
      <ul>{state.data.items.map((item) => {
        const attached = selected.some((source) => source.id === item.id && source.type === item.type);
        return <li key={item.id}><span>{item.title}</span><div>
          <button type="button" disabled={disabled || attached} onClick={() => onSelect({ type: item.type, id: item.id })}>{attached ? "첨부됨" : "첨부"}</button>
          {item.type === "SIGNAL_THREAD" && <button type="button" onClick={() => { setThread({ id: item.id, title: item.title }); setCursor(null); }}>공개 분석 보기</button>}
        </div></li>;
      })}</ul>
      {!state.data.items.length && <p>{state.data.hasNext ? "이 페이지에는 첨부할 출처가 없습니다. 다음 목록을 확인해 주세요." : "표시할 공개 출처가 없습니다."}</p>}
      {cursor && <button type="button" onClick={() => setCursor(null)}>처음 목록</button>}
      {state.data.hasNext && <button type="button" onClick={() => setCursor(state.data!.nextCursor)}>다음 목록</button>}
    </>}
  </div>;
}