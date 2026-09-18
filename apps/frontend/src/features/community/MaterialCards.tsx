import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import {
  SharedHistoryGraph,
  readHistoryGraph,
  isGraphPending,
  type GraphMode,
} from "../history/HistoryGraph";
import { endpoint, judgmentLabels, type Author } from "./contracts";
import {
  materialObject,
  materialText,
  invalidMaterial,
  readSource,
  type Materials,
  type Source,
} from "./materialContracts";
import { useReadModel } from "./useReadModel";
import "./materials.css";

export function MaterialCards({
  value,
  ticId,
  parentType,
  parentId,
  author,
}: {
  value: Materials;
  ticId: string | null;
  parentType: "POST" | "COMMENT";
  parentId: string;
  author: Author;
}) {
  if (!ticId) return null;
  return (
    <>
      {value.historyIds?.map((id) => (
        <HistoryAttachment
          key={id}
          id={id}
          ticId={ticId}
          parentType={parentType}
          parentId={parentId}
          author={author}
        />
      ))}
      {value.sourceLinks?.map((source) => (
        <SourceCard
          key={source.type + source.id}
          source={source}
          ticId={ticId}
        />
      ))}
    </>
  );
}
function SourceCard({ source, ticId }: { source: Source; ticId: string }) {
  const path = endpoint("/v1/source-cards", { ...source, ticId });
  const load = useCallback(
    async (signal: AbortSignal) =>
      readSource(await api(path, { signal }), source, ticId),
    [path, source.type, source.id, ticId],
  );
  const state = useReadModel(path, load);
  if (!state.data)
    return (
      <div className="material-viewer">
        {state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )}
      </div>
    );
  const author = state.data.author as { nickname?: string } | undefined;
  return (
    <div className="material-viewer">
      <h3>
        공개 출처 ·{" "}
        {source.type === "PUBLIC_ANALYSIS" ? "공개 분석" : "공식 스레드"}
      </h3>
      <p>
        {typeof author?.nickname === "string" ? author.nickname : "SYSTEM"} ·
        TIC {ticId}
      </p>
      {typeof state.data.judgment === "string" && (
        <p>
          판단:{" "}
          {judgmentLabels[state.data.judgment as keyof typeof judgmentLabels] ??
            state.data.judgment}
        </p>
      )}
      <Link
        to={
          source.type === "PUBLIC_ANALYSIS"
            ? `/public-analyses/${encodeURIComponent(source.id)}`
            : `/signal-threads/${encodeURIComponent(source.id)}`
        }
      >
        출처 {source.id} 열기
      </Link>
    </div>
  );
}
function HistoryAttachment({
  id,
  ticId,
  parentType,
  parentId,
  author,
}: {
  id: string;
  ticId: string;
  parentType: "POST" | "COMMENT";
  parentId: string;
  author: Author;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="material-viewer" aria-label={`첨부 기록 ${id}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        분석 기록 {id} {open ? "접기" : "열기"}
      </button>
      {open && (
        <AttachmentDetail
          key={`${parentType}:${parentId}:${id}`}
          id={id}
          ticId={ticId}
          parentType={parentType}
          parentId={parentId}
          author={author}
        />
      )}
    </section>
  );
}
function AttachmentDetail({
  id,
  ticId,
  parentType,
  parentId,
  author,
}: {
  id: string;
  ticId: string;
  parentType: "POST" | "COMMENT";
  parentId: string;
  author: Author;
}) {
  const [mode, setMode] = useState<GraphMode>("CURRENT"),
    [snapshotMissing, setSnapshotMissing] = useState(false);
  const poll = useRef(0),
    [lastMeta, setLastMeta] = useState<Record<string, unknown> | null>(null);
  const path = `/v1/${parentType === "POST" ? "posts" : "comments"}/${encodeURIComponent(parentId)}/history-attachments/${encodeURIComponent(id)}`;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const row = materialObject(
        await api(endpoint(path, { graphMode: mode }), { signal }),
      );
      if (
        row.parentType !== parentType ||
        row.parentId !== parentId ||
        row.historyId !== id ||
        row.ticId !== ticId
      )
        return invalidMaterial();
      materialText(row.submittedAt);
      materialText(row.judgment);
      return { ...row, graph: readHistoryGraph(row.graph, id, ticId, mode) };
    },
    [path, mode, parentType, parentId, id, ticId],
  );
  const state = useReadModel(path + mode, load);
  useEffect(() => {
    if (state.data) {
      setLastMeta(state.data);
      if (mode === "SUBMITTED" && state.data.graph.snapshot === null)
        setSnapshotMissing(true);
    }
  }, [state.data, mode]);
  useEffect(() => {
    if (!state.data || !isGraphPending(state.data.graph) || poll.current >= 6)
      return;
    const timer = setTimeout(() => {
      poll.current++;
      state.reload();
    }, 5000);
    return () => clearTimeout(timer);
  }, [state.data, state.reload]);
  const denied =
    state.error instanceof ApiError &&
    [401, 403, 404].includes(state.error.status);
  if (denied) return <ErrorState error={state.error!} />;
  // No retained graph is rendered while loading or failing; metadata survives a graph dependency error only.
  const row: Record<string, unknown> | null =
      state.data ?? (state.error ? lastMeta : null),
    graph = state.data?.graph;
  const label = (v: unknown) =>
    typeof v === "string"
      ? (judgmentLabels[v as keyof typeof judgmentLabels] ?? v)
      : "제공되지 않음";
  return (
    <>
      <nav aria-label="첨부 그래프 자료 판">
        <button
          type="button"
          aria-pressed={mode === "CURRENT"}
          onClick={() => {
            poll.current = 0;
            setMode("CURRENT");
          }}
        >
          현재 자료
        </button>
        <button
          type="button"
          disabled={snapshotMissing}
          aria-pressed={mode === "SUBMITTED"}
          onClick={() => {
            poll.current = 0;
            setMode("SUBMITTED");
          }}
        >
          제출 당시
        </button>
      </nav>
      {row && (
        <dl>
          <dt>작성자</dt>
          <dd>{author.nickname}</dd>
          <dt>제출 시각</dt>
          <dd>{new Date(String(row.submittedAt)).toLocaleString("ko-KR")}</dd>
          <dt>판단</dt>
          <dd>{label(row.judgment)}</dd>
          <dt>근거</dt>
          <dd>
            {Array.isArray(row.evidenceChecks)
              ? row.evidenceChecks
                  .map(
                    (value) =>
                      ({
                        oddeven: "홀짝 깊이 비교",
                        secondary: "이차 식 확인",
                        ushape: "U형 모양 확인",
                      })[String(value) as "oddeven" | "secondary" | "ushape"] ??
                      String(value),
                  )
                  .join(", ") || "선택한 근거 없음"
              : "제공되지 않음"}
          </dd>
          <dt>메모</dt>
          <dd>{typeof row.memo === "string" ? row.memo : "제공되지 않음"}</dd>
        </dl>
      )}
      {state.error ? (
        <ErrorState error={state.error} retry={state.reload} />
      ) : state.loading ? (
        <LoadingState />
      ) : null}
      {graph && (
        <>
          <p>
            제출 판 {graph.reproduction.submittedBundleId} · 현재 판{" "}
            {graph.reproduction.currentBundleId}
          </p>
          {graph.reproduction.fallbackReason && (
            <p>
              당시 잔차를 재현할 수 없어 제공 가능한 현재 원본 자료를
              확인합니다. 사유: {graph.reproduction.fallbackReason}
            </p>
          )}
          {mode === "SUBMITTED" ? (
            graph.snapshot ? (
              <SharedHistoryGraph graph={graph} mode={mode} readOnly />
            ) : (
              <p role="status">
                제출 당시 스냅샷이 없습니다. 현재 자료를 당시 자료로 대신
                표시하지 않습니다.
              </p>
            )
          ) : graph.curve?.segments?.length ? (
            <>
              <p>
                {graph.curve.curveContext.curveStep === 0
                  ? "현재 원본 곡선"
                  : "현재 잔차 곡선"}
              </p>
              <SharedHistoryGraph graph={graph} mode={mode} readOnly />
            </>
          ) : (
            <p role="status">
              {isGraphPending(graph)
                ? "기존 잔차 작업이 진행 중입니다."
                : graph.curve?.residual?.status === "FAILED"
                  ? "잔차 처리에 실패했습니다."
                  : "제공 가능한 현재 그래프가 없습니다."}{" "}
              제출 당시 자료도 확인할 수 있습니다.
            </p>
          )}
          {isGraphPending(graph) && poll.current >= 6 && (
            <button
              type="button"
              onClick={() => {
                poll.current = 0;
                state.reload();
              }}
            >
              작업 상태 다시 확인
            </button>
          )}
        </>
      )}
    </>
  );
}
