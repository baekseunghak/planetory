import { foldTimes } from "./fold-data";

export type FoldInit = {
  type: "init";
  dataId: string;
  times: Float64Array<ArrayBuffer>;
  reference: number;
};
export type FoldRequest = {
  type: "fold";
  dataId: string;
  revision: number;
  period: number;
};
export type WorkerRequest = FoldInit | FoldRequest;
export type WorkerResponse =
  | { type: "ready"; dataId: string }
  | { type: "init-error"; dataId: string; error: string }
  | {
      type: "folded";
      dataId: string;
      revision: number;
      phases: Float64Array<ArrayBuffer>;
    }
  | { type: "fold-error"; dataId: string; revision: number; error: string };

/** One cache per Worker. A failed replacement cannot leave the old curve available. */
export function createFoldProcessor(): (
  message: WorkerRequest,
) => WorkerResponse {
  let cached: FoldInit | null = null;
  return (message) => {
    if (message.type === "init") {
      cached = null;
      try {
        if (
          !message.dataId ||
          !Number.isFinite(message.reference) ||
          !(message.times instanceof Float64Array) ||
          !message.times.length
        )
          throw new Error("접기 초기화 자료가 유효하지 않습니다.");
        for (const time of message.times)
          if (!Number.isFinite(time))
            throw new Error("관측 시각은 유한한 값이어야 합니다.");
        // postMessage has already cloned the full times into the Worker's ownership.
        cached = message;
        return { type: "ready", dataId: message.dataId };
      } catch (error) {
        return {
          type: "init-error",
          dataId: message.dataId,
          error: (error as Error).message,
        };
      }
    }
    try {
      if (!cached || cached.dataId !== message.dataId)
        throw new Error("접기 요청과 Worker의 곡선 문맥이 일치하지 않습니다.");
      if (!Number.isSafeInteger(message.revision) || message.revision < 1)
        throw new Error("접기 요청 revision이 유효하지 않습니다.");
      return {
        type: "folded",
        dataId: message.dataId,
        revision: message.revision,
        phases: foldTimes(cached.times, cached.reference, message.period),
      };
    } catch (error) {
      return {
        type: "fold-error",
        dataId: message.dataId,
        revision: message.revision,
        error: (error as Error).message,
      };
    }
  };
}
