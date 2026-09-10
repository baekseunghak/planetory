import type { Bounds, MapNode, StarNode } from "../shared/types";
interface Branch {
  key: string;
  cell: Bounds;
  bounds: Bounds;
  children: Map<string, Branch>;
  parent: Branch | null;
  star?: StarNode;
  count: number;
  x: number;
  y: number;
  counts: MapNode["counts"];
}
const intersects = (a: Bounds, b: Bounds) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
const union = (a: Bounds, b: Bounds): Bounds => {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
};
/** Persistent spatial hierarchy; normal groups span at most 46 screen pixels.
 * The render budget can explicitly request coarser groups. Insertion and status
 * changes update only the affected ancestors, never rebuild the whole index. */
export class MapIndex {
  root: Branch;
  leaves = new Map<string, Branch>();
  count = 0;
  updatedBranches = 0;
  tileCache = new Map<string, MapNode[]>();
  constructor(points: StarNode[]) {
    this.root = this.branch(
      "root",
      { x: -131072, y: -131072, w: 262144, h: 262144 },
      null,
    );
    for (const p of points) this.upsert(p);
    this.updatedBranches = 0;
  }
  branch(key: string, cell: Bounds, parent: Branch | null): Branch {
    return {
      key,
      cell,
      parent,
      bounds: { ...cell },
      children: new Map(),
      count: 0,
      x: 0,
      y: 0,
      counts: { planet: 0, done: 0, new: 0 },
    };
  }
  get bounds(): Bounds {
    if (!this.count) return { x: -600, y: -400, w: 1200, h: 800 };
    const b = this.root.bounds,
      w = Math.max(600, b.w + 240),
      h = Math.max(400, b.h + 240);
    return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
  }
  inside(cell: Bounds, p: StarNode) {
    return (
      p.x >= cell.x &&
      p.x < cell.x + cell.w &&
      p.y >= cell.y &&
      p.y < cell.y + cell.h
    );
  }
  recompute(n: Branch) {
    this.updatedBranches++;
    if (n.star) {
      n.count = 1;
      n.x = n.star.x;
      n.y = n.star.y;
      n.bounds = { x: n.x, y: n.y, w: 0, h: 0 };
      n.counts = {
        planet: n.star.planetCount > 0 ? 1 : 0,
        done: !n.star.planetCount && n.star.status === "complete" ? 1 : 0,
        new: !n.star.planetCount && n.star.status !== "complete" ? 1 : 0,
      };
      return;
    }
    const children = [...n.children.values()].filter((c) => c.count);
    n.count = children.reduce((a, c) => a + c.count, 0);
    n.x = children.reduce((a, c) => a + c.x * c.count, 0) / (n.count || 1);
    n.y = children.reduce((a, c) => a + c.y * c.count, 0) / (n.count || 1);
    n.counts = { planet: 0, done: 0, new: 0 };
    for (const c of children) {
      n.counts.planet += c.counts.planet;
      n.counts.done += c.counts.done;
      n.counts.new += c.counts.new;
    }
    if (children.length)
      n.bounds = children
        .slice(1)
        .reduce((a, c) => union(a, c.bounds), children[0].bounds);
  }
  upsert(star: StarNode) {
    const old = this.leaves.get(star.id);
    if (old && JSON.stringify(old.star) === JSON.stringify(star)) return;
    if (old && (old.star!.x !== star.x || old.star!.y !== star.y))
      throw new Error("StarUnlock coordinates are immutable");
    this.updatedBranches = 0;
    if (old) {
      old.star = star;
      let n: Branch | null = old;
      while (n) {
        this.recompute(n);
        n = n.parent;
      }
    } else {
      while (!this.inside(this.root.cell, star)) {
        const oldRoot = this.root,
          c = oldRoot.cell;
        this.root = this.branch(
          "root:" + c.w * 2,
          {
            x: star.x < c.x ? c.x - c.w : c.x,
            y: star.y < c.y ? c.y - c.h : c.y,
            w: c.w * 2,
            h: c.h * 2,
          },
          null,
        );
        oldRoot.parent = this.root;
        this.root.children.set(
          (oldRoot.cell.x > this.root.cell.x ? 1 : 0) +
            "," +
            (oldRoot.cell.y > this.root.cell.y ? 1 : 0),
          oldRoot,
        );
        this.recompute(this.root);
      }
      let n = this.root;
      const path: Branch[] = [];
      for (let depth = 0; depth < 40; depth++) {
        path.push(n);
        const cell = n.cell;
        if (cell.w <= 1) {
          const leaf = this.branch(
            "star:" + star.id,
            { x: star.x, y: star.y, w: 0, h: 0 },
            n,
          );
          leaf.star = star;
          this.recompute(leaf);
          n.children.set(star.id, leaf);
          this.leaves.set(star.id, leaf);
          break;
        }
        const half = cell.w / 2,
          ix = star.x >= cell.x + half ? 1 : 0,
          iy = star.y >= cell.y + half ? 1 : 0,
          key = ix + "," + iy;
        let child = n.children.get(key);
        if (!child) {
          child = this.branch(
            n.key + "/" + key,
            { x: cell.x + ix * half, y: cell.y + iy * half, w: half, h: half },
            n,
          );
          n.children.set(key, child);
        }
        n = child;
      }
      for (let i = path.length - 1; i >= 0; i--) this.recompute(path[i]);
      this.count = this.leaves.size;
    }
    const changed = new Set<string>();
    let branch: Branch | null = this.leaves.get(star.id)!;
    while (branch) {
      changed.add(branch.key);
      branch = branch.parent;
    }
    for (const [key, nodes] of this.tileCache)
      if (
        nodes.some(
          (n) => n.id === star.id || changed.has(n.id.replace(/^cluster:/, "")),
        )
      )
        this.tileCache.delete(key);
    if (!old)
      for (const key of this.tileCache.keys()) {
        const [zoom, coords] = key.split(":");
        const [x, y] = coords.split(",").map(Number),
          size = 512 / Number(zoom);
        if (this.inside({ x: x * size, y: y * size, w: size, h: size }, star))
          this.tileCache.delete(key);
      }
  }
  node(n: Branch): MapNode {
    return {
      id: n.star?.id || "cluster:" + n.key,
      x: n.x,
      y: n.y,
      count: n.count,
      counts: { ...n.counts },
      bounds: { ...n.bounds },
      star: n.star
        ? {
            id: n.star.id,
            name: n.star.name,
            x: n.star.x,
            y: n.star.y,
            status: n.star.status,
            planetCount: n.star.planetCount,
            tutorial: n.star.tutorial,
            challenge: n.star.challenge,
          }
        : undefined,
    };
  }
  view(bounds: Bounds, zoom: number): MapNode[] {
    if (!this.count) return [];
    let threshold = zoom < 0.8 ? 46 / zoom : -1,
      nodes: MapNode[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      nodes = [];
      const stack = [this.root];
      while (stack.length) {
        const n = stack.pop()!;
        if (!n.count || !intersects(n.bounds, bounds)) continue;
        if (n.star) nodes.push(this.node(n));
        else if (n.count > 1 && Math.hypot(n.bounds.w, n.bounds.h) <= threshold)
          nodes.push(this.node(n));
        else for (const c of n.children.values()) stack.push(c);
      }
      const singles = nodes.filter((n) => !!n.star).length;
      if (singles <= 400 && nodes.length - singles <= 80) break;
      threshold = threshold < 0 ? 46 / zoom : threshold * 1.45;
    }
    return nodes;
  }
  groups(zoom: number) {
    return this.view(this.bounds, zoom);
  }
  tiles(keys: string[], zoom: number) {
    const seen = new Set<string>(),
      result: MapNode[] = [];
    for (const key of keys) {
      const [x, y] = key.split(",").map(Number);
      if (!Number.isFinite(x + y)) continue;
      const cacheKey = zoom + ":" + key,
        size = 512 / zoom;
      let nodes = this.tileCache.get(cacheKey);
      if (!nodes) {
        nodes = this.view({ x: x * size, y: y * size, w: size, h: size }, zoom);
        this.tileCache.set(cacheKey, nodes);
        if (this.tileCache.size > 128)
          this.tileCache.delete(this.tileCache.keys().next().value!);
      }
      for (const n of nodes)
        if (!seen.has(n.id)) {
          seen.add(n.id);
          result.push(n);
        }
    }
    return result;
  }
}
