import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import {
  SharedHistoryGraph,
  readHistoryGraph,
  type GraphMode,
  type HistoryGraphDto,
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

function fallbackMessage(graph: HistoryGraphDto, mode: GraphMode) {
  const reason = graph.reproduction.fallbackReason;
  if (!reason) return null;
  if (mode === "SUBMITTED") {
    // 재현 가능성은 현재 판의 참고값이다. 저장된 배열이 대체됐다는 뜻이 아니다.
    if (reason !== "RETIRED_CANDIDATE") return null;
    const message = "현재 데이터에서는 당시 잔차 조합을 재현할 수 없습니다.";
    return graph.snapshot
      ? `${message} 아래 배열은 당시 그대로입니다.`
      : message;
  }
  if (reason === "RETIRED_CANDIDATE")
    return "당시 조합에 은퇴한 후보가 있어 원본 곡선으로 대체했습니다.";
  if (reason === "RESIDUAL_NOT_AVAILABLE")
    return "현재 사용할 수 있는 잔차 자료가 없어 현재 원본 곡선으로 표시합니다.";
  return "현재 자료의 재현 상태를 확인할 수 없습니다.";
}

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
  const [mode, setMode] = useState<GraphMode>("CURRENT"),
    [snapshotMissing, setSnapshotMissing] = useState(false);
  const path = `/v1/${parentType === "POST" ? "posts" : "comments"}/${encodeURIComponent(parentId)}/history-attachments/${encodeURIComponent(id)}`;
  const load = useCallback(
    async (signal: AbortSignal) => {
      let raw: unknown;
      let graphError: ApiError | null = null;
      try {
        raw = await api(endpoint(path, { graphMode: mode }), { signal });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 503) throw error;
        // 첫 그래프 조회 실패도 공개 내용을 잃지 않는다. 저장된 응답 대신 현재 부모 권한을 다시 검사한다.
        raw = await api(
          endpoint(path, { graphMode: mode, includeGraph: "false" }),
          { signal },
        );
        graphError = error;
      }
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
        : readHistoryGraph(row.graph, id, ticId, mode);
      // 공개 응답에는 완료된 작업도 jobId를 포함하지 않는다(탐사 8.3).
      // 개인 History와 공유하는 파서 대신 공개 소비 경계에서 검사한다.
      if (graph?.curve?.residual?.jobId != null) return invalidMaterial();
      return {
        ...row,
        graph,
        graphError,
      };
    },
    [path, mode, parentType, parentId, id, ticId],
  );
  const state = useReadModel(path + mode, load);
  useEffect(() => {
    if (state.data) {
      if (
        mode === "SUBMITTED" &&
        state.data.graph &&
        state.data.graph.snapshot === null
      )
        setSnapshotMissing(true);
    }
  }, [state.data, mode]);
  const denied =
    state.error instanceof ApiError &&
    [401, 403, 404].includes(state.error.status);
  if (denied) return <ErrorState error={state.error!} />;
  const row: Record<string, unknown> | null = state.data,
    graph = state.data?.graph,
    error = state.error ?? state.data?.graphError;
  const fallback = graph ? fallbackMessage(graph, mode) : null;
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
      {graph && (
        <>
          <p>
            제출 판 {graph.reproduction.submittedBundleId} · 현재 판{" "}
            {graph.reproduction.currentBundleId}
          </p>
          {fallback && <p>{fallback}</p>}
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
              {graph.curve?.residual?.status === "FAILED"
                ? "잔차 처리에 실패했습니다."
                : "제공 가능한 현재 그래프가 없습니다."}{" "}
              제출 당시 자료도 확인할 수 있습니다.
            </p>
          )}
        </>
      )}
    </>
  );
}
