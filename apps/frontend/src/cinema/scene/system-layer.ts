// One star system, drawn around the focused star. Orbits lie in the galaxy
// plane through the star; the camera supplies the real view's tilt (.67).
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Line,
  LinearSRGBColorSpace,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { ScenePlanet, SceneSystem } from "./contract";
import {
  GHOST_FLOOR,
  STAR_RADIUS,
  approach,
  clamp01,
  easeInOutCubic,
  ghostDisplayRadius,
  ghostOpacity,
  ghostScale,
  lerp,
  orbitAngle,
  orbitSlotRadius,
  orbitSpeed,
  planetBodyRadius,
} from "./math";
import {
  billboardVertex,
  bodyVertex,
  ghostFragment,
  glowFragment,
  orbitFragment,
  orbitVertex,
  planetFragment,
  sunFragment,
} from "./shaders";

/** Display colour exactly as written (no sRGB -> linear conversion). */
export const displayColor = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return new Color().setRGB(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    LinearSRGBColorSpace,
  );
};
export const ACCENT = "#5ec4f7";
export const BAD = "#f28b82";
export const ORBIT = "#8d99ad";
const ACCENT_COLOR = displayColor(ACCENT);
const BAD_COLOR = displayColor(BAD);

export function glowMaterial(
  core: [number, number, number],
  halo: [number, number, number],
  options: { sharpness?: number; falloff?: number; rays?: number } = {},
) {
  return new ShaderMaterial({
    uniforms: {
      uCore: { value: new Color().setRGB(...core, LinearSRGBColorSpace) },
      uHalo: { value: new Color().setRGB(...halo, LinearSRGBColorSpace) },
      uOpacity: { value: 1 },
      uCoreSharpness: { value: options.sharpness ?? 30 },
      uHaloFalloff: { value: options.falloff ?? 3 },
      uRays: { value: options.rays ?? 0 },
      uTime: { value: 0 },
    },
    vertexShader: billboardVertex,
    fragmentShader: glowFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

let circle: BufferGeometry | null = null;
/** Unit circle in the XZ plane with a 0..1 parameter for dashes. */
function unitCircle() {
  if (circle) return circle;
  const n = 256,
    position = new Float32Array((n + 1) * 3),
    u = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    position.set([Math.cos(a), 0, Math.sin(a)], i * 3);
    u[i] = i / n;
  }
  circle = new BufferGeometry();
  circle.setAttribute("position", new BufferAttribute(position, 3));
  circle.setAttribute("aU", new BufferAttribute(u, 1));
  return circle;
}
function orbitMaterial(hex: string, opacity: number, dashes: number) {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: displayColor(hex) },
      uOpacity: { value: opacity },
      uDashes: { value: dashes },
    },
    vertexShader: orbitVertex,
    fragmentShader: orbitFragment,
    transparent: true,
    depthWrite: false,
  });
}
function planetMaterial(seed: number) {
  return new ShaderMaterial({
    uniforms: {
      uSeed: { value: seed },
      uLight: { value: new Vector3() },
      uOpacity: { value: 1 },
    },
    vertexShader: bodyVertex,
    fragmentShader: planetFragment,
    transparent: true,
  });
}

