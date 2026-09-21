import type { GraphMode } from "./HistoryGraph";

// #190 개인 기록 상세의 대체 사유 배지.
//
// **개인 조회에 오는 값은 두 가지뿐이다.** 백엔드가 `RETIRED_CANDIDATE`는
// 개인·공개 모두에 붙이지만 `RESIDUAL_NOT_AVAILABLE`은 공개 읽기에서만
// 붙인다(`HistoryService.buildGraph`). 그래서 여기서 공개 전용 사유의
// 문구를 지어내지 않는다 — 오지 않는 응답에 맞춘 문구는 확인할 길이 없고
// 서버가 바뀌면 조용히 틀린다.
//
// 대신 **모르는 사유에는 모른다고 말한다.** 사유가 늘었을 때 화면이 아무
// 말도 하지 않는 쪽이 더 나쁘다.

/** 배지 문구. 사유가 없거나 이 모드에서 뜻이 정해지지 않았으면 null이다. */
export function fallbackNotice(
  reason: string | null,
  mode: GraphMode,
  hasSnapshot: boolean,
): string | null {
  if (!reason) return null;
  if (mode === "SUBMITTED") {
    // 탐사 API 8.3: 이 값은 **현재 판에서** 당시 조합을 재현할 수 없다는
    // 참고값이다. 당시 배열이 대체·손상됐다는 뜻이 아니므로 "원본으로
    // 대체됨" 계열로 적지 않는다. 문구가 정해진 사유는 이것 하나뿐이다.
    if (reason !== "RETIRED_CANDIDATE") return null;
    const head = "현재 데이터에서는 당시 잔차 조합을 재현할 수 없습니다.";
    // 배열이 없는데 "당시 그대로"라고 하면 바로 아래 안내와 모순된다.
    return hasSnapshot ? `${head} 아래 배열은 당시 그대로입니다.` : head;
  }
  if (reason === "RETIRED_CANDIDATE")
    return "당시 조합에 은퇴한 후보가 있어 원본 곡선으로 대체했습니다.";
  return "현재 자료의 재현 상태를 확인할 수 없습니다.";
}

export function FallbackNote({
  reason,
  mode,
  hasSnapshot,
}: {
  reason: string | null;
  mode: GraphMode;
  hasSnapshot: boolean;
}) {
  const notice = fallbackNotice(reason, mode, hasSnapshot);
  return notice ? <p className="submission-note">{notice}</p> : null;
}
