import { ApiError, type createApiClient } from "../../api/client.ts";
import type { FieldError } from "../../api/client.ts";
import {
  byRequestPath,
  classifySubmissionError,
  decodeSubmissionReceipt,
  submissionsPath,
  type SubmissionReceipt,
  type ResidualState,
} from "./submission-data.ts";

type Request = ReturnType<typeof createApiClient>["request"];

/**
 * 접수와 복구의 사다리. 개발 안내 「응답과 처리」·「요청 ID 규칙」을 실행한다.
 *
 * 자동 복구는 **유한하다.** 끝까지 결과를 확인하지 못하면 사용자의 명시적
 * 재시도로 넘긴다. 저장소의 다른 로더도 같은 방식이다(`loadAnalysis`의 2회
 * 시도 뒤 수동 재시도). 응답 미확인 시의 재조회 횟수와 ID 보존 기간은 C02/C10
 * 계약에 아직 없으므로 아래 값은 **이 구현의 잠정 정책**이다.
 */
// 최초 전송 + by-request 404를 확인한 뒤의 재전송 1회.
export const MAX_SENDS = 2;
// 처리 중·결과 불명일 때의 재조회. 합계 약 3.1초를 기다린다.
export const RECOVERY_DELAYS_MS = [300, 800, 2000] as const;

export type SubmissionResult =
  | {
      state: "accepted";
      receipt: SubmissionReceipt;
      /**
       * 응답 헤더 `X-Current-Bundle`이 알려 준 **지금** 판. 접수 당시 판과
       * 다르면 D-5 재전송 성공 예외다. 성공을 취소하거나 다시 제출하지 않고
       * 결과에 「접수 당시 판 기준」을 표시한다.
       *
       * 헤더가 없으면 null이다. 모든 API에 붙는 중이라 아직 없는 응답이
       * 있고(D-5), 없다고 판이 같다고 단정하지 않는다.
       */
      currentBundleId: string | null;
      /**
       * 곧바로 받은 응답이 아니라 복구로 확인한 결과다. 사용자에게 "이미
       * 접수돼 있었습니다"라고 알려야 하는 경우다.
       */
      recovered: boolean;
    }
  | {
      /**
       * 접수됐는지 **아직 모른다.** 요청 ID를 그대로 두었으므로 같은 ID로 다시
       * 확인할 수 있다. 새 ID를 만들면 중복 접수가 된다.
       */
      state: "unresolved";
      requestId: string;
      /**
       * `not-found` 조회가 404였다. **미접수로 단정하지 않는다.** 다만 같은
       * ID·같은 본문으로 다시 보낼 수 있는 유일한 경우라 따로 구분한다.
       */
      reason: "lost" | "in-progress" | "not-found";
      message: string;
    }
  | {
      /** 입력이 거절됐다. 접수는 일어나지 않았고 ID는 그대로 쓸 수 있다. */
      state: "rejected";
      code: string;
      message: string;
      fieldErrors: FieldError[];
    }
  | {
      /**
       * 이 ID에 다른 본문이 이미 접수돼 있다. 우리 본문은 접수되지 않았고
       * 이 ID로는 접수될 수 없다. ID는 무엇이 접수됐는지 조회하는 데 쓴다.
       */
      state: "conflict";
      requestId: string;
      message: string;
    }
  | { state: "bundle-changed"; currentBundleId: string | null }
  | {
      /**
       * 잔차가 준비되지 않아 **접수되지 않았다.** 요청 ID를 그대로 두었으므로
       * 준비된 뒤 같은 본문을 다시 보내면 그 ID로 접수된다.
       */
      state: "context-not-ready";
      code: string;
      message: string;
      residual: ResidualState | null;
    }
  | { state: "denied"; code: string; message: string }
  | { state: "expired" };

