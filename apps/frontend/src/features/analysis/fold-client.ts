import { requireFoldPeriod, type FoldData } from "./fold-data";
import type { WorkerRequest, WorkerResponse } from "./fold-worker-core";

export interface FoldWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerRequest): void;
  terminate(): void;
}
export type FoldResult = {
  dataId: string;
  revision: number;
  periodDays: number;
  phases: Float64Array<ArrayBuffer>;
};
type Job = {
  revision: number;
  period: number;
  resolve: (result: FoldResult | null) => void;
  reject: (error: Error) => void;
};
type FoldClientOptions = {
  // The caller must choose a watchdog policy; this is not a product latency target.
  timeoutMs: number;
  createWorker?: () => FoldWorker;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
};

/** Reuses one Worker, with at most one running fold and one latest queued input. */
export class FoldClient {
  private readonly data: Pick<FoldData, "dataId" | "reference" | "times">;
  private worker: FoldWorker | null = null;
  private ready = false;
  private disposed = false;
  private revision = 0;
  private active: Job | null = null;
  private queued: Job | null = null;
  private latest: Job | null = null;
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    data: Pick<FoldData, "dataId" | "reference" | "times">,
    private readonly options: FoldClientOptions,
  ) {
    if (
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2_147_483_647
    )
      throw new RangeError("접기 감시 시간을 명시해 주세요.");
    // Protect retry initialization from accidental mutations of the caller's arrays.
    this.data = {
      dataId: data.dataId,
      reference: data.reference,
      times: data.times.slice(),
    };
  }

  request(period: number): Promise<FoldResult | null> {
    if (this.disposed) return Promise.resolve(null);
    try {
      requireFoldPeriod(period);
    } catch (error) {
      return Promise.reject(error);
    }
    this.latest?.resolve(null);
    return new Promise((resolve, reject) => {
      const job = { revision: ++this.revision, period, resolve, reject };
      this.latest = job;
      this.queued = job;
      try {
        this.ensureWorker();
        this.schedule();
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("Worker를 시작하지 못했습니다."),
        );
      }
    });
  }

  /** Check again at the UI commit boundary: a newer input may follow Promise resolution. */
  isCurrent(result: FoldResult): boolean {
    return (
      !this.disposed &&
      result.dataId === this.data.dataId &&
      result.revision === this.revision
    );
  }

  cancel(): void {
    ++this.revision;
    this.latest?.resolve(null);
    this.latest = null;
    this.stopWorker();
  }
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private ensureWorker() {
    if (this.worker) return;
    const worker: FoldWorker =
      this.options.createWorker?.() ??
      new Worker(new URL("./fold.worker.ts", import.meta.url), {
        type: "module",
      });
    this.worker = worker;
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker)
        this.fail(new Error("Worker 실행에 실패했습니다."));
    };
    worker.onmessageerror = () => {
      if (this.worker === worker)
        this.fail(new Error("Worker 응답을 읽지 못했습니다."));
    };
    worker.onmessage = ({ data }) => {
      if (
        this.disposed ||
        this.worker !== worker ||
        data.dataId !== this.data.dataId
      )
        return;
      if (data.type === "init-error") {
        if (!this.ready) this.fail(new Error(data.error));
        return;
      }
      if (data.type === "ready") {
        if (this.ready) return;
        this.clearTimer();
        this.ready = true;
        this.schedule();
        return;
      }
      const job = this.active;
      if (!job || data.revision !== job.revision) return;
      this.active = null;
      this.clearTimer();
      if (job === this.latest) {
        this.latest = null;
        if (data.type === "fold-error") job.reject(new Error(data.error));
        else if (
          !(data.phases instanceof Float64Array) ||
          data.phases.length !== this.data.times.length ||
          data.phases.some(
            (phase) => !Number.isFinite(phase) || phase < 0 || phase >= 1,
          )
        )
          job.reject(new Error("접힌 관측점이 원본과 일치하지 않습니다."));
        else
          job.resolve({
            dataId: this.data.dataId,
            revision: job.revision,
            periodDays: job.period,
            phases: data.phases,
          });
      }
      this.schedule();
    };
    this.watchdog();
    worker.postMessage({ type: "init", ...this.data });
  }

  private schedule() {
    if (
      this.disposed ||
      !this.ready ||
      this.active ||
      !this.queued ||
      this.frame !== null
    )
      return;
    this.frame = (this.options.requestFrame ?? requestAnimationFrame)(() => {
      this.frame = null;
      if (
        this.disposed ||
        !this.worker ||
        !this.ready ||
        this.active ||
        !this.queued
      )
        return;
      const job = this.queued;
      this.queued = null;
      this.active = job;
      this.watchdog();
      try {
        this.worker.postMessage({
          type: "fold",
          dataId: this.data.dataId,
          revision: job.revision,
          period: job.period,
        });
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("접기 요청에 실패했습니다."),
        );
      }
    });
  }
  private watchdog() {
    this.clearTimer();
    this.timer = setTimeout(
      () => this.fail(new Error("접기 계산 응답이 없어 작업을 중단했습니다.")),
      this.options.timeoutMs,
    );
  }
  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private stopWorker() {
    this.clearTimer();
    if (this.frame !== null)
      (this.options.cancelFrame ?? cancelAnimationFrame)(this.frame);
    this.frame = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.active = null;
    this.queued = null;
  }
  private fail(error: Error) {
    this.stopWorker();
    this.latest?.reject(error);
    this.latest = null;
  }
}
