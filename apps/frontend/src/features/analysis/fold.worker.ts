import {
  createFoldProcessor,
  type WorkerRequest,
  type WorkerResponse,
} from "./fold-worker-core";

// Keep DOM and Worker ambient libraries separate in the shared frontend tsconfig.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};
const process = createFoldProcessor();
worker.onmessage = ({ data }) => {
  const response = process(data);
  worker.postMessage(
    response,
    response.type === "folded" ? [response.phases.buffer] : [],
  );
};
