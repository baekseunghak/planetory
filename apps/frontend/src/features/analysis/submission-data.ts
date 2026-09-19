import { ApiError, type FieldError } from "../../api/client.ts";
import { readCurveContext, type CurveContext } from "./analysis-data.ts";

// 탐사 API 6.4절 `submissionResult` 중 #187이 쓰는 부분만 읽는다.
// `signal`·`achievement`·`judgmentStatistics`는 결과 해설(A06-2)의 몫이고
// 후보 정답을 담으므로 이 티켓의 상태로 복사하지 않는다.

export const submissionsPath = (ticId: string) =>
  `/v1/stars/${encodeURIComponent(ticId)}/submissions`;
export const byRequestPath = (requestId: string) =>
  `/v1/submissions/by-request/${encodeURIComponent(requestId)}`;

export const submissionKinds = [
  "candidate",
  "no_candidate",
  "skipped",
] as const;
export type SubmissionKind = (typeof submissionKinds)[number];
// ERD submissions.match_result CHECK 그대로.
export const matchStatuses = [
  "matched",
  "matched_harmonic",
  "not_matched",
  "duplicate",
  "ambiguous_match",
  "none_wrong",
  "skipped",
] as const;
export type MatchStatus = (typeof matchStatuses)[number];
// ERD user_star_progress CHECK 그대로.
const progressStages = ["unexplored", "in_progress", "completed"] as const;
const completionReasons = [
  "all_found",
  "undiscoverable_only",
  "skipped",
] as const;
// 6.4절 서버 힌트. 실행 시 서버가 다시 검증한다.
const knownActions = [
  "NEXT_CURVE",
  "VIEW_DETAIL",
  "RETRY",
  "PUBLISH_ANALYSIS",
  "LATER",
  "VIEW_RESULT",
  "GO_HOME",
  "DISCUSS",
  "SKIP_TUTORIAL",
] as const;
export type NextAction = (typeof knownActions)[number];

/**
 * 종류별로 허용되는 `match.status`. 특수 제출에 후보 매칭 결과가 실려 오면
 * 접수 결과를 잘못 읽은 것이므로 거절한다.
 */
const allowedMatch: Record<SubmissionKind, readonly MatchStatus[]> = {
  candidate: [
    "matched",
    "matched_harmonic",
    "not_matched",
    "duplicate",
    "ambiguous_match",
  ],
  no_candidate: ["none_wrong"],
  skipped: ["skipped"],
};

export type SubmissionProgress = {
  stage: (typeof progressStages)[number];
  completionReason: (typeof completionReasons)[number] | null;
  reopenPending: boolean;
  currentCurveStep: number;
  remainingDiscoverableCount: number;
};
export type SubmissionReceipt = {
  /**
   * 201 새 접수인지 200 재현인지. **본문이 아니라 HTTP 상태에서 온다.**
   * 재현 본문은 접수 당시 값을 그대로 담으므로 본문만 보고는 구분할 수 없다.
   * 축하·집계처럼 한 번만 일어나야 하는 처리는 `created`에서만 한다.
   */
  outcome: "created" | "replayed";
  submissionId: string;
  historyId: string;
  requestId: string;
  ticId: string;
  bundleId: string;
  /** UTC 활동 시각. BTJD 과학 시각과 섞지 않는다. */
  submittedAt: string;
  submissionKind: SubmissionKind;
  curveContext: CurveContext;
  matchStatus: MatchStatus;
  progress: SubmissionProgress;
  /** 처리 후 지도 판. 마지막 값과 다르면 지도를 다시 조회한다(4.1절). */
  skyVersion: string;
  nextActions: NextAction[];
};

function invalid(field: string): never {
  throw new Error(`제출 응답의 ${field} 항목을 확인해 주세요.`);
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
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field);
  return value as number;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.some((item) => item === value)) invalid(field);
  return value as T;
}
// 활동 시각은 UTC 순간으로만 받는다. 시간대 없는 문자열은 거절한다.
function instant(value: unknown, field: string): string {
  const raw = text(value, field);
  if (!/Z$/.test(raw) || Number.isNaN(Date.parse(raw))) invalid(field);
  return raw;
}

