// #196 마이페이지 두 목록. 탐사 API 4.4(내 별)·8.1(내 기록)을 읽는다.
// **커서는 조건에 묶여 있고 `size`까지 포함한다** — 왜 그런지와 함정은
// docs/analysis-my-lists.md.

function invalid(field: string): never {
  throw new Error(`목록 응답의 ${field} 항목을 확인해 주세요.`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field);
  return value;
}
function maybeText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : text(value, field);
}
function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    invalid(field);
  return value as number;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

/** 목록 한 쪽. `nextCursor`가 없으면 끝이다. */
export type Page<T> = { items: T[]; nextCursor: string | null };

function readPage<T>(
  value: unknown,
  field: string,
  item: (row: Record<string, unknown>) => T,
): Page<T> {
  const body = record(value, field);
  const items = array(body.items, `${field}.items`).map((row) =>
    item(record(row, `${field}.items[]`)),
  );
  const nextCursor = maybeText(body.nextCursor, `${field}.nextCursor`);
  // `hasNext`도 오지만 서버가 「둘 중 편한 쪽을 쓰라」고 한 같은 뜻이다.
  // 하나만 믿는다 — 둘을 함께 보면 어긋났을 때 무엇을 따를지 정해야 한다.
  return { items, nextCursor };
}

// ---------------------------------------------------------------- 내 별 4.4

export type MyStar = {
  ticId: string;
  progressStage: string;
  planetCount: number;
  completedWithoutPlanets: boolean;
  achievementCount: number;
  grade: string | null;
  /** 현재 잔차 단계. 없을 수 있다. */
  currentCurveStep: number | null;
  reopenPending: boolean;
  reopened: boolean;
  /**
   * 공개하지 않은 고유 신호 수. **`null`은 0이 아니라 「모름」이다.**
   * 타인 조회에서는 서버가 이 필드를 통째로 뺀다(NFR-14). 「공개하지 않은
   * 신호가 없다」와 「볼 수 없다」는 다른 뜻이므로 0으로 채우지 않는다.
   */
  unpublishedSignalCount: number | null;
  lastActivityAt: string;
  unlockReason: string | null;
};

export function readMyStars(value: unknown): Page<MyStar> {
  return readPage(value, "내 별 목록", (row) => ({
    ticId: text(row.ticId, "ticId"),
    progressStage: text(row.progressStage, "progressStage"),
    planetCount: integer(row.planetCount, "planetCount"),
    completedWithoutPlanets: flag(
      row.completedWithoutPlanets,
      "completedWithoutPlanets",
    ),
    achievementCount: integer(row.achievementCount, "achievementCount"),
    grade: maybeText(row.grade, "grade"),
    currentCurveStep:
      row.currentCurveStep === null || row.currentCurveStep === undefined
        ? null
        : integer(row.currentCurveStep, "currentCurveStep"),
    reopenPending: flag(row.reopenPending, "reopenPending"),
    reopened: flag(row.reopened, "reopened"),
    // 키가 아예 없는 것과 0이 온 것을 가른다. `?? null`로 뭉치면 둘이 같아진다.
    unpublishedSignalCount: Object.hasOwn(row, "unpublishedSignalCount")
      ? integer(row.unpublishedSignalCount, "unpublishedSignalCount")
      : null,
    lastActivityAt: text(row.lastActivityAt, "lastActivityAt"),
    unlockReason: maybeText(row.unlockReason, "unlockReason"),
  }));
}

// ------------------------------------------------------------- 내 기록 8.1

export type MyHistory = {
  historyId: string;
  submissionId: string;
  ticId: string;
  candidateId: string | null;
  submissionKind: string;
  matchResult: string | null;
  userJudgment: string | null;
  achievementResult: string | null;
  submittedAt: string;
  bundleId: string | null;
  isPreviousBundle: boolean;
  curveStep: number;
  publication: {
    publicAnalysisId: string | null;
    isPublic: boolean;
    isModerationHidden: boolean;
  };
  achievementGranted: boolean;
  snapshotAvailable: boolean;
  /**
   * 최초 응답이 저장돼 있는가. **거짓이면 상세로 보내지 않는다**(8.1절).
   * `snapshotAvailable`과 독립이다 — 하나가 거짓이라고 다른 하나를 끄지 않는다.
   */
  detailAvailable: boolean;
  answerViewed: boolean;
  retryOfSubmissionId: string | null;
};

