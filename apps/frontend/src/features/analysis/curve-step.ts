// 곡선 단계 이동의 순수 부분. 개발 안내 「곡선은 COMPLETED에서만 바꾼다」를 따른다.

import type { CurveContext } from "./analysis-data.ts";

/** 같은 문맥인가. 제거 조합은 정렬된 상태로 들어온다(파서가 맞춘다). */
export function sameContext(a: CurveContext, b: CurveContext): boolean {
  return (
    a.bundleId === b.bundleId &&
    a.residualModelVersion === b.residualModelVersion &&
    a.periodogramConfigVersion === b.periodogramConfigVersion &&
    a.curveStep === b.curveStep &&
    a.removedCandidateIds.length === b.removedCandidateIds.length &&
    a.removedCandidateIds.every((id, i) => id === b.removedCandidateIds[i])
  );
}

/**
 * 원본(단계 0). 제거한 것이 없는 문맥이며 **잔차가 필요 없다**(5.2절:
 * `curveStep=0`이면 `residual`은 `COMPLETED` 고정).
 */
export function originalContext(from: CurveContext): CurveContext {
  return { ...from, curveStep: 0, removedCandidateIds: [] };
}

/** 원본인가. 계산 없이 곧바로 갈 수 있는 유일한 목표다. */
export const isOriginal = (context: CurveContext) => context.curveStep === 0;

/**
 * 갈 수 있는 곳. **다음은 서버가 준 문맥을 그대로 쓴다**(5.1절). 이전은
 * 내가 왔던 길이다. 어떤 후보를 뺄지 우리가 고르지 않는다 — 조합은 어떤
 * 순서든 허용되고(EXP-09) 그 선택은 사용자가 매칭으로 이미 했다.
 */
export type StepMoves = {
  next: CurveContext | null;
  previous: CurveContext | null;
  original: CurveContext | null;
};

export function stepMoves(options: {
  viewing: CurveContext;
  /** 5.1절 `nextCurveContext`. 남은 탐색 가능 신호가 없으면 null이다. */
  next: CurveContext | null;
  /** 이번 세션에서 지나온 문맥. 마지막이 바로 앞이다. */
  visited: CurveContext[];
}): StepMoves {
  const { viewing, next, visited } = options;
  return {
    // 이미 보고 있는 곳은 갈 곳이 아니다.
    next: next && !sameContext(next, viewing) ? next : null,
    previous: visited.length ? visited[visited.length - 1] : null,
    original: isOriginal(viewing) ? null : originalContext(viewing),
  };
}

/**
 * 이 목표로 가려면 계산이 필요한가.
 *
 * 원본은 언제나 필요 없다. 그 밖에는 **캐시 상태를 알 때만** 건너뛴다.
 * 모르면(`null`) 요청한다. 요청은 캐시가 있으면 200으로 곧바로 끝나므로
 * 지레짐작해서 건너뛰는 것보다 싸다.
 */
export function needsResidual(
  target: CurveContext,
  cached: { status: string | null } | null,
): boolean {
  if (isOriginal(target)) return false;
  return cached?.status !== "COMPLETED";
}

/** 화면에 쓰는 단계 이름. 와이어프레임 SC-03이 「곡선 단계 N」으로 쓴다. */
export const stepName = (context: CurveContext) =>
  isOriginal(context) ? "원본 곡선" : `곡선 단계 ${context.curveStep}`;
