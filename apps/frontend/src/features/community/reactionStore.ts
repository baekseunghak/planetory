import { ApiError } from "../../api/client";
import { assertIdentity, readPost } from "./contracts";
import {
  readReactionResult,
  readReactionSummary,
  type Reaction,
  type ReactionSummary,
} from "./reactionContracts";

type Request = (
  path: string,
  options?: { method?: string; json?: unknown; signal?: AbortSignal },
) => Promise<unknown>;
type State = {
  summary: ReactionSummary | null;
  wanted: Reaction;
  pending: boolean;
  loading: boolean;
  error: Error | null;
  uncertain: boolean;
};
export class ReactionStore {
  private state: State = {
    summary: null,
    wanted: "NONE",
    pending: false,
    loading: true,
    error: null,
    uncertain: false,
  };
  private listeners = new Set<() => void>();
  private read: AbortController | null = null;
  private write: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private refreshAfterWrite = false;
  constructor(
    private id: string,
    private request: Request,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(patch: Partial<State>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private path() {
    return `/v1/posts/${encodeURIComponent(this.id)}`;
  }
  async refresh() {
    if (this.disposed) return;
    if (this.write) {
      this.refreshAfterWrite = true;
      return;
    }
    const generation = ++this.generation;
    this.read?.abort();
    const controller = new AbortController();
    this.read = controller;
    this.publish({ loading: true, summary: null, error: null });
    try {
      const raw = await this.request(this.path(), {
        signal: controller.signal,
      });
      assertIdentity(readPost(raw).postId, this.id);
      const summary = readReactionSummary(
        (raw as { reactionSummary: unknown }).reactionSummary,
      );
      if (generation === this.generation && !controller.signal.aborted)
        this.publish({
          summary,
          wanted: summary.myReaction,
          loading: false,
          uncertain: false,
        });
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted)
        this.publish({ error: error as Error, loading: false });
    }
  }
  async choose(wanted: Reaction) {
    if (
      this.disposed ||
      this.state.uncertain ||
      !this.state.summary ||
      this.state.loading
    )
      return;
    this.publish({ wanted, error: null });
    if (this.write) return;
    ++this.generation;
    this.read?.abort();
    const controller = new AbortController();
    this.write = controller;
    this.publish({ pending: true });
    try {
      while (!controller.signal.aborted) {
        const sent = this.state.wanted;
        const raw = await this.request(`${this.path()}/my-reaction`, {
          method: "PUT",
          json: { reaction: sent },
          signal: controller.signal,
        });
        let summary: ReactionSummary;
        try {
          summary = readReactionResult(raw, this.id);
        } catch {
          throw new ApiError(
            0,
            "INVALID_RESPONSE",
            "반응 저장 응답을 확인할 수 없습니다.",
            [],
            null,
            null,
            true,
          );
        }
        if (controller.signal.aborted) return;
        if (sent === this.state.wanted) {
          this.publish({ summary, wanted: summary.myReaction, pending: false });
          break;
        }
        // Only a confirmed response allows dispatch of the most recent queued choice.
      }
    } catch (error) {
      if (!controller.signal.aborted)
        this.publish({
          pending: false,
          error: error as Error,
          uncertain: error instanceof ApiError && error.outcomeUnknown,
          wanted: this.state.summary?.myReaction ?? "NONE",
        });
    } finally {
      if (this.write === controller) this.write = null;
      if (this.refreshAfterWrite && !this.state.uncertain) {
        this.refreshAfterWrite = false;
        void this.refresh();
      }
    }
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    this.read?.abort();
    this.write?.abort();
    this.listeners.clear();
  }
}
