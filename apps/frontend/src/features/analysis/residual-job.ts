// 온라인 잔차 작업(7.1·7.2절). 개발 안내 「잔차 작업」을 실행한다.
//
// **요청 ID가 없다.** 같은 `target`을 다시 POST하면 진행 중 작업이나 캐시
// 결과가 그대로 오므로, 응답을 잃어도 같은 목표로 다시 부르면 된다.
// #187의 멱등 사다리를 여기에 가져오지 않는다. 없는 문제를 푸는 코드가 된다.

import { ApiError, type createApiClient } from "../../api/client.ts";
import { readCurveContext, type CurveContext } from "./analysis-data.ts";

type Request = ReturnType<typeof createApiClient>["request"];

export const residualJobsPath = (ticId: string) =>
  `/v1/stars/${encodeURIComponent(ticId)}/residual-jobs`;
export const residualJobPath = (jobId: string) =>
  `/v1/residual-jobs/${encodeURIComponent(jobId)}`;

/** 2.4절. `FAILED`는 어느 단계에서든 갈 수 있다. */
export const residualStates = [
  "QUEUED",
  "RESIDUAL_CALCULATING",
  "RESIDUAL_READY",
  "PERIODOGRAM_CALCULATING",
  "COMPLETED",
  "FAILED",
] as const;
export type ResidualStatus = (typeof residualStates)[number];

export type ResidualProgress = {
  status: ResidualStatus;
  jobId: string;
  /** 다음 조회까지 기다릴 시간. 서버가 정한다(D-3, Q08). */
  pollAfterSeconds: number;
  queuePosition: number | null;
  estimatedSeconds: number | null;
};

export type ResidualOutcome =
  /** 계산이 끝났다. 이 문맥으로 곡선을 바꿀 수 있다. */
  | { state: "ready"; curveContext: CurveContext; cacheHit: boolean }
  /** 아직이다. `pollAfterSeconds` 뒤에 다시 묻는다. */
  | { state: "running"; progress: ResidualProgress }
  /** 계산이 실패했다. 마지막 정상 곡선은 그대로 둔다. */
  | { state: "failed"; jobId: string; code: string; message: string }
  /**
   * 대기열이 찼다. `activeJobId`가 있으면 **내가 이미 돌리고 있는 작업**이라
   * 기다리라고 하면 안 되고 그쪽으로 데려가야 한다(회원당 1개, D-4).
   */
  | {
      state: "queue-full";
      retryAfterSeconds: number;
      activeJobId: string | null;
    }
  /** 판이 바뀌었다. 최신 판을 다시 불러와야 한다. */
  | { state: "bundle-changed"; currentBundleId: string | null };

const record = (value: unknown, at: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`잔차 작업 응답의 ${at} 항목을 확인해 주세요.`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, at: string): string => {
  if (typeof value !== "string" || !value)
    throw new Error(`잔차 작업 응답의 ${at} 항목을 확인해 주세요.`);
  return value;
};
const status = (value: unknown, at: string): ResidualStatus => {
  const found = residualStates.find((item) => item === value);
  if (!found) throw new Error(`잔차 작업 응답의 ${at} 항목을 확인해 주세요.`);
  return found;
};
/** 없거나 수가 아니면 null이다. 0으로 바꾸지 않는다. */
const maybeNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const seconds = (value: unknown): number => maybeNumber(value) ?? 0;

/** 7.1·7.2절 응답에서 진행 상태를 읽는다. */
function readProgress(
  data: Record<string, unknown>,
  at: string,
): ResidualProgress {
  return {
    status: status(data.status, `${at}.status`),
    jobId: text(data.jobId, `${at}.jobId`),
    pollAfterSeconds: seconds(data.pollAfterSeconds),
    queuePosition: maybeNumber(data.queuePosition),
    estimatedSeconds: maybeNumber(data.estimatedSeconds),
  };
}

