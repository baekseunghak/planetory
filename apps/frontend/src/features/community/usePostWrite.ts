import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";

export function usePostWrite() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );
  const clearError = useCallback(() => setError(null), []);
  const run = useCallback(
    async <T>(
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ value: T } | null> => {
      if (controller.current) return null;
      const request = new AbortController();
      controller.current = request;
      setPending(true);
      setError(null);
      try {
        const value = await action(request.signal);
        return request.signal.aborted ? null : { value };
      } catch (failure) {
        if (!request.signal.aborted)
          setError(
            failure instanceof Error
              ? failure
              : new Error("요청 결과를 확인할 수 없습니다."),
          );
        return null;
      } finally {
        if (controller.current === request) {
          controller.current = null;
          setPending(false);
        }
      }
    },
    [],
  );
  return {
    run,
    pending,
    error,
    clearError,
    uncertain: error instanceof ApiError && error.outcomeUnknown,
  };
}

// A 2xx write with an unusable DTO may already be committed on the server.
export function decodeWritten<T>(
  value: unknown,
  decode: (value: unknown) => T,
): T {
  try {
    return decode(value);
  } catch {
    throw new ApiError(
      0,
      "INVALID_RESPONSE",
      "저장 응답을 확인할 수 없습니다. 저장 여부를 다시 조회해 주세요.",
      [],
      null,
      null,
      true,
    );
  }
}
