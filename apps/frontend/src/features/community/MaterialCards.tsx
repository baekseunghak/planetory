import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import type { GraphMode } from "../history/HistoryGraph";
import {
  PublicHistoryGraph,
  fetchPublicGraph,
  readPublicGraph,
  useSnapshotMissing,
} from "../history/public-graph";
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
      {value.unavailableSources?.map((type, index) => (
        <div className="material-viewer" key={`unavailable-${index}`}>
          <h3>
            공개 출처 ·{" "}
            {type === "PUBLIC_ANALYSIS" ? "공개 분석" : "공식 스레드"}
          </h3>
          <p>공개 취소되었거나 볼 수 없는 출처입니다.</p>
        </div>
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
  const [mode, setMode] = useState<GraphMode>("CURRENT");
  const path = `/v1/${parentType === "POST" ? "posts" : "comments"}/${encodeURIComponent(parentId)}/history-attachments/${encodeURIComponent(id)}`;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { raw, graphError } = await fetchPublicGraph(path, mode, signal);
      const row = materialObject(raw);
      if (
        row.parentType !== parentType ||
        row.parentId !== parentId ||
        row.historyId !== id ||
        row.ticId !== ticId
      )
        return invalidMaterial();
      materialText(row.submittedAt);
      if (row.judgment !== null) materialText(row.judgment);
      const graph = graphError
        ? null
        : readPublicGraph(row.graph, id, ticId, mode);
      return {
        ...row,
        graph,
        graphError,
      };
    },
    [path, mode, parentType, parentId, id, ticId],
  );
  const state = useReadModel(path + mode, load);
  const snapshotMissing = useSnapshotMissing(mode, state.data?.graph);
  const denied =
    state.error instanceof ApiError &&
    [401, 403, 404].includes(state.error.status);
  if (denied) return <ErrorState error={state.error!} />;
  const row: Record<string, unknown> | null = state.data,
    graph = state.data?.graph,
    error = state.error ?? state.data?.graphError;
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
          onClick={() => setMode("CURRENT")}
        >
          현재 자료
        </button>
        <button
          type="button"
          disabled={snapshotMissing}
          aria-pressed={mode === "SUBMITTED"}
          onClick={() => setMode("SUBMITTED")}
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
      {error ? (
        <ErrorState error={error} retry={state.reload} />
      ) : state.loading ? (
        <LoadingState />
      ) : null}
      {/* 그래프 표시는 공개 소비 경계가 맡는다(#191). */}
      {graph && <PublicHistoryGraph graph={graph} mode={mode} />}
    </>
  );
}
