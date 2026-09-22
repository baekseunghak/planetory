import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { usePageContext } from "../../app/usePageContext.ts";
import { judgmentLabels } from "../community/contracts";
import {
  invalidMaterial,
  materialObject,
  materialText,
} from "../community/materialContracts";
import { useReadModel } from "../community/useReadModel";
import type { GraphMode, HistoryGraphDto } from "./HistoryGraph";
import {
  PublicHistoryGraph,
  fetchPublicGraph,
  readPublicGraph,
  useSnapshotMissing,
} from "./public-graph";
import "./public-analysis.css";

// #191 공개 분석 상세. **첨부 카드와 같은 공개 투영이다** — 서버가 같은
// `publicContent`·`publicGraph`로 만든다. 그래서 그래프를 읽고 보여 주는 규칙을
// 새로 쓰지 않고 공개 소비 경계(`public-graph.tsx`)를 그대로 쓴다.
//
// **이 화면이 맡지 않는 것**: 댓글·반응·스레드 이동. 공개 분석을 둘러싼 커뮤니티
// 기능은 별도 담당이며, 여기서는 191 완료 조건이 요구하는 것만 보여 준다 —
// 허용된 공개 내용과 그래프, 그리고 없음·거절·장애의 구분.

const EVIDENCE: Record<string, string> = {
  oddeven: "홀짝 깊이 비교",
  secondary: "이차 식 확인",
  ushape: "U형 모양 확인",
};

export function PublicAnalysisPage() {
  const { analysisId = "", returnTo } = usePageContext();
  const [mode, setMode] = useState<GraphMode>("CURRENT");
  const path = `/v1/public-analyses/${encodeURIComponent(analysisId)}`;

  const load = useCallback(
    async (signal: AbortSignal) => {
      const { raw, graphError } = await fetchPublicGraph(path, mode, signal);
      const row = materialObject(raw);
      // 주소가 가리킨 것과 다른 것을 받아 그리지 않는다.
      if (row.analysisId !== analysisId) invalidMaterial();
      const ticId = materialText(row.ticId);
      materialText(row.submittedAt);
      // 첨부와 달리 주소에 History ID가 없다. 대조할 수 있는 것은 별이며,
      // 공용 파서가 곡선의 ticId를 이 값과 맞춰 본다.
      let graph: HistoryGraphDto | null = null;
      if (!graphError) {
        const historyId = materialText(materialObject(row.graph).historyId);
        graph = readPublicGraph(row.graph, historyId, ticId, mode);
      }
      return { ...row, ticId, graph, graphError };
    },
    [path, mode, analysisId],
  );

  const state = useReadModel(path + mode, load);
  const snapshotMissing = useSnapshotMissing(mode, state.data?.graph);

  // 권한이 없거나 철회된 것은 내용을 남기지 않는다(서비스 API 7.2).
  const denied =
    state.error instanceof ApiError &&
    [401, 403, 404].includes(state.error.status);
  if (denied)
    return (
      <main className="page public-analysis">
        <h2>공개 분석</h2>
        <ErrorState error={state.error!} />
        <p className="public-analysis-back">
          <Link to={returnTo}>돌아가기</Link>
        </p>
      </main>
    );

  const row = state.data as Record<string, unknown> | null;
  const graph = state.data?.graph;
  const error = state.error ?? state.data?.graphError;
  const label = (v: unknown) =>
    typeof v === "string"
      ? (judgmentLabels[v as keyof typeof judgmentLabels] ?? v)
      : "제공되지 않음";

  return (
    <main className="page public-analysis">
      <h2>공개 분석</h2>
      <p className="public-analysis-id">공개 분석 {analysisId}</p>

      <nav aria-label="공개 분석 그래프 자료 판">
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
          <dd>
            {(row.author as { nickname?: string } | undefined)?.nickname ??
              "제공되지 않음"}
          </dd>
          <dt>별</dt>
          <dd>TIC {String(row.ticId)}</dd>
          <dt>제출 시각</dt>
          <dd>{new Date(String(row.submittedAt)).toLocaleString("ko-KR")}</dd>
          <dt>판단</dt>
          <dd>{label(row.judgment)}</dd>
          <dt>근거</dt>
          <dd>
            {Array.isArray(row.evidenceChecks)
              ? row.evidenceChecks
                  .map((v) => EVIDENCE[String(v)] ?? String(v))
                  .join(", ") || "선택한 근거 없음"
              : "제공되지 않음"}
          </dd>
          <dt>메모</dt>
          <dd>{typeof row.memo === "string" ? row.memo : "제공되지 않음"}</dd>
        </dl>
      )}

      {/* 그래프가 없어도 허용된 공개 내용은 위에 남는다(서비스 API 7.2). */}
      {error ? (
        <ErrorState error={error} retry={state.reload} />
      ) : state.loading ? (
        <LoadingState />
      ) : null}

      {graph && <PublicHistoryGraph graph={graph} mode={mode} />}

      <p className="public-analysis-back">
        <Link to={returnTo}>돌아가기</Link>
      </p>
    </main>
  );
}
