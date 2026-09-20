import type { Star } from "../sky-data/contracts.ts";
import type { Matrix } from "../sky-data/geometry.ts";
import { starStyle, type OwnedSystem } from "./model.ts";
import { starTargets, type HitTarget } from "./interaction.ts";

type Node = {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  size: number;
  stars?: readonly Star[];
  children?: Node[];
};
type Source = { root: Node; byId: Map<string, Star> };
const sources = new WeakMap<readonly Star[], Source>();
const sizes = new WeakMap<Star, number>();
function build(stars: readonly Star[]): Node {
  if (!stars.length)
    return { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, size: 0, stars };
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity,
    size = 0;
  for (const s of stars) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
    minZ = Math.min(minZ, s.depthZ);
    maxZ = Math.max(maxZ, s.depthZ);
    let base = sizes.get(s);
    if (base === undefined) {
      base = starStyle(s).baseSize;
      sizes.set(s, base);
    }
    size = Math.max(size, base);
  }
  const n: Node = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
    hx: (maxX - minX) / 2,
    hy: (maxY - minY) / 2,
    hz: (maxZ - minZ) / 2,
    size,
  };
  if (stars.length <= 64 || Math.max(n.hx, n.hy) < 1e-8) n.stars = stars;
  else {
    const quadrants: Star[][] = [[], [], [], []];
    for (const s of stars)
      quadrants[Number(s.x >= n.x) + 2 * Number(s.y >= n.y)].push(s);
    const children = quadrants.filter((q) => q.length);
    if (children.length === 1) n.stars = stars;
    else n.children = children.map(build);
  }
  return n;
}
// The world tree survives camera changes. Project only pointer candidates;
// enumerate keyboard targets lazily and find the few marker IDs directly.
export class ProjectedStarIndex {
  private source: Source;
  private all: HitTarget[] | null = null;
  examined = 0;
  readonly byId: { get(id: string): HitTarget | undefined };
  constructor(
    stars: readonly Star[],
    private matrix: Matrix,
    private width: number,
    private height: number,
    private zoom: number,
    private selected: string | null,
    private system: OwnedSystem | null,
    private dpr = 1,
  ) {
    let source = sources.get(stars);
    if (!source) {
      source = {
        root: build(stars),
        byId: new Map(stars.map((s) => [s.ticId, s])),
      };
      sources.set(stars, source);
    }
    this.source = source;
    this.byId = {
      get: (id) => {
        const star = this.source.byId.get(id);
        return star ? this.project([star])[0] : undefined;
      },
    };
  }
  private project(stars: readonly Star[]) {
    return starTargets(
      stars,
      this.matrix,
      this.width,
      this.height,
      this.zoom,
      this.selected,
      this.system,
      this.dpr,
    );
  }
  get targets() {
    return (this.all ??= this.project([...this.source.byId.values()]));
  }
  private collect(node: Node, x: number, y: number, out: Star[]) {
    const m = this.matrix;
    const cx = m[0] * node.x + m[4] * node.y + m[8] * node.z + m[12];
    const cy = m[1] * node.x + m[5] * node.y + m[9] * node.z + m[13];
    const cz = m[2] * node.x + m[6] * node.y + m[10] * node.z + m[14];
    const ex =
      Math.abs(m[0]) * node.hx +
      Math.abs(m[4]) * node.hy +
      Math.abs(m[8]) * node.hz;
    const ey =
      Math.abs(m[1]) * node.hx +
      Math.abs(m[5]) * node.hy +
      Math.abs(m[9]) * node.hz;
    const ez =
      Math.abs(m[2]) * node.hx +
      Math.abs(m[6]) * node.hy +
      Math.abs(m[10]) * node.hz;
    const scale = this.zoom < 1 ? this.zoom ** 0.78 : this.zoom ** 0.36;
    const fit = Math.max(0.55, Math.min(this.width / 1680, this.height / 974));
    const radius = Math.max(
      8,
      Math.min(160, node.size * 1.35 * fit * this.dpr * scale) / this.dpr / 2,
    );
    if (
      cz - ez > 1 ||
      cz + ez < -1 ||
      x < ((cx - ex + 1) * this.width) / 2 - radius ||
      x > ((cx + ex + 1) * this.width) / 2 + radius ||
      y < ((1 - cy - ey) * this.height) / 2 - radius ||
      y > ((1 - cy + ey) * this.height) / 2 + radius
    )
      return;
    if (node.stars) {
      for (const star of node.stars) out.push(star);
    } else for (const child of node.children!) this.collect(child, x, y, out);
  }
  hit(x: number, y: number) {
    const m = this.matrix,
      candidates: Star[] = [];
    if (m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1)
      this.collect(this.source.root, x, y, candidates);
    else for (const star of this.source.byId.values()) candidates.push(star);
    // Selected bodies have larger sprites than ordinary nodes' size bounds.
    const special = this.source.byId.get(
      this.system?.ticId ?? this.selected ?? "",
    );
    if (special) candidates.push(special);
    this.examined = candidates.length;
    let best: HitTarget | null = null,
      distance = Infinity;
    for (const t of this.project(candidates)) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (
        d <= t.radius &&
        (d < distance || (d === distance && t.id < (best?.id ?? "")))
      ) {
        best = t;
        distance = d;
      }
    }
    return best;
  }
}
