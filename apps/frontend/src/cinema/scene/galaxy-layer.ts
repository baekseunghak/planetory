// Galaxy layers. Every member star lives in ONE Points buffer (tested up to
// 100k); decoration (dust, nebula, far stars) sits in its own buffers.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Sphere,
  Vector3,
} from "three";
import type { Star } from "../../features/sky-data/contracts";
import { starStyle } from "../../features/sky-renderer/model";
import { starWorld } from "./math";
import {
  backgroundStars,
  decorativeStar,
  dustGrains,
  nebulaPuffs,
  twinklePhase,
} from "./procedural";
import {
  nebulaFragment,
  nebulaVertex,
  starFragment,
  starVertex,
} from "./shaders";

export function starMaterial(reference: number) {
  return new ShaderMaterial({
    uniforms: {
      uPix: { value: 1 },
      uTime: { value: 0 },
      uTwinkle: { value: 1 },
      uRef: { value: reference },
      uAttMax: { value: 6 },
      uSizeScale: { value: 1 },
      uBrightness: { value: 1 },
      uFocus: { value: new Vector3() },
      uFocusRadius: { value: 1 },
      uFocusAmount: { value: 0 },
    },
    vertexShader: starVertex,
    fragmentShader: starFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

function pointsGeometry(
  position: Float32Array,
  color: Float32Array,
  size: Float32Array,
  twinkle: Float32Array,
  radius: number,
) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("aColor", new BufferAttribute(color, 3));
  geometry.setAttribute("aSize", new BufferAttribute(size, 1));
  geometry.setAttribute("aTwinkle", new BufferAttribute(twinkle, 1));
  geometry.boundingSphere = new Sphere(new Vector3(), radius);
  return geometry;
}

type Style = { rgb: number[]; baseSize: number };

/** Member stars. Positions are the stored x/y/depthZ; style from starStyle(). */
export class StarField {
  readonly material: ShaderMaterial;
  readonly points: Points;
  private geometry: BufferGeometry;
  private capacity = 0;
  count = 0;
  /** World xyz per star, CPU copy for picking and projection. */
  positions = new Float32Array(0);
  baseSizes = new Float32Array(0);
  private sizes = new Float32Array(0);
  private colors = new Float32Array(0);
  private twinkles = new Float32Array(0);
  stars: readonly Star[] = [];
  private index = new Map<string, number>();
  /** Stars kept at size 0 (waiting for ignition). */
  private hidden = new Set<string>();
  private scale = new Map<string, number>();
  private styles = new WeakMap<Star, Style>();
  decorative = false;

  constructor(reference: number) {
    this.material = starMaterial(reference);
    this.geometry = new BufferGeometry();
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    // Always own a full attribute set, so an empty first setStars([]) works.
    this.ensure(1);
  }

  indexOf(ticId: string) {
    return this.index.get(ticId) ?? -1;
  }
  has(ticId: string) {
    return this.index.has(ticId);
  }
  star(ticId: string) {
    const i = this.index.get(ticId);
    return i === undefined ? null : this.stars[i];
  }
  worldOf(ticId: string): Vector3 | null {
    const i = this.index.get(ticId);
    if (i === undefined) return null;
    const p = this.positions;
    return new Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  /** Pickable: loaded, not hidden and not shrunk to nothing. */
  visibleAt(i: number) {
    return i >= 0 && i < this.count && this.sizes[i] > 0.01;
  }
  sizeAt(i: number) {
    return this.sizes[i] ?? 0;
  }

  private ensure(count: number) {
    if (count <= this.capacity) return;
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(256, count)));
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.baseSizes = new Float32Array(capacity);
    this.twinkles = new Float32Array(capacity);
    const old = this.geometry;
    this.geometry = pointsGeometry(
      this.positions,
      this.colors,
      this.sizes,
      this.twinkles,
      40,
    );
    (this.geometry.getAttribute("aSize") as BufferAttribute).setUsage(
      DynamicDrawUsage,
    );
    this.points.geometry = this.geometry;
    old.dispose();
  }

  private style(star: Star): Style {
    let style = this.styles.get(star);
    if (!style) {
      try {
        style = starStyle(star);
      } catch {
        style = { rgb: [0.7, 0.75, 1], baseSize: 3.2 };
      }
      this.styles.set(star, style);
    }
    return style;
  }

  setStars(stars: readonly Star[]) {
    if (stars === this.stars && !this.decorative) return;
    this.decorative = false;
    this.stars = stars;
    this.ensure(stars.length);
    this.index.clear();
    const { positions, colors, baseSizes, twinkles } = this;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const style = this.style(s);
      const w = starWorld(s.x, s.y, s.depthZ);
      positions[i * 3] = w[0];
      positions[i * 3 + 1] = w[1];
      positions[i * 3 + 2] = w[2];
      colors[i * 3] = style.rgb[0];
      colors[i * 3 + 1] = style.rgb[1];
      colors[i * 3 + 2] = style.rgb[2];
      baseSizes[i] = style.baseSize;
      twinkles[i] = twinklePhase(s.layoutOrdinal);
      this.index.set(s.ticId, i);
    }
    this.count = stars.length;
    this.refreshSizes();
    for (const name of ["position", "aColor", "aTwinkle"]) {
      const attribute = this.geometry.getAttribute(name) as BufferAttribute;
      attribute.clearUpdateRanges();
      if (this.count)
        attribute.addUpdateRange(0, this.count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.count);
  }

  /** Stand-in spiral for the intro while no member data exists. */
  setDecorative(count = 1400) {
    if (this.decorative && this.count === count) return;
    const stars: Star[] = Array.from({ length: count }, (_, i) => ({
      ticId: `decor-${i}`,
      ...decorativeStar(i),
      planetCount: 0,
      progressStage: "unexplored",
      completedWithoutPlanets: false,
      marker: null,
      reopened: false,
    }));
    this.setStars(stars);
    this.decorative = true;
  }

  private sizeFor(i: number) {
    const tic = this.stars[i]?.ticId;
    if (tic === undefined) return 0;
    if (this.hidden.has(tic)) return 0;
    return this.baseSizes[i] * (this.scale.get(tic) ?? 1);
  }
  private refreshSizes() {
    for (let i = 0; i < this.count; i++) this.sizes[i] = this.sizeFor(i);
    const attribute = this.geometry.getAttribute("aSize") as BufferAttribute;
    attribute.clearUpdateRanges();
    if (this.count) attribute.addUpdateRange(0, this.count);
    attribute.needsUpdate = true;
  }
  private refreshOne(ticId: string) {
    const i = this.index.get(ticId);
    if (i === undefined) return;
    this.sizes[i] = this.sizeFor(i);
    const attribute = this.geometry.getAttribute("aSize") as BufferAttribute;
    attribute.addUpdateRange(i, 1);
    attribute.needsUpdate = true;
  }
  setHidden(ticId: string, hidden: boolean) {
    if (hidden === this.hidden.has(ticId)) return;
    if (hidden) this.hidden.add(ticId);
    else this.hidden.delete(ticId);
    this.refreshOne(ticId);
  }
  setScale(ticId: string, scale: number | null) {
    if (scale === null) this.scale.delete(ticId);
    else this.scale.set(ticId, Math.max(0, scale));
    this.refreshOne(ticId);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** A single extra star (ignition before the store has it). */
export class LoosePoint {
  readonly points: Points;
  private geometry: BufferGeometry;
  constructor(material: ShaderMaterial) {
    this.geometry = pointsGeometry(
      new Float32Array(3),
      new Float32Array([0.9, 0.85, 1]),
      new Float32Array(1),
      new Float32Array(1),
      1,
    );
    this.points = new Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 1;
  }
  set(position: Vector3, rgb: number[], size: number) {
    const p = this.geometry.getAttribute("position") as BufferAttribute;
    p.setXYZ(0, position.x, position.y, position.z);
    p.needsUpdate = true;
    const c = this.geometry.getAttribute("aColor") as BufferAttribute;
    c.setXYZ(0, rgb[0], rgb[1], rgb[2]);
    c.needsUpdate = true;
    this.size(size);
    this.points.visible = true;
  }
  size(size: number) {
    const s = this.geometry.getAttribute("aSize") as BufferAttribute;
    s.setX(0, size);
    s.needsUpdate = true;
  }
  hide() {
    this.points.visible = false;
  }
  dispose() {
    this.geometry.dispose();
  }
}

export function createDust() {
  const grains = dustGrains();
  const material = starMaterial(12);
  material.uniforms.uTwinkle.value = 0;
  const points = new Points(
    pointsGeometry(
      grains.position,
      grains.color,
      grains.size,
      new Float32Array(grains.size.length),
      16,
    ),
    material,
  );
  points.renderOrder = 0;
  return { points, material };
}

/** Far stars; the owner moves `points` with the camera every frame. */
export function createBackground() {
  const far = backgroundStars();
  const material = starMaterial(320);
  const twinkle = new Float32Array(far.size.length).map((_, i) =>
    twinklePhase(i + 7000),
  );
  const points = new Points(
    pointsGeometry(far.position, far.color, far.size, twinkle, 420),
    material,
  );
  points.frustumCulled = false;
  points.renderOrder = -1;
  return { points, material };
}

export function createNebula() {
  const puffs = nebulaPuffs();
  const base = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute("position", base.getAttribute("position"));
  const offset = new Float32Array(puffs.length * 3),
    scale = new Float32Array(puffs.length),
    color = new Float32Array(puffs.length * 3),
    alpha = new Float32Array(puffs.length);
  puffs.forEach((p, i) => {
    offset.set(p.position, i * 3);
    scale[i] = p.scale;
    color.set(p.color, i * 3);
    alpha[i] = p.alpha;
  });
  geometry.setAttribute("iOffset", new InstancedBufferAttribute(offset, 3));
  geometry.setAttribute("iScale", new InstancedBufferAttribute(scale, 1));
  geometry.setAttribute("iColor", new InstancedBufferAttribute(color, 3));
  geometry.setAttribute("iAlpha", new InstancedBufferAttribute(alpha, 1));
  geometry.instanceCount = puffs.length;
  const material = new ShaderMaterial({
    uniforms: { uBrightness: { value: 1 } },
    vertexShader: nebulaVertex,
    fragmentShader: nebulaFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return {
    mesh,
    material,
    dispose() {
      base.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
