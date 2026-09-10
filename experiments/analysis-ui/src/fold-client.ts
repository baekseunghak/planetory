import type { WorkerRequest, WorkerResponse } from './fold.worker';

export const FOLD_TIMEOUT_MS = 15_000;

export interface FoldWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerRequest): void;
  terminate(): void;
}

interface Job {
  revision: number;
  period: number;
  settled: boolean;
  resolve: (phases: Float64Array | null) => void;
  reject: (error: Error) => void;
}

/** One worker per observation bundle, one running fold, and at most one newer input. */
export class FoldClient {
  private worker: FoldWorker | null = null;
  private ready = false;
  private disposed = false;
  private revision = 0;
  private active: Job | null = null;
  private queued: Job | null = null;
  private latest: Job | null = null;
  private frame: number | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly data: { dataId: string; times: number[]; reference: number },
    private readonly createWorker: () => FoldWorker = () =>
      new Worker(new URL('./fold.worker.ts', import.meta.url), { type: 'module' }),
  ) {}

  /** Superseded/cancelled requests resolve null and must never change the visible draft. */
  request(period: number): Promise<Float64Array | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.latest) this.resolve(this.latest, null);
    return new Promise((resolve, reject) => {
      const job: Job = { revision: ++this.revision, period, resolve, reject, settled: false };
      this.latest = job;
      this.queued = job;
      try {
        this.ensureWorker();
        this.schedule();
      } catch (error) {
        this.failWorker(
          error instanceof Error ? error : new Error('Worker를 시작하지 못했습니다.'),
        );
      }
    });
  }

  private resolve(job: Job, value: Float64Array | null) {
    if (job.settled) return;
    job.settled = true;
    job.resolve(value);
  }

  private reject(job: Job, error: Error) {
    if (job.settled) return;
    job.settled = true;
    job.reject(error);
  }

  private ensureWorker() {
    if (this.worker) return;
    const worker = this.createWorker();
    this.worker = worker;
    this.ready = false;
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) this.failWorker(new Error('Worker 실행에 실패했습니다.'));
    };
    worker.onmessage = ({ data }) => {
      if (this.disposed || this.worker !== worker || data.dataId !== this.data.dataId) return;
      if (data.type === 'init-error') {
        if (!this.ready) this.failWorker(new Error(data.error));
        return;
      }
      if (data.type === 'ready') {
        if (this.ready) return;
        this.clearTimeout();
        this.ready = true;
        this.schedule();
        return;
      }
      const job = this.active;
      if (!job || data.revision !== job.revision) return;
      this.active = null;
      this.clearTimeout();
      if (job === this.latest) {
        if (data.error) this.reject(job, new Error(data.error));
        else if (
          !(data.phases instanceof Float64Array) ||
          data.phases.length !== this.data.times.length
        ) {
          this.reject(job, new Error('접힌 관측점이 원본과 일치하지 않습니다.'));
        } else this.resolve(job, data.phases);
        this.latest = null;
      }
      this.schedule();
    };
    this.watchdog();
    // postMessage clones the times once. Main-thread observations stay intact for the time chart.
    worker.postMessage({ type: 'init', ...this.data });
  }

  private schedule() {
    if (this.disposed || !this.ready || this.active || !this.queued || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed || !this.worker || !this.ready || this.active || !this.queued) return;
      const job = this.queued;
      this.queued = null;
      this.active = job;
      this.watchdog();
      try {
        this.worker.postMessage({
          type: 'fold',
          dataId: this.data.dataId,
          revision: job.revision,
          period: job.period,
        });
      } catch (error) {
        this.failWorker(error instanceof Error ? error : new Error('접기 요청에 실패했습니다.'));
      }
    });
  }

  private watchdog() {
    this.clearTimeout();
    this.timeout = setTimeout(
      () => this.failWorker(new Error('접기 계산 시간이 초과되었습니다.')),
      FOLD_TIMEOUT_MS,
    );
  }

  private clearTimeout() {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  private stopWorker() {
    this.clearTimeout();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.active = null;
    this.queued = null;
  }

  private failWorker(error: Error) {
    this.stopWorker();
    if (this.latest) this.reject(this.latest, error);
    this.latest = null;
  }

  dispose() {
    this.disposed = true;
    if (this.latest) this.resolve(this.latest, null);
    this.latest = null;
    this.stopWorker();
  }
}