function readProgress(value: unknown): SubmissionProgress {
  const data = record(value, "progress");
  const stage = oneOf(data.stage, progressStages, "progress.stage");
  const reason =
    data.completionReason === null
      ? null
      : oneOf(
          data.completionReason,
          completionReasons,
          "progress.completionReason",
        );
  // 완료 사유는 완료한 별에만 있다(4.3절과 같은 규칙).
  if ((stage === "completed") !== (reason !== null))
    invalid("progress.stage/completionReason");
  return {
    stage,
    completionReason: reason,
    reopenPending: flag(data.reopenPending, "progress.reopenPending"),
    currentCurveStep: integer(
      data.currentCurveStep,
      "progress.currentCurveStep",
    ),
    remainingDiscoverableCount: integer(
      data.remainingDiscoverableCount,
      "progress.remainingDiscoverableCount",
    ),
  };
}

/**
 * @param expected 보낸 요청의 별과 요청 ID. by-request 복구에서 **다른 요청의
 * 결과를 내 제출로 착각하지 않도록** 둘 다 대조한다.
 */
export function decodeSubmissionReceipt(
  value: unknown,
  expected: { ticId: string; requestId: string },
  status: number,
): SubmissionReceipt {
  const data = record(value, "submissionResult");
  if (text(data.ticId, "ticId") !== expected.ticId) invalid("ticId");
  if (text(data.requestId, "requestId") !== expected.requestId)
    invalid("requestId");

  const submissionKind = oneOf(
    data.submissionKind,
    submissionKinds,
    "submissionKind",
  );
  const matchStatus = oneOf(
    record(data.match, "match").status,
    allowedMatch[submissionKind],
    "match.status",
  );
  const curveContext = readCurveContext(data.curveContext);
  if (text(data.bundleId, "bundleId") !== curveContext.bundleId)
    invalid("bundleId/curveContext");

  const progress = readProgress(data.progress);
  // 제출한 단계와 진행 단계는 같아야 한다(6.3절 8번).
  if (progress.currentCurveStep !== curveContext.curveStep)
    invalid("progress.currentCurveStep");

  if (!Array.isArray(data.nextActions)) invalid("nextActions");
  const offered = data.nextActions;

  return {
    // 201/200 말고 다른 성공 코드는 계약에 없다.
    outcome:
      status === 201
        ? "created"
        : status === 200
          ? "replayed"
          : invalid("status"),
    submissionId: text(data.submissionId, "submissionId"),
    historyId: text(data.historyId, "historyId"),
    requestId: expected.requestId,
    ticId: expected.ticId,
    bundleId: curveContext.bundleId,
    submittedAt: instant(data.submittedAt, "submittedAt"),
    submissionKind,
    curveContext,
    matchStatus,
    progress,
    skyVersion: text(data.skyVersion, "skyVersion"),
    // 모르는 힌트 때문에 접수된 제출을 실패로 만들지 않는다. 버튼 하나가
    // 줄어들 뿐이고, 되살릴 수 없는 접수 결과를 잃는 쪽이 훨씬 비싸다.
    nextActions: knownActions.filter((action) => offered.includes(action)),
  };
}

/**
 * 실패의 종류와 **요청 ID를 어떻게 할지**. 개발 안내 「응답과 처리」 표의
 * 마지막 열을 코드로 옮긴 것이며, 두 곳이 어긋나지 않도록 여기 한 곳에서 정한다.
 *
 * - `keep` 같은 ID로 다시 보낸다. 서버가 저장했는지 아직 모르거나, 본문이
 *   그대로라 새 ID를 만들면 중복 접수가 된다.
 * - `renew` 본문을 새로 만들어야 하므로 새 ID가 필요하다.
 * - `discard` 이 별에 이 제출을 보낼 수 없다. 재시도 대상이 아니다.
 */
