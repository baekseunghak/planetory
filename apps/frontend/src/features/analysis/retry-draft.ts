import { readCurveContext, type CurveContext } from "./analysis-data.ts";
import { residualStates } from "./residual-job.ts";

export type RetryDraft = {
  sourceSubmissionId: string;
  retryOfSubmissionId: string;
  bundleId: string;
  isPreviousBundle: boolean;
  curveContext: CurveContext;
  restored: { step: boolean; notice: "STEP_NOT_RESTORABLE" | null };
  draft: {
    periodDays: number | null;
    phaseStart: number | null;
    phaseEnd: number | null;
    viewState: {
      periodogramViewport: { minDays: number; maxDays: number };
      foldedXZoomRatio: number;
    } | null;
    userJudgment: null;
    evidenceChecks: [];
    memo: null;
  };
  residualForStep: { status: string | null; jobId: string | null };
};

export const retryDraftPath = (submissionId: string) =>
  `/v1/submissions/${encodeURIComponent(submissionId)}/retry-draft`;

function invalid(field: string): never {
  throw new Error(`재도전 초안의 ${field} 항목을 확인해 주세요.`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}

/** API 6.8: 서버가 재환산한 구간을 읽는다. 클라이언트에서 다시 환산하지 않는다. */
export function readRetryDraft(
  value: unknown,
  submissionId: string,
): RetryDraft {
  const body = object(value, "응답");
  if (
    !submissionId ||
    body.sourceSubmissionId !== submissionId ||
    body.retryOfSubmissionId !== submissionId
  )
    invalid("제출 ID");
  const curveContext = readCurveContext(body.curveContext);
  if (body.bundleId !== curveContext.bundleId) invalid("Bundle ID");
  if (typeof body.isPreviousBundle !== "boolean") invalid("이전 판 여부");
  const restored = object(body.restored, "복원 상태");
  if (
    typeof restored.step !== "boolean" ||
    restored.notice !== (restored.step ? null : "STEP_NOT_RESTORABLE")
  )
    invalid("복원 안내");
  const draft = object(body.draft, "선택값");
  const periodDays =
    draft.periodDays === null ? null : finite(draft.periodDays, "주기");
  if (periodDays !== null && periodDays <= 0) invalid("주기");
  const phaseStart =
    draft.phaseStart === null ? null : finite(draft.phaseStart, "시작 위상");
  const phaseEnd =
    draft.phaseEnd === null ? null : finite(draft.phaseEnd, "끝 위상");
  if (
    (phaseStart === null) !== (phaseEnd === null) ||
    (periodDays === null && phaseStart !== null)
  )
    invalid("위상 구간");
  if (
    phaseStart !== null &&
    phaseEnd !== null &&
    !(
      phaseStart >= 0 &&
      phaseStart < 1 &&
      phaseEnd > phaseStart &&
      phaseEnd < phaseStart + 1
    )
  )
    invalid("위상 구간");
  // 새 판단을 요구하는 계약이 깨졌을 때 옛 답을 조용히 복제하지 않는다.
  if (
    draft.userJudgment !== null ||
    draft.memo !== null ||
    !Array.isArray(draft.evidenceChecks) ||
    draft.evidenceChecks.length !== 0
  )
    invalid("판단 초기화");
  let viewState: RetryDraft["draft"]["viewState"] = null;
  if (draft.viewState !== null) {
    const view = object(draft.viewState, "표시 범위");
    const viewport = object(view.periodogramViewport, "주기도 범위");
    const minDays = finite(viewport.minDays, "최소 주기");
    const maxDays = finite(viewport.maxDays, "최대 주기");
    const zoom = finite(view.foldedXZoomRatio, "접기 배율");
    if (
      !(minDays > 0 && maxDays > minDays) ||
      ![1, 2, 4, 8, 16, 32].includes(zoom)
    )
      invalid("표시 범위");
    viewState = {
      periodogramViewport: { minDays, maxDays },
      foldedXZoomRatio: zoom,
    };
  }
  const residual = object(body.residualForStep, "잔차 상태");
  if (
    residual.status !== null &&
    !residualStates.some((status) => status === residual.status)
  )
    invalid("잔차 상태");
  if (
    residual.jobId !== null &&
    (typeof residual.jobId !== "string" || !residual.jobId.trim())
  )
    invalid("잔차 작업 ID");
  if (
    residual.status !== null &&
    residual.status !== "COMPLETED" &&
    residual.status !== "FAILED" &&
    !residual.jobId
  )
    invalid("진행 중 작업 ID");
  if (residual.status === null && residual.jobId !== null)
    invalid("잔차 작업 ID");
  if (
    curveContext.curveStep === 0 &&
    (residual.status !== "COMPLETED" || residual.jobId !== null)
  )
    invalid("원본 잔차 상태");
  return {
    sourceSubmissionId: submissionId,
    retryOfSubmissionId: submissionId,
    bundleId: curveContext.bundleId,
    isPreviousBundle: body.isPreviousBundle,
    curveContext,
    restored: {
      step: restored.step,
      notice: restored.notice as RetryDraft["restored"]["notice"],
    },
    draft: {
      periodDays,
      phaseStart,
      phaseEnd,
      viewState,
      userJudgment: null,
      evidenceChecks: [],
      memo: null,
    },
    residualForStep: {
      status: residual.status as string | null,
      jobId: residual.jobId as string | null,
    },
  };
}
