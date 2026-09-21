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
  | {
      state: "failed";
      jobId: string;
      code: string;
      message: string;
      /**
       * 7.2절 `failure.retryable`. **거짓이면 다시 시도를 권하지 않는다.**
       * 눌러도 같은 결과인 버튼은 사용자에게 「내가 뭘 잘못했나」를 묻게
       * 만든다.
       *
       * 값이 없으면 **참으로 둔다.** 모르는 것 때문에 나갈 길을 막는 쪽이,
       * 헛클릭 한 번보다 비싸다.
       */
      retryable: boolean;
    }
  /**
   * 대기열이 찼다. `activeJobId`가 있으면 **내가 이미 돌리고 있는 작업**이라
   * 기다리라고만 하면 영문을 모른다(회원당 1개, D-4). 다만 그 작업으로
   * 데려가지는 않는다 — 목표가 다른 단계일 수 있어 완료돼도 지금 목표가
   * 준비된 것이 아니다.
   */
  | {
      state: "queue-full";
      retryAfterSeconds: number;
      activeJobId: string | null;
    }
  /** 판이 바뀌었다. 최신 판을 다시 불러와야 한다. */
  | { state: "bundle-changed"; currentBundleId: string | null }
  /**
   * 작업이 사라졌다(Redis 재시작 등). **실패가 아니라 상태를 잃은 것**이라
   * 7.1절로 다시 요청한다(명세 7.2·분석 프론트 8.1 「Redis 결과 없음」).
   * `runResidualJob`이 안에서 처리하므로 밖으로 나오지 않는다.
   */
  | { state: "lost" };

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
  /** 분석 진입 때 받은 판. 헤더와 다르면 계산 도중에 바뀐 것이다. */
  entryBundleId?: string;
}): Promise<ResidualOutcome> {
  const { request, jobId, signal, entryBundleId } = options;
  try {
    // D-5: 이 헤더가 계산이 도는 동안의 판 교체를 알려 주는 **유일한**
    // 길이다. 409는 POST에만 오고 `FAILED(BUNDLE_ARCHIVED)`는 88번 몫이다.
    // 7.2절의 값은 작업의 `target.bundleId`가 아니라 조회 시점의 현재 판이다.
    let currentBundleId: string | null = null;
    const value = await request<unknown>(residualJobPath(jobId), {
      signal,
      onResponse: (response) => {
        // 판을 못 읽으면 서버가 아예 붙이지 않는다. 없음은 **모름**이며
        // 판 교체로 읽지 않는다. 빈 문자열로 주지 않는 이유가 그것이다.
        currentBundleId =
          response.headers.get("X-Current-Bundle")?.trim() || null;
      },
    });
    // 상태보다 먼저 본다. 판이 바뀌었으면 이 작업의 결과는 옛 판 것이라
    // `COMPLETED`여도 쓸 수 없다.
    if (entryBundleId && currentBundleId && currentBundleId !== entryBundleId)
      return { state: "bundle-changed", currentBundleId };
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
        retryable: failure.retryable !== false,
      };
    }
    return { state: "running", progress: readProgress(data, "본문") };
  } catch (error) {
    signal.throwIfAborted();
    // 조회의 404는 **그 작업이 없어졌다**는 뜻뿐이다. 요청(7.1)의 404는
    // 별이 없다는 뜻이라 같이 다루지 않는다.
    if (error instanceof ApiError && error.status === 404)
      return { state: "lost" };
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
  /**
   * 분석 진입 때 받은 판. 폴링 응답의 `X-Current-Bundle`과 다르면 계산이
   * 도는 동안 판이 바뀐 것이다(D-5). 주지 않으면 검사하지 않는다.
   */
  entryBundleId?: string;
}): Promise<ResidualOutcome> {
  const { request, ticId, target, signal, onProgress, entryBundleId } = options;
  const wait = options.wait ?? sleep;
  let outcome = await requestResidualJob({ request, ticId, target, signal });
  // 작업이 사라졌을 때 **한 번만** 다시 요청한다. 계속 사라지면 그때는
  // 사용자에게 알린다. 요청 ID가 없어 같은 목표 재호출이 곧 복구다(7.1).
  let restarted = false;
  while (outcome.state === "running" || outcome.state === "lost") {
    if (outcome.state === "lost") {
      if (restarted)
        return {
          state: "failed",
          jobId: "",
          code: "RESOURCE_NOT_FOUND",
          message: "계산 작업이 사라져 다시 요청했지만 또 사라졌습니다.",
          // 서버가 준 실패가 아니라 우리가 만든 것이다. 사용자가 다시
          // 해 볼 여지는 남긴다.
          retryable: true,
        };
      restarted = true;
      outcome = await requestResidualJob({ request, ticId, target, signal });
      continue;
    }
    onProgress?.(outcome.progress);
    await wait(Math.max(outcome.progress.pollAfterSeconds * 1000, MIN_POLL_MS));
    signal.throwIfAborted();
    outcome = await pollResidualJob({
      request,
      jobId: outcome.progress.jobId,
      signal,
      entryBundleId,
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