export function readMyHistories(value: unknown): Page<MyHistory> {
  return readPage(value, "내 기록 목록", (row) => ({
    historyId: text(row.historyId, "historyId"),
    submissionId: text(row.submissionId, "submissionId"),
    ticId: text(row.ticId, "ticId"),
    // 미매칭 기록의 후보는 없을 수 있다(서비스 API 7.1).
    candidateId: maybeText(row.candidateId, "candidateId"),
    submissionKind: text(row.submissionKind, "submissionKind"),
    matchResult: maybeText(row.matchResult, "matchResult"),
    userJudgment: maybeText(row.userJudgment, "userJudgment"),
    achievementResult: maybeText(row.achievementResult, "achievementResult"),
    submittedAt: text(row.submittedAt, "submittedAt"),
    bundleId: maybeText(row.bundleId, "bundleId"),
    isPreviousBundle: flag(row.isPreviousBundle, "isPreviousBundle"),
    curveStep: integer(row.curveStep, "curveStep"),
    publication: readPublication(row.publication),
    achievementGranted: flag(row.achievementGranted, "achievementGranted"),
    snapshotAvailable: flag(row.snapshotAvailable, "snapshotAvailable"),
    detailAvailable: flag(row.detailAvailable, "detailAvailable"),
    answerViewed: flag(row.answerViewed, "answerViewed"),
    retryOfSubmissionId: maybeText(
      row.retryOfSubmissionId,
      "retryOfSubmissionId",
    ),
  }));
}

function readPublication(value: unknown): MyHistory["publication"] {
  const row = record(value, "publication");
  return {
    publicAnalysisId: maybeText(
      row.publicAnalysisId,
      "publication.publicAnalysisId",
    ),
    isPublic: flag(row.isPublic, "publication.isPublic"),
    isModerationHidden: flag(
      row.isModerationHidden,
      "publication.isModerationHidden",
    ),
  };
}

// ------------------------------------------------------------------- 요청

/** 기록 목록의 필터. 빈 값은 보내지 않는다 — 서버는 빈 문자열을 미지정으로 읽는다. */
export type HistoryFilter = { result?: string; ticId?: string };

/**
 * **커서는 조건에 묶여 있다.** 회원·`ticId`·`candidateId`·`result`·`from`
 * ·`to`·`size`가 하나라도 다르면 서버가 400으로 거절한다(`HistoryQuery`).
 * 그래서 조건이 바뀌면 커서를 **버리고** 처음부터 읽는다.
 */
export function myHistoriesPath(filter: HistoryFilter, cursor: string | null) {
  const query = new URLSearchParams();
  if (filter.result) query.set("result", filter.result);
  if (filter.ticId) query.set("ticId", filter.ticId);
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return `/v1/me/histories${text ? `?${text}` : ""}`;
}

/**
 * 별 목록. **본인과 타인이 다른 경로다** — 프로필 슬롯이 타인에게도 이 자리를
 * 보여 주므로(비공개면 W16이 먼저 막는다) 둘 다 필요하다.
 *
 * 서버는 `scope`·`sort`·`size`·`cursor`만 받는다. 명세 4.4의 `stage`
 * ·`grade`·`ticId`는 P1이며 구현돼 있지 않다. 기본값(`submitted`·`recent`)을
 * 쓰므로 굳이 싣지 않는다 — `size`도 커서 묶음에 들어가니 한쪽에서만 정한다.
 *
 * 타인에게 `scope=discovered`를 쓰면 서버가 400으로 거절한다. 미제출 발견까지
 * 보이면 그 회원의 진행 상태가 드러나기 때문이다(4.4). 여기서는 보내지 않는다.
 */
export function starsPath(memberId: string | null, cursor: string | null) {
  const base = memberId
    ? `/v1/members/${encodeURIComponent(memberId)}/stars`
    : "/v1/me/stars";
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}