function refused(error: unknown): ResidualOutcome | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 429 && error.code === "RESIDUAL_QUEUE_FULL")
    return {
      state: "queue-full",
      retryAfterSeconds: seconds(error.details.retryAfterSeconds),
      activeJobId:
        typeof error.details.activeJobId === "string"
          ? error.details.activeJobId
          : null,
    };
  if (error.status === 409 && error.code === "BUNDLE_CHANGED")
    return {
      state: "bundle-changed",
      currentBundleId:
        typeof error.details.currentBundleId === "string"
          ? error.details.currentBundleId
          : null,
    };
  return null;
}

/** 7.1절. 계산을 요청한다. 이미 있으면 그 작업이나 캐시가 온다. */
export async function requestResidualJob(options: {
  request: Request;
  ticId: string;
  target: CurveContext;
  signal: AbortSignal;
}): Promise<ResidualOutcome> {
  const { request, ticId, target, signal } = options;
  let code = 0;
  try {
    const value = await request<unknown>(residualJobsPath(ticId), {
      method: "POST",
      json: {
        target: {
          bundleId: target.bundleId,
          removedCandidateIds: target.removedCandidateIds,
          residualModelVersion: target.residualModelVersion,
          periodogramConfigVersion: target.periodogramConfigVersion,
        },
      },
      signal,
      onResponse: (response) => void (code = response.status),
    });
    const data = record(value, "본문");
    // 200은 캐시다. 계산을 기다릴 것이 없다.
    if (code === 200)
      return {
        state: "ready",
        curveContext: readCurveContext(data.resultCurveContext),
        cacheHit: true,
      };
    return { state: "running", progress: readProgress(data, "본문") };
  } catch (error) {
    signal.throwIfAborted();
    const known = refused(error);
    if (known) return known;
    throw error;
  }
}

/** 7.2절. 상태를 한 번 묻는다. */
export async function pollResidualJob(options: {
  request: Request;
  jobId: string;
  signal: AbortSignal;
}): Promise<ResidualOutcome> {
  const { request, jobId, signal } = options;
  try {
    const value = await request<unknown>(residualJobPath(jobId), { signal });
    const data = record(value, "본문");
    const state = status(data.status, "본문.status");
    if (state === "COMPLETED")
      return {
        state: "ready",
        curveContext: readCurveContext(data.resultCurveContext),
        cacheHit: false,
      };
    if (state === "FAILED") {
      const failure = record(data.failure, "본문.failure");
      return {
        state: "failed",
        jobId,
        code: text(failure.code, "본문.failure.code"),
        message: text(failure.message, "본문.failure.message"),
      };
    }
    return { state: "running", progress: readProgress(data, "본문") };
  } catch (error) {
    signal.throwIfAborted();
    const known = refused(error);
    if (known) return known;
    throw error;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 끝날 때까지 묻는다. **서버가 정한 `pollAfterSeconds`를 따른다.**
 *
 * 한도를 두지 않는다. 계산이 길어질 수 있고, 멈추는 것은 사용자가 화면을
 * 떠나거나 중단할 때다(`signal`). 다만 서버가 0초를 주더라도 최소 간격을
 * 두어 쉬지 않고 두드리지 않는다.
 */
export const MIN_POLL_MS = 400;
export async function runResidualJob(options: {
  request: Request;
  ticId: string;
  target: CurveContext;
  signal: AbortSignal;
  /** 상태가 바뀔 때마다 부른다. 화면이 순서를 그린다. */
  onProgress?: (progress: ResidualProgress) => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<ResidualOutcome> {
  const { request, ticId, target, signal, onProgress } = options;
  const wait = options.wait ?? sleep;
  let outcome = await requestResidualJob({ request, ticId, target, signal });
  while (outcome.state === "running") {
    onProgress?.(outcome.progress);
    await wait(Math.max(outcome.progress.pollAfterSeconds * 1000, MIN_POLL_MS));
    signal.throwIfAborted();
    outcome = await pollResidualJob({
      request,
      jobId: outcome.progress.jobId,
      signal,
    });
  }
  if (outcome.state === "ready" && !outcome.cacheHit) {
    // 완료도 진행의 마지막 상태다. 화면이 순서를 끝까지 그린다.
    onProgress?.({
      status: "COMPLETED",
      jobId: "",
      pollAfterSeconds: 0,
      queuePosition: null,
      estimatedSeconds: null,
    });
  }
  return outcome;
}
