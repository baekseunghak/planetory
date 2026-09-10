import { foldTimes } from './observation-math';

export interface FoldRequest {
  revision: number;
  times: number[];
  reference: number;
  period: number;
}

export interface FoldResponse {
  revision: number;
  phases: Float64Array<ArrayBuffer>;
  error?: string;
}

// The app compiles with DOM libs; declaring this small surface avoids conflicting
// Window/WebWorker ambient declarations while keeping the transfer list typed.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<FoldRequest>) => void) | null;
  postMessage(message: FoldResponse, transfer: Transferable[]): void;
};

worker.onmessage = ({ data }) => {
  let response: FoldResponse;
  try {
    response = {
      revision: data.revision,
      phases: foldTimes(data.times, data.reference, data.period),
    };
  } catch (error: unknown) {
    response = {
      revision: data.revision,
      phases: new Float64Array(0),
      error: error instanceof Error ? error.message : '접힌 곡선 계산에 실패했습니다.',
    };
  }
  // The UI must compare revisions before committing a result or recovering state.
  worker.postMessage(response, [response.phases.buffer]);
};
