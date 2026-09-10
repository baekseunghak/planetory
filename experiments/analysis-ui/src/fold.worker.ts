import { foldTimes } from './observation-math';

export interface InitRequest {
  type: 'init';
  dataId: string;
  times: number[];
  reference: number;
}

export interface FoldRequest {
  type: 'fold';
  dataId: string;
  revision: number;
  period: number;
}

export interface ReadyResponse {
  type: 'ready';
  dataId: string;
}

export interface InitErrorResponse {
  type: 'init-error';
  dataId: string;
  error: string;
}

export interface FoldResponse {
  type: 'folded';
  dataId: string;
  revision: number;
  phases: Float64Array<ArrayBuffer>;
  error?: string;
}

export type WorkerRequest = InitRequest | FoldRequest;
export type WorkerResponse = ReadyResponse | InitErrorResponse | FoldResponse;

// The app compiles with DOM libs; declaring this small surface avoids conflicting
// Window/WebWorker ambient declarations while keeping the transfer list typed.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let cachedData: { dataId: string; times: number[]; reference: number } | null = null;

worker.onmessage = ({ data }) => {
  if (data.type === 'init') {
    // A failed replacement must never leave an earlier observation available.
    cachedData = null;
    try {
      if (typeof data.dataId !== 'string' || !data.dataId.length) {
        throw new RangeError('관측 자료 ID가 필요합니다.');
      }
      if (!Number.isFinite(data.reference)) {
        throw new RangeError('기준 시각은 유한한 값이어야 합니다.');
      }
      if (!Array.isArray(data.times) || data.times.length === 0) {
        throw new RangeError('유효한 관측 시각이 없습니다.');
      }
      for (const time of data.times) {
        if (!Number.isFinite(time))
          throw new RangeError('관측 시각은 모두 유한한 값이어야 합니다.');
      }
      // postMessage already cloned the input into this Worker's ownership.
      cachedData = { dataId: data.dataId, times: data.times, reference: data.reference };
      worker.postMessage({ type: 'ready', dataId: data.dataId });
    } catch (error: unknown) {
      worker.postMessage({
        type: 'init-error',
        dataId: data.dataId,
        error: error instanceof Error ? error.message : '관측 자료 초기화에 실패했습니다.',
      });
    }
    return;
  }

  let response: FoldResponse;
  try {
    if (!cachedData) throw new Error('관측 자료가 아직 초기화되지 않았습니다.');
    if (cachedData.dataId !== data.dataId) {
      throw new Error('요청한 관측 자료와 Worker의 데이터가 일치하지 않습니다.');
    }
    response = {
      type: 'folded',
      dataId: data.dataId,
      revision: data.revision,
      phases: foldTimes(cachedData.times, cachedData.reference, data.period),
    };
  } catch (error: unknown) {
    response = {
      type: 'folded',
      dataId: data.dataId,
      revision: data.revision,
      phases: new Float64Array(0),
      error: error instanceof Error ? error.message : '접힌 곡선 계산에 실패했습니다.',
    };
  }
  // The UI must compare revisions before committing a result or recovering state.
  worker.postMessage(response, [response.phases.buffer]);
};
