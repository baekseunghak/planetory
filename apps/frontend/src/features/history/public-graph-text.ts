import type { GraphMode, HistoryGraphDto } from "./HistoryGraph";

// #191 공개 소비 경계의 문구. **HTTP 클라이언트를 끌어오지 않는다** — 소비자가
// 둘이라 문구가 한곳에서 나와야 하고, 단위 검사로 고정할 수 있어야 한다.

/** 원본 대체 사유. **같은 값이 모드마다 다른 뜻이다.** */
export function fallbackMessage(graph: HistoryGraphDto, mode: GraphMode) {
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