type Body = {
  data: ScenePlanet;
  mesh: Mesh;
  material: ShaderMaterial;
  orbit: Line;
  orbitMaterial: ShaderMaterial;
  slot: number;
  radius: number;
  /** Eases to 0 so a new slot never makes the planet jump. */
  angleOffset: number;
  /**
   * Kept for good: a revealed planet goes on from where the transit left it,
   * instead of swinging round to its default place on the orbit.
   */
  phase: number;
  angle: number;
  opacity: number;
  targetOpacity: number;
  /** Shown by revealPlanet before the system data includes it. */
  revealed: boolean;
  reveal: null | {
    t0: number;
    ms: number;
    fromRadius: number;
    fromSize: number;
    done: () => void;
  };
};

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class SystemView {
  readonly root = new Group();
  private sphere = new SphereGeometry(1, 64, 40);
  private sun: Mesh;
  private sunMaterial: ShaderMaterial;
  private corona: Mesh;
  private coronaMaterial: ShaderMaterial;
  private halo: Mesh;
  private haloMaterial: ShaderMaterial;
  private quad = new PlaneGeometry(1, 1);
  private bodies = new Map<string, Body>();
  private ghostOrbit: Line;
  private ghostOrbitMaterial: ShaderMaterial;
  private ghost: Mesh;
  private ghostMaterial: ShaderMaterial;
  private birth: Mesh;
  private birthMaterial: ShaderMaterial;
  readonly transitBody: Mesh;
  readonly transitMaterial: ShaderMaterial;
  /** Birth flash; it rides on the revealed planet (`body`) when there is one. */
  private birthRun: {
    t0: number;
    ms: number;
    at: Vector3;
    body: string | null;
  } | null = null;
  /** Sun, corona and halo scale: smaller in analysis so the ghost orbit reads. */
  starScaleTarget = 1;
  private starScaleNow = 1;

  data: SceneSystem | null = null;
  ticId: string | null = null;
  hint: { periodDays: number; strength: number; selection: boolean } | null =
    null;
  ghostVisible = false;
  private ghostRadiusNow = 0;
  private ghostOpacityNow = 0;
  private ghostPlanetOpacity = 0;
  private ghostAngle = 0;
  private mismatch: { t0: number; ms: number } | null = null;
  /** Transit dimming, 1 = normal. */
  brightness = 1;
  seconds = 0;

  constructor() {
    this.root.visible = false;
    this.sunMaterial = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBright: { value: 1 } },
      vertexShader: bodyVertex,
      fragmentShader: sunFragment,
    });
    this.sun = new Mesh(this.sphere, this.sunMaterial);
    this.sun.scale.setScalar(STAR_RADIUS);
    this.sun.renderOrder = 2;
    this.coronaMaterial = glowMaterial([1, 0.88, 0.67], [1, 0.47, 0.16], {
      sharpness: 9,
      falloff: 3.2,
      rays: 0.35,
    });
    this.corona = new Mesh(this.quad, this.coronaMaterial);
    this.corona.scale.setScalar(STAR_RADIUS * 6.5);
    this.corona.renderOrder = 3;
    this.haloMaterial = glowMaterial([1, 0.7, 0.4], [1, 0.45, 0.2], {
      sharpness: 40,
      falloff: 5,
    });
    // Faint and not too wide: a wide additive halo browns the whole ground.
    this.haloMaterial.uniforms.uOpacity.value = 0.07;
    this.halo = new Mesh(this.quad, this.haloMaterial);
    this.halo.scale.setScalar(STAR_RADIUS * 13);
    this.halo.renderOrder = 3;
    this.ghostOrbitMaterial = orbitMaterial(ACCENT, 0, 0);
    this.ghostOrbit = new Line(unitCircle(), this.ghostOrbitMaterial);
    this.ghostOrbit.renderOrder = 4;
    this.ghostMaterial = new ShaderMaterial({
      uniforms: {
        uColor: { value: displayColor(ACCENT) },
        uOpacity: { value: 0 },
      },
      vertexShader: bodyVertex,
      fragmentShader: ghostFragment,
      transparent: true,
      depthWrite: false,
    });
    this.ghost = new Mesh(this.sphere, this.ghostMaterial);
    this.ghost.scale.setScalar(planetBodyRadius(0.5));
    this.ghost.renderOrder = 5;
    this.birthMaterial = glowMaterial([1, 1, 1], [0.37, 0.77, 0.97], {
      sharpness: 26,
      falloff: 3,
    });
    this.birthMaterial.uniforms.uOpacity.value = 0;
    this.birth = new Mesh(this.quad, this.birthMaterial);
    this.birth.visible = false;
    this.birth.renderOrder = 6;
    this.transitMaterial = planetMaterial(0.5);
    this.transitBody = new Mesh(this.sphere, this.transitMaterial);
    this.transitBody.visible = false;
    this.transitBody.renderOrder = 2;
    this.root.add(
      this.sun,
      this.halo,
      this.corona,
      this.ghostOrbit,
      this.ghost,
      this.birth,
      this.transitBody,
    );
  }

  /** The star this view is centred on (the system may still be loading). */
  focus(ticId: string | null, world: Vector3 | null) {
    if (ticId !== this.ticId) {
      for (const id of [...this.bodies.keys()]) this.removeBody(id);
      this.ticId = ticId;
      this.hint = null;
      this.ghostOpacityNow = 0;
      this.ghostPlanetOpacity = 0;
      this.transitBody.visible = false;
    }
    if (world) this.root.position.copy(world);
    this.syncPlanets(true);
  }

  setData(system: SceneSystem | null) {
    this.data = system;
    this.syncPlanets(false);
  }

  /** Planets drawn: the focused star's data plus any not-yet-saved reveal. */
  private syncPlanets(instant: boolean) {
    const planets =
      this.data && this.data.ticId === this.ticId ? this.data.planets : [];
    const seen = new Set<string>();
    planets.forEach((planet, slot) => {
      seen.add(planet.candidateId);
      const body =
        this.bodies.get(planet.candidateId) ?? this.addBody(planet, slot);
      this.retarget(body, planet, slot, instant);
      body.revealed = false;
    });
    let extra = planets.length;
    for (const [id, body] of this.bodies) {
      if (seen.has(id)) continue;
      if (body.revealed && body.targetOpacity > 0)
        this.retarget(body, body.data, extra++, instant);
      else body.targetOpacity = 0;
    }
  }

  private retarget(
    body: Body,
    data: ScenePlanet,
    slot: number,
    instant: boolean,
  ) {
    const before = body.angle;
    body.data = data;
    body.targetOpacity = 1;
    body.orbitMaterial.uniforms.uDashes.value =
      data.kind === "unconfirmed" ? 32 : 0;
    body.material.uniforms.uSeed.value = data.seed;
    if (body.slot !== slot) {
      body.slot = slot;
      if (!instant && body.opacity > 0)
        body.angleOffset = wrap(
          before -
            orbitAngle(slot, data.seed, data.periodDays, this.seconds) -
            body.phase,
        );
    }
    if (instant) {
      body.radius = orbitSlotRadius(slot);
      body.opacity = 1;
      body.angleOffset = 0;
    }
  }

  private addBody(data: ScenePlanet, slot: number): Body {
    const material = planetMaterial(data.seed);
    const mesh = new Mesh(this.sphere, material);
    mesh.scale.setScalar(planetBodyRadius(data.seed));
    mesh.renderOrder = 2;
    const orbitMat = orbitMaterial(
      ORBIT,
      0,
      data.kind === "unconfirmed" ? 32 : 0,
    );
    const orbit = new Line(unitCircle(), orbitMat);
    orbit.renderOrder = 1;
    this.root.add(orbit, mesh);
    const body: Body = {
      data,
      mesh,
      material,
      orbit,
      orbitMaterial: orbitMat,
      slot,
      radius: orbitSlotRadius(slot),
      angleOffset: 0,
      phase: 0,
      angle: orbitAngle(slot, data.seed, data.periodDays, this.seconds),
      opacity: 0,
      targetOpacity: 1,
      revealed: false,
      reveal: null,
    };
    this.bodies.set(data.candidateId, body);
    return body;
  }

  private removeBody(id: string) {
    const body = this.bodies.get(id);
    if (!body) return;
    body.reveal?.done();
    this.root.remove(body.mesh, body.orbit);
    body.material.dispose();
    body.orbitMaterial.dispose();
    this.bodies.delete(id);
  }

  /** Ghost scale anchored on the orbits already drawn (Kepler, r ~ P^2/3). */
  private ghostK() {
    const list = [...this.bodies.values()].filter((b) => b.targetOpacity > 0);
    return ghostScale(
      list.map((b) => ({
        periodDays: b.data.periodDays,
        radius: orbitSlotRadius(b.slot),
      })),
      orbitSlotRadius(list.length),
    );
  }
  ghostRadiusFor(periodDays: number) {
    return ghostDisplayRadius(
      periodDays,
      this.ghostK(),
      GHOST_FLOOR,
      this.ghostMaxRadius,
    );
  }
  /** Widest ghost orbit (the clamp of ghostRadiusFor). */
  get ghostMaxRadius() {
    const count = [...this.bodies.values()].filter(
      (b) => b.targetOpacity > 0,
    ).length;
    return orbitSlotRadius(Math.max(1, count) + 3);
  }
  /** Drawn star radius (analysis shows a smaller star). */
  get starRadiusShown() {
    return STAR_RADIUS * this.starScaleNow;
  }
  get planetCount() {
    let n = 0;
    for (const b of this.bodies.values()) if (b.targetOpacity > 0) n++;
    return n;
  }

  planetIds() {
    return [...this.bodies.values()]
      .filter((b) => b.targetOpacity > 0)
      .map((b) => b.data.candidateId);
  }
  hasPlanet(id: string) {
    const b = this.bodies.get(id);
    return !!b && b.targetOpacity > 0;
  }
  planetWorld(id: string, out = new Vector3()) {
    const body = this.bodies.get(id);
    if (!body) return null;
    return body.mesh.getWorldPosition(out);
  }
  planetRadiusWorld(id: string) {
    const body = this.bodies.get(id);
    return body ? body.mesh.scale.x * this.root.scale.x : 0;
  }
  ghostWorld(out = new Vector3()) {
    if (this.ghostPlanetOpacity < 0.02 && this.ghostOpacityNow < 0.02)
      return null;
    return this.ghost.getWorldPosition(out);
  }
  pickTargets() {
    return [...this.bodies.values()]
      .filter((b) => b.targetOpacity > 0 && b.opacity > 0.3)
      .map((b) => ({
        id: b.data.candidateId,
        world: b.mesh.getWorldPosition(new Vector3()),
        radius: this.planetRadiusWorld(b.data.candidateId),
      }));
  }

  /**
   * The discovered planet takes over from the transit body: it starts where
   * the transit left off (same place, size and direction of travel), the
   * birth flash sits on it, and it glides into its slot while it keeps
   * orbiting.
   */
  reveal(
    planet: ScenePlanet,
    from: { radius: number; angle: number; size: number } | null,
    ms: number,
    now: number,
  ) {
    return new Promise<void>((resolve) => {
      const found = this.bodies.get(planet.candidateId);
      const existing = !!found && found.targetOpacity > 0;
      const body = found ?? this.addBody(planet, this.planetCount);
      body.revealed = !existing || body.revealed;
      body.targetOpacity = 1;
      this.syncPlanets(false);
      const start = from ?? {
        radius: this.ghostRadiusFor(planet.periodDays ?? 10),
        angle: body.angle,
        size: planetBodyRadius(planet.seed),
      };
      body.reveal?.done();
      body.opacity = 1;
      // From here on its orbit runs through the transit's end point.
      body.phase = wrap(
        start.angle -
          orbitAngle(
            body.slot,
            body.data.seed,
            body.data.periodDays,
            this.seconds,
          ),
      );
      body.angleOffset = 0;
      body.angle = start.angle;
      body.radius = start.radius;
      body.mesh.position.set(
        Math.cos(start.angle) * start.radius,
        0,
        Math.sin(start.angle) * start.radius,
      );
      body.mesh.scale.setScalar(start.size);
      body.reveal = {
        t0: now,
        ms,
        fromRadius: start.radius,
        fromSize: start.size,
        done: () => {
          if (body.reveal) body.reveal = null;
          resolve();
        },
      };
      this.birthRun = {
        t0: now,
        ms: Math.max(ms, 1),
        at: body.mesh.position.clone(),
        body: planet.candidateId,
      };
      if (ms <= 0) {
        body.radius = orbitSlotRadius(body.slot);
        body.reveal.done();
      }
    });
  }

  pulseMismatch(now: number, ms: number) {
    this.mismatch = { t0: now, ms };
  }

  update(now: number, dt: number, reduced: boolean, lightWorld: Vector3) {
    if (!reduced) this.seconds += dt;
    const orbitSeconds = reduced ? 0 : this.seconds;
    const t = reduced ? 0 : now / 1000;
    this.sunMaterial.uniforms.uTime.value = t;
    this.coronaMaterial.uniforms.uTime.value = t;
    if (!reduced) this.sun.rotation.y += dt * 0.05;
    this.starScaleNow = reduced
      ? this.starScaleTarget
      : lerp(this.starScaleNow, this.starScaleTarget, approach(3, dt));
    if (Math.abs(this.starScaleNow - this.starScaleTarget) < 1e-3)
      this.starScaleNow = this.starScaleTarget;
    const scale = this.starScaleNow;
    this.sun.scale.setScalar(STAR_RADIUS * scale);
    this.corona.scale.setScalar(STAR_RADIUS * 6.5 * scale);
    this.halo.scale.setScalar(STAR_RADIUS * 13 * scale);
    this.sunMaterial.uniforms.uBright.value = this.brightness;
    this.coronaMaterial.uniforms.uOpacity.value =
      0.78 * Math.max(0, 1 - (1 - this.brightness) * 1.1);
    this.transitMaterial.uniforms.uLight.value.copy(lightWorld);

    for (const [id, body] of this.bodies) {
      const follow = reduced ? 1 : approach(3, dt);
      body.opacity = reduced
        ? body.targetOpacity
        : lerp(body.opacity, body.targetOpacity, approach(4, dt));
      if (body.targetOpacity === 0 && body.opacity < 0.01) {
        this.removeBody(id);
        continue;
      }
      body.angleOffset = reduced
        ? 0
        : body.angleOffset * (1 - approach(1.6, dt));
      const target = orbitSlotRadius(body.slot);
      const angle =
        orbitAngle(
          body.slot,
          body.data.seed,
          body.data.periodDays,
          orbitSeconds,
        ) +
        body.phase +
        body.angleOffset;
      let radius = lerp(body.radius, target, follow);
      let size = planetBodyRadius(body.data.seed);
      const r = body.reveal;
      if (r) {
        const k = r.ms > 0 ? clamp01((now - r.t0) / r.ms) : 1;
        const e = easeInOutCubic(k);
        radius = lerp(r.fromRadius, target, e);
        size = lerp(r.fromSize, size, e);
        if (k >= 1) r.done();
      }
      body.radius = radius;
      body.angle = angle;
      body.mesh.position.set(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius,
      );
      body.mesh.scale.setScalar(size);
      if (!reduced) body.mesh.rotation.y += dt * 0.35;
      body.material.uniforms.uOpacity.value = body.opacity;
      body.material.uniforms.uLight.value.copy(lightWorld);
      body.material.depthWrite = body.opacity > 0.98;
      body.orbit.scale.setScalar(target);
      body.orbitMaterial.uniforms.uOpacity.value = 0.3 * body.opacity;
    }

    // Ghost orbit: radius follows the period, opacity the peak strength.
    const hint = this.ghostVisible ? this.hint : null;
    const mismatch = this.mismatch;
    const pulse = mismatch ? clamp01((now - mismatch.t0) / mismatch.ms) : 1;
    if (mismatch && pulse >= 1) this.mismatch = null;
    const rate = reduced ? 1 : approach(8, dt);
    if (hint) {
      const radius = this.ghostRadiusFor(hint.periodDays);
      this.ghostRadiusNow =
        this.ghostRadiusNow > 0 && !reduced
          ? lerp(this.ghostRadiusNow, radius, approach(10, dt))
          : radius;
      this.ghostOpacityNow = lerp(
        this.ghostOpacityNow,
        ghostOpacity(hint.strength),
        rate,
      );
      this.ghostPlanetOpacity = lerp(
        this.ghostPlanetOpacity,
        hint.selection ? 0.55 : 0,
        reduced ? 1 : approach(6, dt),
      );
      if (!reduced) this.ghostAngle += dt * orbitSpeed(hint.periodDays);
    } else {
      this.ghostOpacityNow = lerp(this.ghostOpacityNow, 0, rate);
      this.ghostPlanetOpacity = lerp(this.ghostPlanetOpacity, 0, rate);
      if (this.ghostRadiusNow <= 0)
        this.ghostRadiusNow = orbitSlotRadius(this.planetCount);
    }
    let orbitOpacity = this.ghostOpacityNow;
    const color = this.ghostOrbitMaterial.uniforms.uColor.value as Color;
    if (this.mismatch) {
      color.copy(BAD_COLOR);
      const beat = reduced
        ? 1
        : 0.3 + 0.7 * Math.abs(Math.sin((now - this.mismatch.t0) / 60));
      orbitOpacity = Math.max(0.55, orbitOpacity) * beat;
    } else color.copy(ACCENT_COLOR);
    this.ghostOrbit.visible = orbitOpacity > 0.004;
    this.ghostOrbit.scale.setScalar(Math.max(1e-4, this.ghostRadiusNow));
    this.ghostOrbitMaterial.uniforms.uOpacity.value = orbitOpacity;
    this.ghost.visible = this.ghostPlanetOpacity > 0.004;
    this.ghost.position.set(
      Math.cos(this.ghostAngle) * this.ghostRadiusNow,
      0,
      Math.sin(this.ghostAngle) * this.ghostRadiusNow,
    );
    this.ghostMaterial.uniforms.uOpacity.value = this.ghostPlanetOpacity;

    const birth = this.birthRun;
    if (birth) {
      const k = clamp01((now - birth.t0) / birth.ms);
      this.birth.visible = k < 1;
      const on = birth.body ? this.bodies.get(birth.body) : null;
      this.birth.position.copy(on ? on.mesh.position : birth.at);
      const s = STAR_RADIUS * (0.6 + 4.5 * easeInOutCubic(k));
      this.birth.scale.setScalar(s);
      this.birthMaterial.uniforms.uOpacity.value = reduced
        ? 0.8 * (1 - k)
        : (1 - k) * (1 - k);
      if (k >= 1) this.birthRun = null;
    } else this.birth.visible = false;
  }

  /** Ghost orbit radius as last drawn (for the transit pass). */
  get ghostRadiusShown() {
    return this.ghostRadiusNow;
  }

  clear() {
    for (const id of [...this.bodies.keys()]) this.removeBody(id);
    this.ticId = null;
    this.hint = null;
    this.ghostVisible = false;
    this.ghostOpacityNow = 0;
    this.ghostPlanetOpacity = 0;
    this.transitBody.visible = false;
    this.birthRun = null;
    this.brightness = 1;
  }

  dispose() {
    this.clear();
    this.sphere.dispose();
    this.quad.dispose();
    for (const m of [
      this.sunMaterial,
      this.coronaMaterial,
      this.haloMaterial,
      this.ghostOrbitMaterial,
      this.ghostMaterial,
      this.birthMaterial,
      this.transitMaterial,
    ])
      m.dispose();
  }
}

export function disposeSharedGeometry() {
  circle?.dispose();
  circle = null;
}
