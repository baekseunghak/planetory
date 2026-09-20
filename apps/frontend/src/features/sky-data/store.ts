import { ApiError } from "../../api/client.ts";
import {
  asOf,
  readSkyMeta,
  readSkyTiles,
  SkyContractError,
  type Box,
  compareTic,
  type SkyPage,
  type SkyMeta,
  type Star,
} from "./contracts.ts";
import {
  cacheKey,
  requestGroups,
  tileQuery,
  visibleCells,
  type Cell,
} from "./geometry.ts";

export type SkyRequest = (
  path: string,
  options: { signal: AbortSignal },
) => Promise<unknown>;
export type SkyView = { level: number; box: Box | null };
export type TileFailure = { box: Box; error: Error };
export type SkySnapshot = {
  meta: SkyMeta | null;
  view: SkyView | null;
  stars: Star[];
  loadedCount: number;
  pageProgress: {
    box: Box;
    loaded: number;
    expected: number | null;
    pages: number;
  }[];
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
  private cache = new Map<string, { cell: Cell; stars: Star[] }>();
  private completeViews: {
    sources: Star[][];
    stars: Map<string, Star>;
    list: Star[];
  }[] = [];
  private ranges = new Map<
    string,
    {
      box: Box;
      stars: Map<string, Star>;
      bounds: Box | null;
      count: number | null;
      cursor: string | null;
      seen: Set<string>;
      pages: number;
      restart: boolean;
    }
  >();
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
    loadedCount: 0,
    pageProgress: [],
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
    private readonly pageLimit = 1000,
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
    return this.meta && this.view ? visibleCells(this.view.box, this.meta) : [];
  }
  private publish() {
    if (this.disposed) return;
    let stars = new Map<string, Star>();
    let list: Star[] | null = null;
    if (this.meta && this.view) {
      let cells: Cell[] = [];
      try {
        cells = this.cells();
      } catch {
        /* loadTiles reports the range error. */
      }
      const visible = new Set(cells.map((c) => c.col + ":" + c.row));
      const entries = cells.map((cell) =>
        this.cache.get(
          cacheKey(this.memberId, this.meta!.version, this.view!.level, cell),
        ),
      );
      const complete = this.ranges.size === 0 && entries.every(Boolean);
      const sources = complete ? entries.map((e) => e!.stars) : [];
      const reused = complete
        ? this.completeViews.find(
            (c) =>
              c.sources.length === sources.length &&
              c.sources.every((s, i) => s === sources[i]),
          )
        : undefined;
      if (reused) {
        stars = reused.stars;
        list = reused.list;
      } else {
        for (const cell of cells) {
          const entry = this.cache.get(
            cacheKey(this.memberId, this.meta.version, this.view.level, cell),
          );
          if (entry)
            for (const star of entry.stars) stars.set(star.ticId, star);
        }
        for (const range of this.ranges.values())
          for (const star of range.stars.values())
            if (
              visible.has(
                Math.floor(star.x / this.meta.tileSize) +
                  ":" +
                  Math.floor(star.y / this.meta.tileSize),
              )
            )
              stars.set(star.ticId, star);
        list = [...stars.values()];
        if (
          list.length === this.snapshot.stars.length &&
          list.every((s, i) => s === this.snapshot.stars[i])
        )
          list = this.snapshot.stars;
        if (complete) {
          this.completeViews.unshift({ sources, stars, list });
          this.completeViews.length = Math.min(4, this.completeViews.length);
        }
      }
    }
    const hasData = stars.size > 0;
    this.snapshot = {
      meta: this.meta,
      view: this.view,
      stars: list ?? [],
      loadedCount: stars.size,
      pageProgress: [...this.ranges.values()].map((r) => ({
        box: r.box,
        loaded: r.stars.size,
        expected: r.count,
        pages: r.pages,
      })),
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
    const next = { level: view.level, box: view.box ? { ...view.box } : null };
    if (JSON.stringify(this.view) === JSON.stringify(next)) return;
    // Camera movement within the same tile coverage does not invalidate pages or data.
    // Keep the current request epoch and array identity; only the view description changes.
    let sameCoverage = false;
    if (
      this.meta &&
      this.view?.level === next.level &&
      !this.needsRefresh &&
      !this.error &&
      !this.failures.length
    ) {
      try {
        const before = this.cells(),
          after = visibleCells(next.box, this.meta);
        sameCoverage =
          before.length === after.length &&
          before.every(
            (c, i) => c.col === after[i].col && c.row === after[i].row,
          );
      } catch {
        /* The normal load path reports invalid bounds. */
      }
    }
    this.view = next;
    if (this.loadingMeta || !this.meta || this.disposed) return;
    if (sameCoverage) {
      this.snapshot = { ...this.snapshot, view: this.view };
      this.listeners.forEach((listener) => listener());
      return;
    }
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
        this.completeViews = [];
        this.ranges.clear();
      } else if (
        this.meta &&
        JSON.stringify([
          this.meta.tileSize,
          this.meta.zoomLevels,
          this.meta.bounds,
          this.meta.starCount,
          this.meta.layoutVersion,
          this.meta.presentationVersion,
        ]) !==
          JSON.stringify([
            meta.tileSize,
            meta.zoomLevels,
            meta.bounds,
            meta.starCount,
            meta.layoutVersion,
            meta.presentationVersion,
          ])
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
      if (!meta.zoomLevels.some((z) => z.level === view.level))
        throw new SkyContractError("메타에 없는 배율입니다.");
      if (
        !Number.isInteger(this.pageLimit) ||
        this.pageLimit < 1 ||
        this.pageLimit > 2000
      )
        throw new SkyContractError("페이지 limit 범위를 확인해 주세요.");
      cells = this.cells();
    } catch (error) {
      this.error = errorOf(error);
      this.ranges.clear();
      this.publish();
      return;
    }
    const needed = new Set(
      cells.map((c) => cacheKey(this.memberId, meta.version, view.level, c)),
    );
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
    const rangeKey = (box: Box) =>
      JSON.stringify([
        this.memberId,
        meta.version,
        view.level,
        box,
        this.pageLimit,
      ]);
    const active = new Set(groups.map((g) => rangeKey(g.box)));
    for (const key of this.ranges.keys())
      if (!active.has(key)) this.ranges.delete(key);
    for (const key of this.cache.keys())
      if (
        this.cache.size > Math.max(this.cacheLimit, needed.size) &&
        !needed.has(key)
      )
        this.cache.delete(key);
    this.pending = groups.length;
    this.publish();
    let nextGroup = 0;
    const worker = async () => {
      while (this.current(epoch) && nextGroup < groups.length) {
        const group = groups[nextGroup++],
          key = rangeKey(group.box),
          controller = this.controller();
        let range = this.ranges.get(key);
        if (!range || range.restart) {
          range = {
            box: group.box,
            stars: new Map(),
            bounds: null,
            count: null,
            cursor: null,
            seen: new Set(),
            pages: 0,
            restart: false,
          };
          this.ranges.set(key, range);
        }
        try {
          while (this.current(epoch)) {
            const data = readSkyTiles(
              await this.request(
                tileQuery(
                  view.level,
                  group.box,
                  meta,
                  this.pageLimit,
                  range.cursor,
                ),
                { signal: controller.signal },
              ),
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
            if (
              data.asOf &&
              meta.asOf &&
              Date.parse(data.asOf) < Date.parse(meta.asOf)
            )
              throw new SkyContractError(
                "메타보다 오래된 페이지가 도착했습니다.",
              );
            this.checkPage(data, group.box, meta);
            if (
              range.bounds &&
              (JSON.stringify(range.bounds) !== JSON.stringify(data.bounds) ||
                range.count !== data.rangeStarCount)
            )
              throw new SkyContractError(
                "같은 범위의 페이지 경계/전체 수가 바뀌었습니다.",
              );
            const last = [...range.stars.keys()].at(-1);
            if (
              last &&
              data.stars.length &&
              compareTic(last, data.stars[0].ticId) >= 0
            )
              throw new SkyContractError(
                "페이지의 TIC 정렬/중복을 확인해 주세요.",
              );
            const known = new Map<string, Star>(),
              ordinals = new Map<number, string>();
            for (const entry of this.cache.values())
              for (const star of entry.stars) {
                known.set(star.ticId, star);
                ordinals.set(star.layoutOrdinal, star.ticId);
              }
            for (const r of this.ranges.values())
              for (const star of r.stars.values()) {
                known.set(star.ticId, star);
                ordinals.set(star.layoutOrdinal, star.ticId);
              }
            for (const star of data.stars) {
              const prior = known.get(star.ticId),
                priorId = ordinals.get(star.layoutOrdinal);
              if (
                (prior && JSON.stringify(prior) !== JSON.stringify(star)) ||
                (priorId && priorId !== star.ticId)
              )
                throw new SkyContractError(
                  "같은 버전의 별/순번 자료가 서로 다릅니다.",
                );
            }
            if (
              known.size +
                data.stars.filter((s) => !known.has(s.ticId)).length >
              meta.starCount
            )
              throw new SkyContractError(
                "적재된 고유 별 수가 전체 발견 수를 초과합니다.",
              );
            const count = range.stars.size + data.stars.length;
            if (
              count > data.rangeStarCount ||
              data.rangeStarCount > meta.starCount ||
              (data.nextCursor === null && count !== data.rangeStarCount)
            )
              throw new SkyContractError(
                "범위 적재 수와 rangeStarCount가 다릅니다.",
              );
            if (
              data.nextCursor !== null &&
              (!data.stars.length ||
                count >= data.rangeStarCount ||
                range.seen.has(data.nextCursor))
            )
              throw new SkyContractError("진행하지 않는 cursor 페이지입니다.");
            // Commit a page only after validation; network failures resume this exact cursor.
            range.bounds = data.bounds;
            range.count = data.rangeStarCount;
            range.pages++;
            for (const star of data.stars)
              range.stars.set(star.ticId, known.get(star.ticId) ?? star);
            range.cursor = data.nextCursor;
            if (data.nextCursor !== null) range.seen.add(data.nextCursor);
            if (data.nextCursor === null) {
              const byCell = new Map<string, Star[]>();
              for (const star of range.stars.values()) {
                const id =
                  Math.floor(star.x / meta.tileSize) +
                  ":" +
                  Math.floor(star.y / meta.tileSize);
                const list = byCell.get(id) || [];
                list.push(star);
                byCell.set(id, list);
              }
              for (const cell of group.cells)
                this.cache.set(
                  cacheKey(this.memberId, meta.version, view.level, cell),
                  { cell, stars: byCell.get(cell.col + ":" + cell.row) || [] },
                );
              this.ranges.delete(key);
              break;
            }
            this.publish();
          }
        } catch (error) {
          if (!this.current(epoch)) return;
          if (
            error instanceof SkyContractError ||
            (error instanceof ApiError &&
              error.status === 400 &&
              error.code === "VALIDATION_FAILED")
          )
            range.restart = true;
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
    if (this.current(epoch)) {
      for (const key of this.cache.keys())
        if (
          this.cache.size > Math.max(this.cacheLimit, needed.size) &&
          !needed.has(key)
        )
          this.cache.delete(key);
      this.publish();
    }
  }
  private checkPage(data: SkyPage, box: Box, meta: SkyMeta) {
    const b = data.bounds,
      s = meta.tileSize;
    const x = Math.floor(box.x / s) * s,
      y = Math.floor(box.y / s) * s;
    const expected = {
      x,
      y,
      w: Math.ceil((box.x + box.w) / s) * s - x,
      h: Math.ceil((box.y + box.h) / s) * s - y,
    };
    if (
      (Object.keys(expected) as (keyof Box)[]).some(
        (k) => Math.abs(b[k] - expected[k]) > 1e-7,
      ) ||
      data.stars.length > this.pageLimit
    )
      throw new SkyContractError("응답 범위/페이지 크기가 요청과 다릅니다.");
    if (
      data.stars.some(
        (star) =>
          star.x < meta.bounds.minX ||
          star.x > meta.bounds.maxX ||
          star.y < meta.bounds.minY ||
          star.y > meta.bounds.maxY,
      )
    )
      throw new SkyContractError("별 좌표가 메타의 월드 경계를 벗어났습니다.");
  }
  dispose() {
    this.cancel();
    this.disposed = true;
    this.cache.clear();
    this.completeViews = [];
    this.ranges.clear();
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
      loadedCount: 0,
      pageProgress: [],
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
