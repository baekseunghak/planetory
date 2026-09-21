import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { endpoint } from "../community/contracts";
import { invalidMaterial } from "../community/materialContracts";
import {
  SharedHistoryGraph,
  readHistoryGraph,
  type GraphMode,
  type HistoryGraphDto,
} from "./HistoryGraph";
export { fallbackMessage } from "./public-graph-text.ts";
import { fallbackMessage } from "./public-graph-text.ts";

// #191 공개 부모 경로의 그래프 소비 경계.
//
// 소비자가 둘이다 — 글·댓글 첨부(`S15P21C206-213`)와 공개 분석 상세. 둘은
// **같은 서버 함수**(`publicContent`·`publicGraph`)의 응답을 받으므로 그래프를
// 읽고 보여 주는 규칙이 같아야 한다. `app/paths.ts`가 첨부 경로의 소유를
// 「하서진 · 그래프는 백지웅」으로 나눠 둔 그 경계가 여기다.
//
// **행 검증은 각자 한다.** 첨부는 `parentType`·`parentId`를, 공개 분석은
// `analysisId`·`threadId`를 대조한다. 모양이 다른 것을 억지로 합치지 않는다.

/**
 * 공개 부모 경로에서 그래프를 포함해 읽는다.
 *
 * 그래프가 503이면 **같은 경로에 `includeGraph=false`로 다시 요청한다**
 * (서비스 API 7.2). 저장된 이전 응답으로 메우지 않는다 — 현재 권한을 다시
 * 검사한 내용이어야 한다. 그래서 그래프를 잃어도 판단·근거·메모는 남는다.
 */
export async function fetchPublicGraph(
  path: string,
  mode: GraphMode,
  signal: AbortSignal,
): Promise<{ raw: unknown; graphError: ApiError | null }> {
  try {
    return {
      raw: await api(endpoint(path, { graphMode: mode }), { signal }),
      graphError: null,
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
    const raw = await api(
      endpoint(path, { graphMode: mode, includeGraph: "false" }),
      { signal },
    );
    return { raw, graphError: error };
  }
}

/**
 * 공개 응답의 그래프를 읽는다. 8.3·8.5 계약 검사는 공용 파서가 하고
 * 여기서는 **공개에만 있는 금지 하나**를 더 본다.
 *
 * 서비스 API 7.2: 「타인 공개 조회는 개인 jobId를 반환하거나 개인 작업 API를
 * 폴링하지 않는다.」 서버는 `publicRead`면 `jobId`를 비운다. 그래도 실려 오면
 * 계약 위반이므로 **받아 두지 않는다** — 화면에 남기면 그 값으로 개인 작업을
 * 물어보는 길이 열린다. 도달하지 않는 것과 막혀 있는 것은 다르다.
 */
export function readPublicGraph(
  value: unknown,
  historyId: string,
  ticId: string,
  mode: GraphMode,
): HistoryGraphDto {
  const graph = readHistoryGraph(value, historyId, ticId, mode);
  if (graph.curve?.residual?.jobId != null) return invalidMaterial();
  return graph;
}

/**
 * 당시 배열이 없는 것을 **한 번이라도 보면** 그 토글을 잠근다 — 현재 자료를
 * 당시 자료로 대신 보여 주지 않기 위해서다(8.3절). 모드는 조회 전에 정해지고
 * 이 관찰은 조회 뒤에 오므로 상태를 따로 둔다.
 */
export function useSnapshotMissing(
  mode: GraphMode,
  graph: HistoryGraphDto | null | undefined,
) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (mode === "SUBMITTED" && graph && graph.snapshot === null)
      setMissing(true);
  }, [graph, mode]);
  return missing;
}

/** 공개 그래프 한 덩어리. 제공 가능한 것을 보여 주고 **없음의 이유를 가른다.** */
export function PublicHistoryGraph({
  graph,
  mode,
}: {
  graph: HistoryGraphDto;
  mode: GraphMode;
}) {
  const fallback = fallbackMessage(graph, mode);
  return (
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
            제출 당시 스냅샷이 없습니다. 현재 자료를 당시 자료로 대신 표시하지
            않습니다.
          </p>
        )
      ) : graph.curve?.segments?.length ? (
        <>
          {/* 원본을 잔차로 표시하지 않는다. */}
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
  );
}
