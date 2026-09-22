import { ApiError, type createApiClient } from "../../api/client";
import {
  contextKey,
  curvePath,
  decodeAnalysisContext,
  decodeCurve,
  type CurveContext,
} from "./analysis-data";
import { readRetryDraft, retryDraftPath, type RetryDraft } from "./retry-draft";
import { runResidualJob } from "./residual-job";

export type AnalysisEntry = {
  retryOfSubmissionId?: string;
  resume?: boolean;
  autoRestore?: boolean;
  retryAttemptId?: string;
  savedContext?: CurveContext;
};

type Request = ReturnType<typeof createApiClient>["request"];
class BundleChanged extends Error {}
export class RetryPreparationError extends Error {
  readonly retryAt: number;
  constructor(
    message: string,
    readonly retryable: boolean,
    retryAfterSeconds = 0,
  ) {
    super(message);
    this.retryAt = Date.now() + Math.max(0, retryAfterSeconds) * 1000;
  }
}

// Read one consistent pair. A second race is left to manual retry.
export async function loadAnalysis(
  request: Request,
  ticId: string,
  signal: AbortSignal,
  onBundleChanged: () => void,
  previousBundleId?: string,
  claimBundleRecovery?: () => boolean,
  entry?: AnalysisEntry,
) {
  let changed = false;
  const announce = () => {
    if (!changed) onBundleChanged();
    changed = true;
  };
  async function read(path: string, expectedBundleId?: string) {
    let bundleId: string | null = null;
    let status = 0;
    let body: unknown;
    try {
      body = await request<unknown>(path, {
        signal,
        onResponse: (response) => {
          bundleId = response.headers.get("X-Current-Bundle")?.trim() || null;
          status = response.status;
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      // Access and service failures retain their original meaning.
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "BUNDLE_CHANGED"
      )
        throw new BundleChanged();
      if (
        status >= 200 &&
        status < 300 &&
        expectedBundleId &&
        bundleId &&
        bundleId !== expectedBundleId
      )
        throw new BundleChanged();
      throw error;
    }
    signal.throwIfAborted();
    if (expectedBundleId && bundleId && bundleId !== expectedBundleId)
      throw new BundleChanged();
    return { body, bundleId, status };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await read(
        `/v1/stars/${encodeURIComponent(ticId)}/analysis-context`,
      );
      let context = decodeAnalysisContext(response.body, ticId);
      if (
        response.bundleId &&
        response.bundleId !== context.curveContext.bundleId
      )
        throw new BundleChanged();
      if (
        previousBundleId &&
        previousBundleId !== context.curveContext.bundleId
      )
        announce();
      let retryDraft: RetryDraft | null = null;
      if (entry?.retryOfSubmissionId) {
        const id = entry.retryOfSubmissionId;
        // 6.8 has no TIC. Verify ownership and route identity through 6.6 first.
        const owned = await read(`/v1/submissions/${encodeURIComponent(id)}`);
        const receipt = owned.body as {
          submissionId?: unknown;
          ticId?: unknown;
        } | null;
        if (!receipt || receipt.submissionId !== id || receipt.ticId !== ticId)
          throw new Error("재도전할 제출과 현재 항성이 일치하지 않습니다.");
        const draftResponse = await read(
          retryDraftPath(id),
          context.curveContext.bundleId,
        );
        retryDraft = readRetryDraft(draftResponse.body, id);
        if (retryDraft.bundleId !== context.curveContext.bundleId)
          throw new BundleChanged();
        context = {
          ...context,
          curveContext: retryDraft.curveContext,
          currentResidual: { ...retryDraft.residualForStep, computedAt: null },
          notice: retryDraft.restored.notice ?? undefined,
        };
      }
      if (
        entry?.resume &&
        entry.savedContext &&
        entry.savedContext.bundleId === context.curveContext.bundleId &&
        entry.savedContext.residualModelVersion ===
          context.curveContext.residualModelVersion &&
        entry.savedContext.periodogramConfigVersion ===
          context.curveContext.periodogramConfigVersion &&
        entry.savedContext.removedCandidateIds.every((id) =>
          context.matchedCandidateIds.includes(id),
        )
      ) {
        context = { ...context, curveContext: entry.savedContext };
      }
      let result = await read(
        curvePath(context),
        context.curveContext.bundleId,
      );
      let curve = decodeCurve(result.body, context, result.status);
      if (
        entry &&
        curve.kind === "not-ready" &&
        context.curveContext.curveStep > 0
      ) {
        const outcome = await runResidualJob({
          request,
          ticId,
          target: context.curveContext,
          signal,
          entryBundleId: context.curveContext.bundleId,
        });
        if (outcome.state === "bundle-changed") throw new BundleChanged();
        if (outcome.state === "queue-full")
          throw new RetryPreparationError(
            outcome.activeJobId
              ? "이미 진행 중인 계산이 있어 기다려야 합니다."
              : "계산 대기열이 가득 찼습니다.",
            true,
            outcome.retryAfterSeconds,
          );
        if (outcome.state === "failed")
          throw new RetryPreparationError(outcome.message, outcome.retryable);
        if (outcome.state !== "ready")
          throw new Error(
            "잔차 계산을 시작하지 못했습니다. 잠시 후 다시 불러와 주세요.",
          );
        if (
          contextKey(outcome.curveContext) !== contextKey(context.curveContext)
        )
          throw new Error(
            "재도전 곡선과 계산 결과의 문맥이 일치하지 않습니다.",
          );
        result = await read(curvePath(context), context.curveContext.bundleId);
        curve = decodeCurve(result.body, context, result.status);
      }
      if (entry && curve.kind === "ready")
        context = {
          ...context,
          currentResidual: { ...context.currentResidual, status: "COMPLETED" },
        };
      signal.throwIfAborted();
      return { context, curve, retryDraft, bundleChanged: changed };
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof BundleChanged)) throw error;
      announce();
      if (attempt === 1 || (claimBundleRecovery && !claimBundleRecovery()))
        throw new Error(
          "데이터 판이 계속 바뀌어 불러오지 못했습니다. 잠시 후 다시 불러와 주세요.",
        );
    }
  }
  throw new Error("분석 자료를 불러오지 못했습니다.");
}