export type SubmissionFailure = { requestId: "keep" | "renew" | "discard" } & (
  | {
      /** 접수 여부를 모른다. by-request로 확인한 뒤 같은 ID로 재전송한다. */
      kind: "unknown-outcome";
      code: string;
      message: string;
    }
  | { kind: "in-progress" }
  | { kind: "conflict-body" }
  /**
   * 2.3절이 정한 대로 **본문의** `currentBundleId`를 읽는다. `X-Current-Bundle`
   * 헤더는 5.2·5.3 응답부터 붙었고 나머지 API는 각 구현 때 붙이므로(D-5) 제출
   * 응답에 없을 수 있다. 본문에도 없으면 null이며, 그때는 분석 진입을 다시
   * 조회해 현재 판을 확인한다.
   */
  | { kind: "bundle-changed"; currentBundleId: string | null }
  | { kind: "expired" }
  | {
      /** 입력이 거절됐다. 접수는 일어나지 않았다. */
      kind: "rejected";
      code: string;
      message: string;
      fieldErrors: FieldError[];
    }
  | {
      /**
       * 이 단계의 **잔차가 아직 준비되지 않아** 접수되지 않았다. 잔차를
       * 준비한 뒤 **같은 요청 ID로 재전송**한다. 서버는 접수를 예약하지도,
       * 배경에서 대신 제출하지도 않는다.
       *
       * 계약은 `S15P21C206-143` 브랜치의 명세 오류표와 제출 구현 계약에만
       * 있고 아직 develop에 없다. 그래서 `residual.status`를 닫힌 열거형으로
       * 보지 않고 받은 문자열을 그대로 들고 간다. 모르는 값 하나 때문에
       * 복구 경로를 끊는 쪽이 훨씬 비싸다.
       */
      kind: "context-not-ready";
      code: string;
      message: string;
      residual: ResidualState | null;
    }
  | { kind: "denied"; code: string; message: string }
);

/** 잔차 준비 상태. `status`가 null이면 결과도 작업도 없는 미계산이다. */
export type ResidualState = {
  status: string | null;
  jobId: string | null;
  computedAt: string | null;
};

function readResidual(value: unknown): ResidualState | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const str = (item: unknown) => (typeof item === "string" ? item : null);
  return {
    status: str(row.status),
    jobId: str(row.jobId),
    computedAt: str(row.computedAt),
  };
}

export function classifySubmissionError(error: unknown): SubmissionFailure {
  if (!(error instanceof ApiError))
    throw error instanceof Error ? error : new Error(String(error));
  // 전송 뒤 결과를 확인하지 못한 경우. 공용 클라이언트가 켜 주는 유일한 신호다.
  if (error.outcomeUnknown)
    return {
      kind: "unknown-outcome",
      requestId: "keep",
      code: error.code,
      message: error.message,
    };
  if (error.status === 401) return { kind: "expired", requestId: "keep" };
  if (error.status === 409) {
    if (error.code === "REQUEST_IN_PROGRESS")
      return { kind: "in-progress", requestId: "keep" };
    if (error.code === "IDEMPOTENCY_CONFLICT")
      return { kind: "conflict-body", requestId: "renew" };
    if (error.code === "BUNDLE_CHANGED")
      return {
        kind: "bundle-changed",
        requestId: "renew",
        currentBundleId:
          typeof error.details.currentBundleId === "string"
            ? error.details.currentBundleId
            : null,
      };
    // 미접수다. 잔차를 준비한 뒤 **같은 ID로** 다시 보내야 하므로 버리지 않는다.
    if (error.code === "SUBMISSION_CONTEXT_NOT_READY")
      return {
        kind: "context-not-ready",
        requestId: "keep",
        code: error.code,
        message: error.message,
        residual: readResidual(error.details.residual),
      };
    // STAR_ALREADY_COMPLETED·SKIP_NOT_AVAILABLE. 조건이 아니므로 다시 보내지 않는다.
    return {
      kind: "denied",
      requestId: "discard",
      code: error.code,
      message: error.message,
    };
  }
  if (error.status === 403 || error.status === 404)
    return {
      kind: "denied",
      requestId: "discard",
      code: error.code,
      message: error.message,
    };
  if (error.status === 400)
    return {
      kind: "rejected",
      requestId: "keep",
      code: error.code,
      message: error.message,
      fieldErrors: error.fieldErrors,
    };
  // 남은 4xx는 접수되지 않은 거절로 본다. 5xx·타임아웃은 위에서 결과 불명이다.
  return {
    kind: "rejected",
    requestId: "keep",
    code: error.code,
    message: error.message,
    fieldErrors: error.fieldErrors,
  };
}