export type SubmitOptions = {
  request: Request;
  ticId: string;
  /** `requestId`를 뺀 제출 본문. 예약한 ID를 여기에 얹어 보낸다. */
  input: Record<string, unknown>;
  requestId: string;
  signal: AbortSignal;
  /**
   * 보존한 요청 ID를 버린다. 서버가 본문을 새로 만들라고 한 경우에만 부른다.
   * 결과를 모르는 상태에서는 절대 부르지 않는다.
   */
  // 요청 ID를 버리는 일은 여기서 하지 않는다. 2.2절이 그것을 사용자의
  // 선택으로 정했으므로 화면이 그 순간에만 버린다.
  wait?: (ms: number) => Promise<void>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function submitAnalysis(
  options: SubmitOptions,
): Promise<SubmissionResult> {
  const { request, ticId, input, requestId, signal } = options;
  const wait = options.wait ?? sleep;
  const expected = { ticId, requestId };
  const body = { requestId, ...input };

  let sends = 0;
  let polls = 0;
  // 첫 전송으로 곧바로 답을 받았는지. 한 번이라도 복구에 들어가면 꺼진다.
  let direct = true;

  async function send(): Promise<SubmissionResult | "recover"> {
    sends += 1;
    let status = 0;
    let currentBundleId: string | null = null;
    let value: unknown;
    try {
      value = await request<unknown>(submissionsPath(ticId), {
        method: "POST",
        json: body,
        signal,
        onResponse: (response) => {
          status = response.status;
          currentBundleId =
            response.headers.get("X-Current-Bundle")?.trim() || null;
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      const failure = classifySubmissionError(error);
      switch (failure.kind) {
        case "unknown-outcome":
        case "in-progress":
          direct = false;
          return "recover";
        case "bundle-changed":
          // 새 ID는 **재선택·사용자 확인 뒤**에 만든다(2.2절). 여기서 버리면
          // 확인 전에 앞선 요청의 ID가 사라진다. 버리는 일은 화면이 [최신
          // 자료 불러오기]를 받았을 때 한다.
          // 2.3절이 정본으로 적은 본문을 먼저 보고, 없으면 헤더를 쓴다. 제출
          // 응답에는 아직 헤더가 없을 수 있다(D-5).
          return {
            state: "bundle-changed",
            currentBundleId: failure.currentBundleId ?? currentBundleId,
          };
        case "conflict-body":
          // ID도 본문도 버리지 않는다. 무엇이 접수됐는지 먼저 확인한다.
          return {
            state: "conflict",
            requestId,
            message:
              "이 요청 번호로 다른 내용이 이미 접수되어 있습니다. 무엇이 접수됐는지 먼저 확인해 주세요.",
          };
        case "context-not-ready":
          // 미접수이고 같은 ID로 재전송한다. ID를 버리지 않는다.
          return {
            state: "context-not-ready",
            code: failure.code,
            message: failure.message,
            residual: failure.residual,
          };
        case "denied":
          return {
            state: "denied",
            code: failure.code,
            message: failure.message,
          };
        case "expired":
          return { state: "expired" };
        case "rejected":
          return {
            state: "rejected",
            code: failure.code,
            message: failure.message,
            fieldErrors: failure.fieldErrors,
          };
      }
    }
    // 접수는 됐는데 본문을 읽을 수 없으면 그대로 던진다. 오류 분류를 태우면
    // 거절처럼 보인다. 요청 ID는 그대로 두었으므로 같은 본문 재전송이 200이다.
    return {
      state: "accepted",
      receipt: decodeSubmissionReceipt(value, expected, status),
      recovered: !direct,
      currentBundleId,
    };
  }

  async function poll(): Promise<SubmissionResult | "send" | "again"> {
    await wait(
      RECOVERY_DELAYS_MS[Math.min(polls, RECOVERY_DELAYS_MS.length - 1)],
    );
    signal.throwIfAborted();
    polls += 1;
    let status = 0;
    let polledBundleId: string | null = null;
    let value: unknown;
    try {
      value = await request<unknown>(byRequestPath(requestId), {
        signal,
        onResponse: (response) => {
          status = response.status;
          polledBundleId =
            response.headers.get("X-Current-Bundle")?.trim() || null;
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 401) return { state: "expired" };
      // 404는 미접수를 뜻하지만 단정하지 않는다. 같은 ID로 재전송하면
      // 접수돼 있었으면 200 재현이, 아니면 201이 온다.
      if (error.status === 404) return "send";
      if (error.status === 409 && error.code === "REQUEST_IN_PROGRESS")
        return "again";
      // 조회 자체가 실패했다. 접수 여부는 여전히 모르므로 ID를 버리지 않는다.
      return "again";
    }
    return {
      state: "accepted",
      receipt: decodeSubmissionReceipt(value, expected, status, "lookup"),
      recovered: true,
      currentBundleId: polledBundleId,
    };
  }

  let reason: "lost" | "in-progress" = "lost";
  for (;;) {
    const sent = await send();
    if (sent !== "recover") return sent;
    // 결과를 모른다. 보내지 말고 조회로 확인한다.
    while (polls < RECOVERY_DELAYS_MS.length) {
      const step = await poll();
      if (step === "again") {
        reason = "in-progress";
        continue;
      }
      if (step === "send") {
        // 미접수로 보인다. 단정하지 않고 같은 ID로 한 번 더 보낸다.
        reason = "lost";
        break;
      }
      return step;
    }
    if (polls >= RECOVERY_DELAYS_MS.length || sends >= MAX_SENDS)
      return {
        state: "unresolved",
        requestId,
        reason,
        message:
          reason === "in-progress"
            ? "서버가 이 제출을 아직 처리하고 있습니다. 잠시 후 접수 결과를 다시 확인해 주세요."
            : "제출이 접수됐는지 확인하지 못했습니다. 다시 제출하지 말고 접수 결과를 확인해 주세요.",
      };
  }
}

/**
 * 보존한 요청 ID로 접수 결과만 확인한다. 화면의 [접수 결과 확인]이 쓴다.
 * 전송을 하지 않으므로 중복 접수를 만들지 않는다.
 */
export async function checkSubmission(options: {
  request: Request;
  ticId: string;
  requestId: string;
  signal: AbortSignal;
}): Promise<SubmissionResult> {
  const { request, ticId, requestId, signal } = options;
  let status = 0;
  let currentBundleId: string | null = null;
  try {
    const value = await request<unknown>(byRequestPath(requestId), {
      signal,
      onResponse: (response) => {
        status = response.status;
        currentBundleId =
          response.headers.get("X-Current-Bundle")?.trim() || null;
      },
    });
    return {
      state: "accepted",
      receipt: decodeSubmissionReceipt(
        value,
        { ticId, requestId },
        status,
        "lookup",
      ),
      recovered: true,
      currentBundleId,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) return { state: "expired" };
    return {
      state: "unresolved",
      requestId,
      reason:
        error.code === "REQUEST_IN_PROGRESS"
          ? "in-progress"
          : error.status === 404
            ? "not-found"
            : "lost",
      message:
        error.status === 404
          ? // 404를 근거로 "제출되지 않았습니다"라고 단정하지 않는다.
            "아직 접수 기록을 찾지 못했습니다. 같은 내용으로 다시 제출하면 중복 없이 처리됩니다."
          : "접수 결과를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.",
    };
  }
}
