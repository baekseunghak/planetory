/**
 * 성과 연출을 **한 번만** 보여 주기 위한 표시 이력.
 *
 * 2.2절: 「연출은 HTTP 상태가 아니라 회원·`submissionId`별 표시 이력으로
 * 중복을 억제한다. 최초 201이 유실된 뒤 200으로 처음 복구한 결과도 표시할
 * 수 있어야 한다.」
 *
 * 201만 연출하면 응답을 잃고 200으로 처음 복구한 사용자는 성과를 한 번도
 * 보지 못한다. 그 사람에게는 그 200이 **처음 보는 결과**다. 그래서 가르는
 * 기준은 응답의 종류가 아니라 이 회원이 이 제출을 본 적이 있는가다.
 *
 * 서버가 이 이력을 주지 않으므로 브라우저에 둔다. 기기를 바꾸면 한 번 더
 * 보이는데, 연출이 한 번 더 나오는 것은 한 번도 못 보는 것보다 훨씬 싸다.
 */
import { createContext } from "react";

const KEY = "planetory:analysis-celebrated";

const read = (): Record<string, string[]> => {
  try {
    const raw = localStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, string[]>;
  } catch {
    // 저장소를 쓸 수 없으면 이력이 없는 것으로 본다. 연출이 다시 나올 뿐이다.
    return {};
  }
};

/**
 * 「축하합니다!」를 붙일 성과인가. **실제로 인정된 것(`recognized`)뿐이다.**
 * 판단 불일치·공개 대기·이미 인정됨·성과 없음(미매칭)·알 수 없는 값에는
 * 붙이지 않는다. 처음 보는지(`hasCelebrated`)와는 따로 보며 둘 다 맞아야
 * 축하한다. 성과 사실 문구는 이와 관계없이 그대로 보인다.
 */
export function earnsCelebration(result: string | null | undefined): boolean {
  return result === "recognized";
}

/**
 * 결과 설명의 축하 문구. 이 회원이 이 제출을 처음 보고(`firstView`) 성과가
 * 실제로 인정됐을 때만 있다. 기존형·새 분석이 같은 결과 설명을 쓴다.
 */
export function celebrationText(
  firstView: boolean,
  result: string | null | undefined,
): string | null {
  return firstView && earnsCelebration(result) ? "축하합니다!" : null;
}

/**
 * develop 화면(운영 기본)의 지금 규칙: 처음 보는 결과면 성과와 관계없이
 * 축하한다(판단 불일치·공개 대기에도). 운영 기본 화면을 바꾸지 않으려고
 * 그대로 둔다.
 */
export function developCelebrationText(firstView: boolean): string | null {
  return firstView ? "축하합니다!" : null;
}

/**
 * `celebrationText`(인정된 성과에만 축하)를 쓰는 화면인가. 시네마 셸이 true로
 * 둔다. 제공자가 없는 develop 화면은 `developCelebrationText`를 쓴다.
 * develop 화면에도 이 규칙을 들일 때 이 문맥을 없앤다.
 */
export const StrictCelebration = createContext(false);

/** 이 회원이 이 제출의 성과를 본 적이 있는가. */
export function hasCelebrated(memberId: string, submissionId: string): boolean {
  const seen = read()[memberId];
  return Array.isArray(seen) && seen.includes(submissionId);
}

/**
 * 봤다고 적는다. 같은 제출을 두 번 적지 않으며, 회원별로 최근 것만 남긴다.
 * 이력이 무한히 자라면 저장소가 찬다.
 */
const LIMIT = 200;
export function markCelebrated(memberId: string, submissionId: string): void {
  const all = read();
  const seen = Array.isArray(all[memberId]) ? all[memberId] : [];
  if (seen.includes(submissionId)) return;
  all[memberId] = [...seen, submissionId].slice(-LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 적지 못하면 다음에 한 번 더 보인다. 잃는 것은 그뿐이다. */
  }
}
