import {
  asOf,
  readSkyMeta,
  readSkyTiles,
  SkyContractError,
  type Box,
  type Cluster,
  type SkyMeta,
  type SkyTiles,
  type Star,
} from "./contracts.ts";
import {
  cacheKey,
  intersects,
  requestGroups,
  tileQuery,
  visibleCells,
  type Cell,
} from "./geometry.ts";

export type SkyRequest = (
  path: string,
  options: { signal: AbortSignal },
) => Promise<unknown>;
export type SkyView = { level: number; box: Box | null; overview?: boolean };
export type TileFailure = { box: Box; error: Error };
export type SkySnapshot = {
  meta: SkyMeta | null;
  view: SkyView | null;
  stars: Star[];
  clusters: Cluster[];
  pending: number;
  loadingMeta: boolean;
  needsRefresh: boolean;
  error: Error | null;
  failures: TileFailure[];
  selectedTicId: string | null;
  selectionStatus: "none" | "loaded" | "not-loaded";
  phase: "idle" | "loading" | "ready" | "partial" | "error";
};
const errorOf = (error: unknown) =>
  error instanceof Error ? error : new Error("지도를 불러오지 못했습니다.");
export class SkyDataStore {
  private meta: SkyMeta | null = null;
  private view: SkyView | null = null;
  private cache = new Map<string, { cell: Cell; data: SkyTiles }>();
  private listeners = new Set<() => void>();
  private controllers = new Set<AbortController>();
  private epoch = 0;
  private disposed = false;
  private loadingMeta = false;
  private pending = 0;
  private needsRefresh = false;
  private error: Error | null = null;
  private failures: TileFailure[] = [];
  private selectedTicId: string | null = null;
  private retired = new Set<string>();
  private hint: { skyVersion: string; asOf?: string } | null = null;
  private eventTime = -Infinity;
  private snapshot: SkySnapshot = {
    meta: null,
    view: null,
    stars: [],
    clusters: [],
    pending: 0,
    loadingMeta: false,
    needsRefresh: false,
    error: null,
    failures: [],
    selectedTicId: null,
    selectionStatus: "none",
    phase: "idle",
  };
  constructor(
    private readonly request: SkyRequest,
    readonly memberId: string,
    private readonly cacheLimit = 1024,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private cancel() {
    ++this.epoch;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.pending = 0;
  }
  private controller() {
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }
  private current(epoch: number) {
    return !this.disposed && epoch === this.epoch;
  }
  private cells() {
    return this.meta && this.view && !this.view.overview
      ? visibleCells(this.view.box, this.meta)
      : [];
  }
  private publish() {
    if (this.disposed) return;
    const stars = new Map<string, Star>(),
      clusters = new Map<string, Cluster>();
    if (this.meta && this.view) {
      if (this.view.overview)
        this.meta.overview.forEach((c) => clusters.set(c.nodeId, c));
      else
        for (const cell of (() => {
          try {
            return this.cells();
          } catch {
            return [];
          }
        })()) {
          const entry = this.cache.get(
            cacheKey(this.memberId, this.meta.version, this.view.level, cell),
          );
          if (!entry) continue;
          for (const star of entry.data.stars)
            if (
              Math.floor(star.x / this.meta.tileSize) === cell.col &&
              Math.floor(star.y / this.meta.tileSize) === cell.row
            )
              stars.set(star.ticId, star);
          for (const cluster of entry.data.clusters)
            if (intersects(cluster.bounds, cell.box))
              clusters.set(cluster.nodeId, cluster);
        }
    }
    const hasData = stars.size > 0 || clusters.size > 0;
    this.snapshot = {
      meta: this.meta,
      view: this.view,
      stars: [...stars.values()],
      clusters: [...clusters.values()],
      pending: this.pending,
      loadingMeta: this.loadingMeta,
      needsRefresh: this.needsRefresh,
      error: this.error,
      failures: [...this.failures],
      selectedTicId: this.selectedTicId,
      selectionStatus:
        this.selectedTicId === null
          ? "none"
          : stars.has(this.selectedTicId)
            ? "loaded"
            : "not-loaded",
      phase:
        this.loadingMeta || this.pending
          ? "loading"
          : this.error || this.failures.length
            ? hasData
              ? "partial"
              : "error"
            : this.meta
              ? "ready"
              : "idle",
    };
    this.listeners.forEach((listener) => listener());
  }
  select(ticId: string | null) {
    this.selectedTicId = ticId;
    this.publish();
  }
  async setView(view: SkyView) {
    // Store an independent copy: a renderer cannot mutate the in-flight request's bounds.
    this.view = { ...view, box: view.box ? { ...view.box } : null };
    if (this.loadingMeta || !this.meta || this.disposed) return;
    if (this.needsRefresh) {
      this.publish();
      return;
    }
    await this.loadTiles(true);
  }
  async refresh(allowVersionRefresh = true) {
    if (this.disposed) return;
    this.cancel();
    const epoch = this.epoch,
      controller = this.controller();
    this.loadingMeta = true;
    this.needsRefresh = !!this.meta;
    this.error = null;
    this.failures = [];
    this.publish();
    try {
      const meta = readSkyMeta(
        await this.request("/v1/me/sky", { signal: controller.signal }),
      );
      if (!this.current(epoch)) return;
      if (
        this.retired.has(meta.version) ||
        (meta.asOf &&
          this.meta?.asOf &&
          Date.parse(meta.asOf) < Date.parse(this.meta.asOf))
      )
        throw new SkyContractError(
          "이전 지도 버전이 도착했습니다. 다시 확인해 주세요.",
        );
      if (
        this.hint &&
        this.meta &&
        this.hint.skyVersion !== this.meta.version &&
        meta.version === this.meta.version
      )
        throw new SkyContractError(
          "새 지도 버전이 아직 반영되지 않았습니다. 다시 확인해 주세요.",
        );
      if (this.meta?.version !== meta.version) {
        if (this.meta) this.retired.add(this.meta.version);
        this.cache.clear();
      } else if (
        this.meta &&
        JSON.stringify([this.meta.tileSize, this.meta.zoomLevels]) !==
          JSON.stringify([meta.tileSize, meta.zoomLevels])
      )
        throw new SkyContractError("같은 버전의 타일 구조가 달라졌습니다.");
      this.meta = meta;
      this.loadingMeta = false;
      this.needsRefresh = false;
      this.hint = null;
      this.error = null;
      this.publish();
      if (this.view) await this.loadTiles(allowVersionRefresh);
    } catch (error) {
      if (!this.current(epoch)) return;
      this.error = errorOf(error);
      this.loadingMeta = false;
      this.needsRefresh = true;
      this.publish();
    } finally {
      this.controllers.delete(controller);
    }
  }
  // Call after the existing submission/publication/reopen API succeeds. No new server endpoint.
  async notifySkyChanged(event: { skyVersion: string; asOf?: string }) {
    if (this.disposed || !event.skyVersion) return;
    const stamp = asOf(event.asOf),
      time = stamp ? Date.parse(stamp) : null;
    if (time !== null && time < this.eventTime) return;
    if (time !== null) this.eventTime = time;
    if (
      this.retired.has(event.skyVersion) ||
      event.skyVersion === this.meta?.version ||
      (this.loadingMeta && this.hint?.skyVersion === event.skyVersion)
    )
      return;
    this.hint = { skyVersion: event.skyVersion, asOf: stamp };
    await this.refresh();
  }
  async retry() {
    if (this.needsRefresh || !this.meta) await this.refresh();
    else await this.loadTiles(true);
  }
  private async loadTiles(allowVersionRefresh: boolean) {
    if (!this.meta || !this.view || this.disposed) return;
    this.cancel();
    const epoch = this.epoch,
      meta = this.meta,
      view = this.view;
    this.error = null;
    this.failures = [];
    let cells: Cell[];
    try {
      if (
        !meta.zoomLevels.some((z) => z.level === view.level) ||
        (view.overview && view.level !== 0)
      )
        throw new SkyContractError("메타에 없는 배율입니다.");
      cells = this.cells();
    } catch (error) {
      this.error = errorOf(error);
      this.publish();
      return;
    }
    const needed = new Set(
      cells.map((c) => cacheKey(this.memberId, meta.version, view.level, c)),
    );
    // Touch active cells; evict only off-screen entries. Current successful regions remain usable.
    for (const key of needed) {
      const entry = this.cache.get(key);
      if (entry) {
        this.cache.delete(key);
        this.cache.set(key, entry);
      }
    }
    const groups = requestGroups(
      cells.filter(
        (c) =>
          !this.cache.has(cacheKey(this.memberId, meta.version, view.level, c)),
      ),
    );
    this.pending = groups.length;
    this.publish();
    let cursor = 0;
    const worker = async () => {
      while (this.current(epoch) && cursor < groups.length) {
        const group = groups[cursor++],
          controller = this.controller();
        try {
          const data = readSkyTiles(
            await this.request(tileQuery(view.level, group.box, meta), {
              signal: controller.signal,
            }),
          );
          if (!this.current(epoch)) return;
          if (data.level !== view.level)
            throw new SkyContractError("요청과 응답의 배율이 다릅니다.");
          if (data.version !== meta.version || data.versionChanged) {
            if (this.retired.has(data.version))
              throw new SkyContractError("폐기한 지도 버전의 응답입니다.");
            if (!allowVersionRefresh) {
              this.needsRefresh = true;
              throw new SkyContractError(
                "지도 버전이 다시 바뀌었습니다. 새로 확인해 주세요.",
              );
            }
            this.hint = { skyVersion: data.version };
            await this.refresh(false);
            return;
          }
          const clustered = meta.zoomLevels[view.level].clustered;
          if (
            (clustered && data.stars.length) ||
            (!clustered && data.clusters.length)
          )
            throw new SkyContractError(
              "공식 군집 단계와 노드 종류가 다릅니다.",
            );
          const b = data.bounds,
            s = meta.tileSize;
          if (
            [b.x / s, b.y / s, b.w / s, b.h / s].some(
              (n) => Math.abs(n - Math.round(n)) > 1e-8,
            ) ||
            b.x > group.box.x ||
            b.y > group.box.y ||
            b.x + b.w < group.box.x + group.box.w ||
            b.y + b.h < group.box.y + group.box.h
          )
            throw new SkyContractError(
              "응답 타일 범위가 요청 영역을 덮지 않습니다.",
            );
          for (const cell of group.cells)
            this.cache.set(
              cacheKey(this.memberId, meta.version, view.level, cell),
              { cell, data },
            );
          for (const key of this.cache.keys())
            if (
              this.cache.size > Math.max(this.cacheLimit, needed.size) &&
              !needed.has(key)
            )
              this.cache.delete(key);
        } catch (error) {
          if (!this.current(epoch)) return;
          this.failures.push({ box: group.box, error: errorOf(error) });
        } finally {
          this.controllers.delete(controller);
          if (this.current(epoch)) {
            --this.pending;
            this.publish();
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, groups.length) }, worker),
    );
    if (this.current(epoch)) this.publish();
  }
  dispose() {
    this.cancel();
    this.disposed = true;
    this.cache.clear();
    this.retired.clear();
    this.meta = null;
    this.view = null;
    this.selectedTicId = null;
    this.hint = null;
    this.snapshot = {
      ...this.snapshot,
      meta: null,
      view: null,
      stars: [],
      clusters: [],
      selectedTicId: null,
      selectionStatus: "none",
      phase: "idle",
      pending: 0,
      failures: [],
      error: null,
    };
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }
}
