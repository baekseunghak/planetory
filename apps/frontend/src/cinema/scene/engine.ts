// The cinema scene engine: one WebGLRenderer on one canvas for the app's
// lifetime. Loaded lazily by SceneCanvas (keeps three.js out of the first
// chunk). Implements the frozen SceneController contract.
import {
  DoubleSide,
  HalfFloatType,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  NoToneMapping,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { SkyMeta, Star } from "../../features/sky-data/contracts";
import { starStyle } from "../../features/sky-renderer/model";
import { galaxyExposure } from "../../features/sky-renderer/exposure";
import {
  SCENE_TIMING,
  type AnalysisHint,
  type HomeFrame,
  type IgniteTarget,
  type PlanetPointer,
  type PlanetReveal,
  type SceneController,
  type SceneError,
  type SceneFrame,
  type SceneMode,
  type SceneState,
  type SceneSystem,
  type ScreenPoint,
  type StarPointer,
  type TransitRequest,
  type Unsubscribe,
  type ViewInset,
} from "./contract";
import { CameraRig, clonePose, type Pose } from "./camera-rig";
import {
  LoosePoint,
  StarField,
  createBackground,
  createDust,
  createNebula,
  starMaterial,
} from "./galaxy-layer";
import {
  ANALYSIS_STAR_SCALE,
  CLICK_SLOP_PX,
  DEFAULT_VIEW,
  GHOST_PLANET_ID,
  HOME_DISTANCE,
  HOVER_RADIUS_PX,
  STAR_RADIUS,
  SYSTEM_VIEW,
  approach,
  boundsCenter,
  boundsFramePoints,
  cameraBasis,
  densityBloom,
  densityScale,
  clamp,
  clamp01,
  coveredFraction,
  easeInOutCubic,
  easeOutCubic,
  fitDistance,
  fitPointsInView,
  focalPx,
  lerp,
  orbitSlotRadius,
  pickCircle,
  pickNearest,
  planetBodyRadius,
  projectPoint,
  starHitRadius,
  starPointCss,
  starWorld,
  systemRadius,
  transitBrightness,
  transitCoverage,
  transitFlux,
  transitHalfAngle,
  transitPlanetRadius,
  transitTheta,
  viewDirection,
  type Bounds,
  type Vec3,
} from "./math";
import {
  ACCENT,
  SystemView,
  disposeSharedGeometry,
  displayColor,
  glowMaterial,
} from "./system-layer";
import { ditherShader, ringFragment, ringVertex } from "./shaders";
import {
  POWER_DPR,
  POWER_SLOW_MESSAGE,
  PowerMonitor,
  driftInterval,
  effectsFor,
  rememberPower,
  startingPower,
  type PowerAction,
  type PowerTier,
} from "./power";

/** Behind a page this long at rest, the last frame stays as the backdrop. */
const FREEZE_AFTER_MS = 1200;

/** The GPU's name, or "" when the browser hides it. */
function rendererName(renderer: WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(
      gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "",
    );
  } catch {
    return "";
  }
}
const DEFAULT_BOUNDS: Bounds = {
  minX: -1250,
  maxX: 1250,
  minY: -1250,
  maxY: 1250,
};
const UP = new Vector3(0, 1, 0);
const toV = (v: Vec3) => new Vector3(v[0], v[1], v[2]);
/** How far apart two poses are, relative to the first one's view distance. */
const poseGap = (a: Pose, b: Pose) =>
  Math.max(a.position.distanceTo(b.position), a.target.distanceTo(b.target)) /
  Math.max(1e-6, a.position.distanceTo(a.target));
const LOOK = {
  galaxy: 1,
  intro: 1,
  backdrop: 0.42,
  system: 0.78,
  analysis: 0.72,
  transit: 0.4,
};
/**
 * Nebula and dust per mode. Inside a system (and above all edge-on, in the
 * transit) the whole disc lines up behind the star and its haze would wash
 * the frame out; only point stars stay there.
 */
const HAZE = {
  galaxy: 1,
  intro: 1,
  backdrop: 0.8,
  system: 0.3,
  analysis: 0.25,
  transit: 0,
};
const BLOOM = {
  galaxy: 0.75,
  intro: 0.8,
  backdrop: 0.45,
  system: 0.32,
  analysis: 0.3,
  transit: 0.14,
};
/** Cap on point growth near the camera: close neighbours stay points in a system. */
const ATTENUATION = {
  galaxy: 6,
  intro: 6,
  backdrop: 6,
  system: 2.2,
  analysis: 2.2,
  transit: 1.6,
};

type Listener<T> = Set<(value: T) => void>;
type Waiter = {
  ticId: string;
  resolve: (world: Vector3 | null) => void;
  timer: number;
  /** The camera move that waits; a newer move lets it go at once. */
  token?: number;
};
type TransitRun = {
  request: TransitRequest;
  token: number;
  t0: number;
  ms: number;
  orbit: number;
  planet: number;
  half: number;
  back: Vector3;
  right: Vector3;
  settle: () => void;
  staticHold: boolean;
};
type IgniteRun = {
  ticId: string;
  world: Vector3;
  rgb: number[];
  baseSize: number;
  t0: number;
  ms: number;
  loose: boolean;
  settle: () => void;
};

const reducedQuery = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)");
  } catch {
    return null;
  }
};

function safeCall<T>(fn: (value: T) => void, value: T) {
  try {
    fn(value);
  } catch (error) {
    console.error("[scene] listener failed", error);
  }
}

export class SceneEngine implements SceneController {
  private state: SceneState;
  private stateListeners = new Set<() => void>();
  private frameListeners: Listener<SceneFrame> = new Set();
  private readyListeners: Listener<void> = new Set();
  private errorListeners: Listener<SceneError> = new Set();
  private hoverListeners: Listener<StarPointer | null> = new Set();
  private clickListeners: Listener<StarPointer> = new Set();
  private planetListeners: Listener<PlanetPointer> = new Set();

  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  // Created in build(); the constructor fails as a whole if any of them throws.
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private scene = new Scene();
  private rig!: CameraRig;
  private stars!: StarField;
  private loose!: LoosePoint;
  private looseMaterial!: ShaderMaterial;
  private dust!: ReturnType<typeof createDust>;
  private background!: ReturnType<typeof createBackground>;
  private nebula!: ReturnType<typeof createNebula>;
  private system = new SystemView();
  private flash!: Mesh;
  private flashMaterial!: ShaderMaterial;
  private ring!: Mesh;
  private ringMaterial!: ShaderMaterial;
  private quad = new PlaneGeometry(1, 1);

  private realStars: readonly Star[] = [];
  private systemData: SceneSystem | null = null;
  private hint: AnalysisHint | null = null;
  private galaxyPose: Pose | null = null;
  private overviewDistance = 30;
  private placedFor: string | null = null;
  private userMoved = false;
  private grow = 0;
  private look = 1;
  private haze = 1;
  /** Token of the running reframe dolly, so a newer inset can replace it. */
  private reframeToken = -1;
  /** System radius the camera distance was last fitted to. */
  private framedRadius = 0;
  private reframeTimer = 0;
  /** Host laid out at zero size (desktop gate): nothing to draw. */
  private hostHidden = false;
  private warmed = false;
  private tokenValue = 0;
  /**
   * Latest camera move. Setting it (every `++this.token`) releases stars a
   * superseded move was still waiting for, so the scene is not left busy for
   * the full wait on a star that will not come (a locked or unknown TIC).
   */
  private get token() {
    return this.tokenValue;
  }
  private set token(value: number) {
    this.tokenValue = value;
    if (!this.waiters?.length) return;
    this.waiters = this.waiters.filter((w) => {
      if (w.token === undefined || w.token === value) return true;
      clearTimeout(w.timer);
      w.resolve(null);
      return false;
    });
  }
  private jobs = 0;
  private instant = false;
  private waiters: Waiter[] = [];
  private settles = new Set<() => void>();
  private transit: TransitRun | null = null;
  private parked: {
    until: number;
    radius: number;
    angle: number;
    size: number;
  } | null = null;
  private ignition: IgniteRun | null = null;
  private pendingIgnite = new Set<string>();
  private viewProjection = new Matrix4();
  private raf = 0;
  private last = 0;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private sizeDirty = true;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private lost = false;
  private lossCount = 0;
  private lossTimer = 0;
  private pointer = { x: 0, y: 0, inside: false };
  private down: { x: number; y: number; t: number; moved: boolean } | null =
    null;
  private hoverTic: string | null = null;
  private hoverDirty = false;
  private frameCount = 0;
  private media = reducedQuery();
  /**
   * Render cost tier (./power.ts). `low` renders straight to the canvas at
   * a low pixel ratio with no bloom, nebula or dust unless the member turns
   * the effects on: the full path runs at 2 to 3 frames a second on
   * software WebGL and holds up every click on the page.
   */
  private tier: PowerTier = "full";
  /** Software WebGL: no MSAA and no shader warm-up. */
  private software = false;
  /** `?power=` pin for a demo: the frame-rate watch never steps down. */
  private pinned = false;
  /** The member's explicit effects choice; null = the tier decides. */
  private effectsChoice: boolean | null = null;
  private monitor = new PowerMonitor();
  private monitoredMode: SceneMode | null = null;
  /** Behind a page and at rest since (ms); 0 = not. */
  private stillSince = 0;
  private frozen = false;
  /** Newly unlocked stars kept hidden until their ignition (holdStars). */
  private held = new Set<string>();

  constructor(private host: HTMLElement) {
    this.state = {
      mode: "galaxy",
      ready: false,
      failed: null,
      focusedTicId: null,
      focusedPlanetId: null,
      effects: true,
      reducedMotion: this.media?.matches ?? false,
      busy: false,
      power: "full",
    };
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.scene = "engine";
    canvas.style.cssText =
      "display:block;width:100%;height:100%;touch-action:none;outline:none";
    this.canvas = canvas;
    host.appendChild(canvas);
    try {
      this.renderer = new WebGLRenderer({
        canvas,
        antialias: false,
        alpha: false,
        stencil: false,
        powerPreference: "high-performance",
      });
    } catch (error) {
      canvas.remove();
      throw error;
    }
    const start = startingPower(
      typeof location === "undefined" ? "" : location.search,
      rendererName(this.renderer),
    );
    this.software = start.software;
    this.pinned = start.pinned;
    this.tier = start.level === "list" ? "low" : start.level;
    canvas.dataset.power = this.tier;
    canvas.dataset.frozen = "false";
    this.state = {
      ...this.state,
      effects: effectsFor(this.tier, null),
      power: this.tier,
    };
    try {
      this.build(canvas);
    } catch (error) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      canvas.remove();
      throw error;
    }
    // Kept from an earlier page of this tab (or pinned): straight to the list.
    if (start.level === "list")
      queueMicrotask(() => this.fail(POWER_SLOW_MESSAGE));
  }

  private build(canvas: HTMLCanvasElement) {
    const host = this.host;
    const r = this.renderer;
    r.outputColorSpace = LinearSRGBColorSpace;
    r.toneMapping = NoToneMapping;
    r.setClearColor(0x000000, 1);
    r.debug.onShaderError = (gl, program, vertex, fragment) => {
      console.error(
        "[scene] shader error",
        gl.getProgramInfoLog(program),
        gl.getShaderInfoLog(vertex),
        gl.getShaderInfoLog(fragment),
      );
      this.fail("장면 셰이더를 만들지 못했습니다.");
    };
    this.pixelRatio = this.targetRatio();
    r.setPixelRatio(this.pixelRatio);
    this.rig = new CameraRig(canvas);
    this.rig.roll = DEFAULT_VIEW.roll;
    this.rig.controls.addEventListener("start", () => {
      this.userMoved = true;
    });

    const samples =
      !this.software &&
      this.tier !== "low" &&
      r.capabilities.maxSamples >= 4 &&
      r.extensions.has("EXT_color_buffer_float")
        ? 4
        : 0;
    this.composer = new EffectComposer(
      r,
      new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples }),
    );
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new UnrealBloomPass(
      new Vector2(256, 256),
      BLOOM.galaxy,
      0.5,
      0.18,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // Dark glow and bloom gradients band in 8-bit output without it.
    this.composer.addPass(new ShaderPass(ditherShader));

    this.stars = new StarField(30);
    this.looseMaterial = starMaterial(30);
    this.loose = new LoosePoint(this.looseMaterial);
    this.dust = createDust();
    this.background = createBackground();
    this.nebula = createNebula();
    this.flashMaterial = glowMaterial([1, 1, 1], [0.37, 0.77, 0.97], {
      sharpness: 22,
      falloff: 2.6,
    });
    this.flashMaterial.uniforms.uOpacity.value = 0;
    this.flash = new Mesh(this.quad, this.flashMaterial);
    this.flash.visible = false;
    this.flash.renderOrder = 7;
    this.ringMaterial = new ShaderMaterial({
      uniforms: {
        uColor: { value: displayColor(ACCENT) },
        uOpacity: { value: 0 },
      },
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.ring = new Mesh(this.quad, this.ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 7;
    this.scene.add(
      this.background.points,
      this.nebula.mesh,
      this.dust.points,
      this.stars.points,
      this.loose.points,
      this.system.root,
      this.ring,
      this.flash,
    );
    if (!this.state.effects) {
      this.bloom.enabled = false;
      this.nebula.mesh.visible = false;
      this.dust.points.visible = false;
    }
    this.applyBounds(DEFAULT_BOUNDS);
    this.rig.place(this.homePose());
    this.applyControls();
    // Real size now, not on the first frame: a move replayed at attach (a
    // direct link to /sky?star=) frames its pose from the view size, and a
    // 1x1 view put the camera so far out that the galaxy showed instead.
    this.resize();

    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    canvas.addEventListener(
      "webglcontextrestored",
      this.onContextRestored,
      false,
    );
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.media?.addEventListener?.("change", this.onMotionChange);
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.sizeDirty = true;
        const box = entries[entries.length - 1]?.contentRect;
        if (box) this.hostHidden = box.width < 1 || box.height < 1;
      });
      this.resizeObserver.observe(host);
    }
    window.addEventListener("resize", this.onWindowResize);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- state

  getState = () => this.state;
  subscribe = (listener: () => void): Unsubscribe => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };
  private set(patch: Partial<SceneState>) {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof SceneState)[])
      if (this.state[key] !== patch[key]) changed = true;
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.stateListeners])
      safeCall(listener, undefined);
  }
  private get reduced() {
    return this.state.reducedMotion;
  }
  private ms(duration: number, instant = this.instant) {
    return instant || this.reduced || this.state.failed ? 0 : duration;
  }
  private get now() {
    return performance.now();
  }
  /** Busy while any flight or effect runs. Never rejects. */
  private track(work: Promise<unknown>): Promise<void> {
    this.jobs++;
    this.set({ busy: true });
    return work
      .then(
        () => undefined,
        (error) => console.error("[scene]", error),
      )
      .finally(() => {
        this.jobs = Math.max(0, this.jobs - 1);
        if (!this.jobs) this.set({ busy: false });
      });
  }
  /** A promise that also resolves on dispose/failure and after `watchdog` ms. */
  private settleable(watchdog: number, start: (settle: () => void) => void) {
    return new Promise<void>((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        this.settles.delete(settle);
        clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(settle, watchdog);
      this.settles.add(settle);
      start(settle);
    });
  }

  // ---------------------------------------------------------------- data

  setStars(stars: readonly Star[], meta: SkyMeta) {
    this.realStars = stars;
    if (stars.length) this.stars.setStars(stars);
    else if (this.state.mode === "intro") this.stars.setDecorative();
    else this.stars.setStars(stars);
    for (const tic of this.pendingIgnite) this.stars.setHidden(tic, true);
    for (const tic of this.held) this.stars.setHidden(tic, true);
    this.wake();
    // A large sky arrives in pages; rebuilding and uploading the buffers is
    // loading work, not the frame rate the tier is judged on.
    this.monitor.hold(performance.now());
    this.applyBounds(meta.starCount > 0 ? meta.bounds : DEFAULT_BOUNDS);
    const key = `${meta.version}:${meta.starCount > 0}`;
    if (
      this.placedFor === null &&
      !this.userMoved &&
      !this.rig.flying &&
      stars.length
    ) {
      this.placedFor = key;
      if (this.state.mode === "galaxy") this.rig.place(this.homePose());
      else if (this.state.mode === "intro") this.rig.place(this.introPose());
    }
    // An ignited star shown on its own point hands over once the store has it.
    if (!this.ignition && this.looseTic && this.stars.has(this.looseTic)) {
      this.loose.hide();
      this.looseTic = null;
    }
    this.checkWaiters();
    if (this.state.focusedTicId && !this.systemData) {
      const world = this.stars.worldOf(this.state.focusedTicId);
      if (world && this.system.ticId === this.state.focusedTicId)
        this.system.root.position.copy(world);
    }
  }
  private looseTic: string | null = null;
  private looseWorld = new Vector3();

  setSystem(system: SceneSystem | null) {
    const before = this.system.planetCount;
    this.systemData = system;
    this.system.setData(system);
    if (
      system &&
      system.ticId === this.state.focusedTicId &&
      !this.stars.has(system.ticId)
    )
      this.system.root.position.copy(this.positionOfSystem(system));
    this.checkWaiters();
    if (
      this.system.planetCount !== before &&
      this.systemOpen &&
      !this.state.focusedPlanetId &&
      !this.rig.flying &&
      !this.transit
    )
      void this.reframe(900);
  }

  private positionOfSystem(system: SceneSystem) {
    const p = system.position;
    return toV(starWorld(p.x, p.y, p.depthZ));
  }
  private worldOf(ticId: string): Vector3 | null {
    const fromStars = this.stars.decorative ? null : this.stars.worldOf(ticId);
    if (fromStars) return fromStars;
    if (this.systemData?.ticId === ticId)
      return this.positionOfSystem(this.systemData);
    return null;
  }
  private checkWaiters() {
    this.waiters = this.waiters.filter((w) => {
      const world = this.worldOf(w.ticId);
      if (!world) return true;
      clearTimeout(w.timer);
      w.resolve(world);
      return false;
    });
  }
  private waitForStar(
    ticId: string,
    timeout = 10000,
    token?: number,
  ): Promise<Vector3 | null> {
    const world = this.worldOf(ticId);
    if (world) return Promise.resolve(world);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        ticId,
        resolve,
        token,
        timer: window.setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeout),
      };
      this.waiters.push(waiter);
    });
  }

  private applyBounds(bounds: Bounds) {
    const view = this.rig.targetView();
    const back = viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt);
    this.overviewDistance = Math.max(
      2,
      fitDistance(
        boundsFramePoints(bounds),
        boundsCenter(bounds),
        cameraBasis(back, DEFAULT_VIEW.roll),
        focalPx(view.height),
        view.free.width,
        view.free.height,
        0.84,
      ),
    );
    this.bounds = bounds;
    for (const m of [this.stars.material, this.looseMaterial])
      m.uniforms.uRef.value = this.overviewDistance;
    this.dust.material.uniforms.uRef.value = this.overviewDistance * 0.5;
  }
  private bounds: Bounds = DEFAULT_BOUNDS;

  // ---------------------------------------------------------------- poses

  private overviewPose(): Pose {
    const target = toV(boundsCenter(this.bounds));
    const back = toV(viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt));
    return {
      position: target.clone().addScaledVector(back, this.overviewDistance),
      target,
      roll: DEFAULT_VIEW.roll,
    };
  }
  /**
   * Behind the login: far out, lower and turned aside, so the fly-in after
   * sign-in sweeps round and rises to the home framing instead of pushing
   * straight in.
   */
  private introPose(): Pose {
    const target = toV(boundsCenter(this.bounds));
    const back = toV(
      viewDirection(DEFAULT_VIEW.yaw + 0.7, DEFAULT_VIEW.tilt + 0.22),
    );
    return {
      position: target
        .clone()
        .addScaledVector(back, this.overviewDistance * 2.8),
      target,
      roll: DEFAULT_VIEW.roll * 0.4,
    };
  }
  /**
   * Where the galaxy rests: the overview, a little closer (arms to the
   * edges), then moved just enough to keep the framed stars in view.
   */
  private homePose(): Pose {
    const pose = this.overviewPose();
    pose.position
      .sub(pose.target)
      .multiplyScalar(HOME_DISTANCE)
      .add(pose.target);
    return this.keepFramed(pose);
  }
  /** Stars the home pose keeps in view (setHomeFrame), margins resolved. */
  private homeFrame: {
    ticIds: string[];
    margin: { top: number; right: number; bottom: number; left: number };
  } | null = null;
  setHomeFrame(frame: HomeFrame | null) {
    const ids = Array.isArray(frame?.ticIds)
      ? frame.ticIds.filter(
          (tic): tic is string => typeof tic === "string" && !!tic,
        )
      : [];
    if (!frame || !ids.length) {
      this.homeFrame = null;
      return;
    }
    const px = (value: number | undefined) =>
      Number.isFinite(value) ? Math.max(0, value as number) : 0;
    const m = frame.margin ?? { right: 0, bottom: 0 };
    this.homeFrame = {
      ticIds: ids,
      margin: {
        top: px(m.top),
        right: px(m.right),
        bottom: px(m.bottom),
        left: px(m.left),
      },
    };
  }
  /**
   * `pose` panned in its view plane, then moved back, only as far as the
   * framed stars need to sit inside the canvas less the frame's margins
   * (fitPointsInView). Unchanged when they already do, before the stars
   * have arrived, or while the view has no real size yet.
   */
  private keepFramed(pose: Pose): Pose {
    const frame = this.homeFrame;
    if (!frame || this.stars.decorative) return pose;
    const points: Vec3[] = [];
    for (const tic of frame.ticIds) {
      const world = this.stars.worldOf(tic);
      if (world) points.push([world.x, world.y, world.z]);
    }
    if (!points.length) return pose;
    const view = this.rig.targetView();
    const back = pose.position.clone().sub(pose.target);
    const distance = back.length();
    if (!(distance > 0)) return pose;
    back.normalize();
    const m = frame.margin;
    const fit = fitPointsInView(
      points,
      [pose.target.x, pose.target.y, pose.target.z],
      cameraBasis([back.x, back.y, back.z], pose.roll),
      distance,
      focalPx(view.height),
      {
        x: view.free.x + view.free.width / 2,
        y: view.free.y + view.free.height / 2,
      },
      {
        left: m.left,
        top: m.top,
        right: view.width - m.right,
        bottom: view.height - m.bottom,
      },
    );
    if (!fit.moved) return pose;
    const target = toV(fit.target);
    return {
      position: target.clone().addScaledVector(back, fit.distance),
      target,
      roll: pose.roll,
    };
  }
  /** Horizontal direction from `world` toward the camera. */
  private approachDirection(world: Vector3) {
    const h = this.rig.camera.position.clone().sub(world);
    h.y = 0;
    if (h.lengthSq() < 1e-10)
      h.set(Math.sin(DEFAULT_VIEW.yaw), 0, Math.cos(DEFAULT_VIEW.yaw));
    return h.normalize();
  }
  /** System radius to frame; in analysis it also holds the ghost orbit. */
  private get frameRadius() {
    const base = Math.max(
      systemRadius(this.system.planetCount),
      orbitSlotRadius(1),
    );
    if (this.state.mode !== "analysis" || !this.hint) return base;
    return Math.max(
      base,
      this.system.ghostRadiusFor(this.hint.periodDays) +
        planetBodyRadius(0.5) * 1.5,
    );
  }
  /** Distance that frames the system (tilted .67) inside the free area. */
  private systemDistance(back: Vector3) {
    const view = this.rig.targetView();
    const radius = this.frameRadius;
    this.framedRadius = radius;
    const points: Vec3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      points.push([Math.cos(a) * radius, 0, Math.sin(a) * radius]);
    }
    points.push([0, STAR_RADIUS * 2, 0], [0, -STAR_RADIUS * 2, 0]);
    return fitDistance(
      points,
      [0, 0, 0],
      cameraBasis([back.x, back.y, back.z], 0),
      focalPx(view.height),
      view.free.width,
      view.free.height,
      0.84,
    );
  }
  private systemPose(world: Vector3, horizontal?: Vector3): Pose {
    const h = horizontal ?? this.approachDirection(world);
    const elevation = Math.PI / 2 - SYSTEM_VIEW.tilt;
    const back = h
      .clone()
      .multiplyScalar(Math.cos(elevation))
      .addScaledVector(UP, Math.sin(elevation))
      .normalize();
    return {
      position: world.clone().addScaledVector(back, this.systemDistance(back)),
      target: world.clone(),
      roll: 0,
    };
  }

  private get systemOpen() {
    const m = this.state.mode;
    return (
      (m === "system" || m === "analysis" || m === "transit") &&
      !!this.state.focusedTicId
    );
  }

  private applyControls() {
    const c = this.rig.controls;
    const mode = this.state.mode;
    c.enableDamping = !this.reduced;
    c.autoRotate = !this.reduced && (mode === "intro" || mode === "backdrop");
    c.autoRotateSpeed = mode === "backdrop" ? 0.08 : 0.18;
    if (mode === "galaxy") {
      c.enabled = true;
      c.enablePan = true;
      c.zoomToCursor = true;
      c.minDistance = 0.25;
      c.maxDistance = this.overviewDistance * 3.5;
    } else if (mode === "system" || mode === "analysis") {
      c.enabled = true;
      c.enablePan = false;
      c.zoomToCursor = false;
      if (this.state.focusedPlanetId) {
        const r =
          this.system.planetRadiusWorld(this.state.focusedPlanetId) ||
          planetBodyRadius(0.5);
        c.minDistance = r * 2.4;
        c.maxDistance = r * 60;
      } else {
        c.minDistance = STAR_RADIUS * 2.6;
        c.maxDistance = Math.max(3, this.frameRadius * 14);
      }
    } else {
      c.enabled = false;
      c.minDistance = 0;
      c.maxDistance = Infinity;
    }
  }

  // ---------------------------------------------------------------- flights

  private setGrow(value: number) {
    this.grow = clamp01(value);
    this.system.root.scale.setScalar(Math.max(0.001, this.grow));
    this.system.root.visible = this.grow > 0.002;
  }

  private focusSystemOn(ticId: string, world: Vector3) {
    this.system.focus(ticId, world);
    if (this.systemData?.ticId === ticId) this.system.setData(this.systemData);
    this.system.ghostVisible = this.state.mode === "analysis";
    this.system.hint = this.hint
      ? {
          periodDays: this.hint.periodDays,
          strength: this.hint.strength,
          selection: !!this.hint.selection,
        }
      : null;
  }

  /** Collapse any open system while flying to a galaxy pose. */
  private async galaxyFlight(
    to: Pose,
    duration: number,
    token: number,
    options: { arc?: number; lift?: number; instant?: boolean } = {},
  ) {
    this.endTransit();
    const collapsing = this.grow > 0;
    const startGrow = this.grow;
    const arrived = await this.rig.fly(to, this.ms(duration, options.instant), {
      arc: options.arc ?? -0.2,
      lift: options.lift ?? 0.2,
      now: this.now,
      onStep: (e) => {
        if (collapsing)
          this.setGrow(startGrow * (1 - easeInOutCubic(e / 0.35)));
      },
    });
    if (collapsing && token === this.token) {
      this.setGrow(0);
      this.system.clear();
    }
    return arrived && token === this.token;
  }

  playIntro(): Promise<void> {
    const mode = this.state.mode;
    if (mode !== "intro" && mode !== "backdrop") return Promise.resolve();
    const token = ++this.token;
    this.set({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
    if (this.realStars.length) this.stars.setStars(this.realStars);
    this.rig.controls.autoRotate = false;
    this.rig.controls.enabled = false;
    const run = async () => {
      const arrived = await this.galaxyFlight(
        this.homePose(),
        SCENE_TIMING.introMs,
        token,
        {
          arc: 0.22,
          lift: 0.04,
        },
      );
      // The stars (or the stars to keep in view) came in while flying: the
      // pose the flight aimed at was made without them. Glide on to the
      // real home framing before the galaxy counts as at rest.
      if (arrived && token === this.token) {
        const home = this.homePose();
        if (poseGap(this.rig.pose(), home) > 0.01)
          await this.rig.fly(home, this.ms(1100), {
            arc: 0,
            lift: 0,
            now: this.now,
          });
      }
      if (token === this.token) this.applyControls();
    };
    return this.track(run());
  }

  showOverview(): Promise<void> {
    const token = ++this.token;
    const open = this.grow > 0;
    this.set({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
    this.rig.controls.enabled = false;
    const run = async () => {
      // 전체 보기 never frames tighter than home: the framed stars stay in.
      await this.galaxyFlight(
        this.keepFramed(this.overviewPose()),
        open ? SCENE_TIMING.toGalaxyMs : SCENE_TIMING.overviewMs,
        token,
        { arc: open ? -0.2 : 0.1, lift: open ? 0.2 : 0.05 },
      );
      if (token === this.token) this.applyControls();
    };
    return this.track(run());
  }

  focusStar(ticId: string): Promise<void> {
    if (typeof ticId !== "string" || !ticId) return Promise.resolve();
    const token = ++this.token;
    const instant = this.instant;
    const from = this.state.mode;
    const insetVersion = this.insetVersion;
    if (this.grow === 0 && !this.systemOpen)
      this.galaxyPose = from === "intro" ? this.homePose() : this.rig.pose();
    const previous = this.system.ticId;
    this.endTransit();
    this.set({
      mode: from === "analysis" && previous === ticId ? "analysis" : "system",
      focusedTicId: ticId,
      focusedPlanetId: null,
    });
    this.hoverTo(null);
    this.rig.controls.enabled = false;
    this.rig.controls.autoRotate = false;
    const run = async () => {
      const world = await this.waitForStar(ticId, 10000, token);
      if (token !== this.token || !world) return;
      if (previous === ticId && this.grow > 0.99) {
        // Already there: just frame it again.
        await this.rig.fly(this.systemPose(world), this.ms(1200, instant), {
          arc: 0,
          lift: 0,
          now: this.now,
        });
        if (token === this.token) this.applyControls();
        return;
      }
      const switching = this.grow > 0 && previous !== ticId;
      const startGrow = this.grow;
      if (!switching) {
        this.focusSystemOn(ticId, world);
        this.setGrow(0);
      }
      const pose = this.systemPose(world);
      let swapped = !switching;
      const arrived = await this.rig.fly(
        pose,
        this.ms(SCENE_TIMING.toStarMs, instant),
        {
          arc: 0.22,
          lift: 0.02,
          now: this.now,
          onStep: (e) => {
            if (!swapped) {
              this.setGrow(startGrow * (1 - easeInOutCubic(e / 0.3)));
              if (e >= 0.3) {
                swapped = true;
                this.focusSystemOn(ticId, world);
                this.setGrow(0);
              }
              return;
            }
            this.setGrow(easeInOutCubic((e - 0.55) / 0.45));
          },
        },
      );
      if (token !== this.token) return;
      if (!swapped) this.focusSystemOn(ticId, world);
      this.setGrow(1);
      if (arrived) this.applyControls();
      // Panels that opened during the flight change the free area.
      if (arrived && insetVersion !== this.insetVersion)
        await this.reframe(700);
    };
    return this.track(run());
  }
  private insetVersion = 0;

  returnToGalaxy(): Promise<void> {
    const open = this.grow > 0 || this.systemOpen;
    if (!open && this.state.mode === "galaxy") return Promise.resolve();
    const token = ++this.token;
    this.set({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
    this.rig.controls.enabled = false;
    this.rig.setZoom(1, this.reduced);
    const to = this.galaxyPose ? clonePose(this.galaxyPose) : this.homePose();
    const run = async () => {
      await this.galaxyFlight(to, SCENE_TIMING.toGalaxyMs, token);
      if (token === this.token) this.applyControls();
    };
    return this.track(run());
  }

  setMode(mode: Exclude<SceneMode, "transit">) {
    const from = this.state.mode;
    if (mode === from) return;
    switch (mode) {
      case "intro": {
        const token = ++this.token;
        this.set({ mode: "intro", focusedTicId: null, focusedPlanetId: null });
        if (!this.realStars.length) this.stars.setDecorative();
        this.hoverTo(null);
        this.rig.controls.enabled = false;
        void this.track(
          this.galaxyFlight(this.introPose(), SCENE_TIMING.introMs, token, {
            arc: -0.15,
            lift: 0.1,
          }).then(() => {
            if (token === this.token) this.applyControls();
          }),
        );
        return;
      }
      case "galaxy":
        if (from === "intro") void this.playIntro();
        else if (this.systemOpen || this.grow > 0) void this.returnToGalaxy();
        else {
          this.set({ mode: "galaxy" });
          this.applyControls();
        }
        return;
      case "backdrop": {
        if (this.systemOpen || this.grow > 0) {
          const token = ++this.token;
          this.set({
            mode: "backdrop",
            focusedTicId: null,
            focusedPlanetId: null,
          });
          this.rig.controls.enabled = false;
          const to = this.galaxyPose
            ? clonePose(this.galaxyPose)
            : this.homePose();
          void this.track(
            this.galaxyFlight(to, SCENE_TIMING.toGalaxyMs, token).then(() => {
              if (token === this.token) this.applyControls();
            }),
          );
        } else {
          this.set({ mode: "backdrop" });
          this.applyControls();
        }
        this.hoverTo(null);
        return;
      }
      case "system":
      case "analysis": {
        if (!this.state.focusedTicId) return;
        if (from === "transit") {
          // Supersede the transit, including its approach flight.
          ++this.token;
          this.rig.cancel();
          this.endTransit();
        }
        this.set({ mode });
        this.system.ghostVisible = mode === "analysis";
        if (!this.rig.flying) this.applyControls();
        // Analysis frames the ghost orbit too; the system alone may be smaller.
        this.scheduleReframe(0);
        return;
      }
    }
  }

  focusPlanet(candidateId: string | null) {
    if (!this.systemOpen) return;
    const id =
      candidateId && this.system.hasPlanet(candidateId) ? candidateId : null;
    if (id === this.state.focusedPlanetId) return;
    const token = ++this.token;
    this.set({ focusedPlanetId: id });
    this.rig.controls.enabled = false;
    const world = this.system.root.position.clone();
    const back = this.rig.camera.position
      .clone()
      .sub(this.rig.controls.target)
      .normalize();
    const run = async () => {
      let arrived: boolean;
      if (id) {
        const radius = planetBodyRadius(0.5);
        arrived = await this.rig.fly(
          () => {
            const p = this.system.planetWorld(id) ?? world;
            const r = this.system.planetRadiusWorld(id) || radius;
            return {
              position: p.clone().addScaledVector(back, r * 9),
              target: p,
              roll: 0,
            };
          },
          this.ms(1400),
          { now: this.now },
        );
      } else {
        const h = back.clone();
        h.y = 0;
        arrived = await this.rig.fly(
          this.systemPose(
            world,
            h.lengthSq() > 1e-8 ? h.normalize() : undefined,
          ),
          this.ms(1400),
          {
            arc: 0.08,
            lift: 0.04,
            now: this.now,
          },
        );
      }
      if (token === this.token && arrived) this.applyControls();
    };
    void this.track(run());
  }

  setViewInset(inset: ViewInset) {
    if (!inset || typeof inset !== "object") return;
    this.insetVersion++;
    this.rig.setInset(inset, this.reduced || this.instant);
    if (
      this.systemOpen &&
      !this.state.focusedPlanetId &&
      !this.transit &&
      // A panel that keeps growing (content arriving, a rise animation)
      // replaces the dolly still running for its previous size. A longer
      // flight (to a star) reframes when it lands (insetVersion).
      (!this.rig.flying || this.reframeToken === this.token)
    )
      void this.reframe(900);
    else if (this.state.mode === "galaxy" || this.state.mode === "intro")
      this.applyBounds(this.bounds);
  }

  /**
   * Refit the distance when what must be framed changed a lot (the ghost
   * orbit grew past the frame, or shrank well inside it). Debounced so
   * dragging the period slider does not pump the camera.
   */
  private scheduleReframe(delay = 350) {
    clearTimeout(this.reframeTimer);
    this.reframeTimer = window.setTimeout(() => {
      if (
        this.disposed ||
        !this.systemOpen ||
        this.state.mode === "transit" ||
        this.state.focusedPlanetId ||
        this.transit ||
        this.grow < 0.99 ||
        (this.rig.flying && this.reframeToken !== this.token)
      )
        return;
      const needed = this.frameRadius;
      const framed = this.framedRadius || needed;
      if (needed > framed * 1.03 || needed < framed * 0.7)
        void this.reframe(800);
    }, delay);
  }

  /** Dolly to the distance that frames the system in the free area. */
  private reframe(duration: number) {
    if (!this.state.focusedTicId || this.grow < 0.99) return Promise.resolve();
    const token = ++this.token;
    this.reframeToken = token;
    const world = this.system.root.position.clone();
    const h = this.rig.camera.position.clone().sub(world);
    h.y = 0;
    this.rig.controls.enabled = false;
    return this.track(
      this.rig
        .fly(
          this.systemPose(
            world,
            h.lengthSq() > 1e-8 ? h.normalize() : undefined,
          ),
          this.ms(duration),
          {
            arc: 0,
            lift: 0,
            now: this.now,
          },
        )
        .then(() => {
          if (token === this.token) this.applyControls();
        }),
    );
  }

  // ---------------------------------------------------------------- analysis

  setAnalysisHint(hint: AnalysisHint | null) {
    const valid =
      hint &&
      Number.isFinite(hint.periodDays) &&
      hint.periodDays > 0 &&
      Number.isFinite(hint.strength);
    this.hint = valid ? hint : null;
    this.system.hint = this.hint
      ? {
          periodDays: this.hint.periodDays,
          strength: clamp01(this.hint.strength),
          selection: !!this.hint.selection,
        }
      : null;
    this.system.ghostVisible = this.state.mode === "analysis";
    if (this.state.mode === "analysis") this.scheduleReframe();
  }

  playMismatch(): Promise<void> {
    if (!this.systemOpen) return Promise.resolve();
    const ms = this.reduced ? 700 : 900;
    this.system.pulseMismatch(this.now, ms - 150);
    return this.track(
      this.settleable(ms + 500, (settle) => {
        window.setTimeout(settle, ms);
      }),
    );
  }

  playTransit(request: TransitRequest): Promise<void> {
    if (
      !this.systemOpen ||
      !this.state.focusedTicId ||
      request?.signal?.aborted
    )
      return Promise.resolve();
    const period =
      Number.isFinite(request.periodDays) && request.periodDays > 0
        ? request.periodDays
        : 10;
    const token = ++this.token;
    this.endTransit();
    this.set({ mode: "transit", focusedPlanetId: null });
    this.system.ghostVisible = false;
    this.rig.controls.enabled = false;
    const world = this.system.root.position.clone();
    const back = this.approachDirection(world);
    const right = new Vector3().crossVectors(UP, back).normalize();
    const orbit = this.system.ghostRadiusFor(period);
    const planet = transitPlanetRadius(request.depth);
    const distance = Math.max(orbit * 2.8, STAR_RADIUS * 16);
    const elevation = 0.012;
    const pose: Pose = {
      position: world
        .clone()
        .addScaledVector(back, distance * Math.cos(elevation))
        .addScaledVector(UP, distance * Math.sin(elevation)),
      target: world.clone(),
      roll: 0,
    };
    const zoom = clamp(
      (0.12 * this.height * distance) / (STAR_RADIUS * focalPx(this.height)),
      1,
      30,
    );
    const total = SCENE_TIMING.transitFlightMs + SCENE_TIMING.transitMs + 6000;
    return this.track(
      this.settleable(total, (settle) => {
        const abort = () => {
          if (this.transit?.token === token) this.endTransit();
          else if (token === this.token) this.rig.cancel();
          if (token === this.token && this.state.mode === "transit")
            this.set({ mode: "system" });
          settle();
        };
        request.signal?.addEventListener("abort", abort, { once: true });
        void this.startTransit(request, token, pose, zoom, {
          orbit,
          planet,
          back,
          right,
          abort,
          settle,
        }).catch((error) => {
          console.error("[scene] transit failed", error);
          abort();
        });
      }),
    );
  }

  private async startTransit(
    request: TransitRequest,
    token: number,
    pose: Pose,
    zoom: number,
    run: {
      orbit: number;
      planet: number;
      back: Vector3;
      right: Vector3;
      abort: () => void;
      settle: () => void;
    },
  ) {
    const { orbit, planet, back, right, abort, settle } = run;
    this.rig.setZoom(zoom, this.reduced);
    const arrived = await this.rig.fly(
      pose,
      this.ms(SCENE_TIMING.transitFlightMs),
      {
        arc: 0.25,
        lift: 0.05,
        now: this.now,
      },
    );
    if (!arrived || token !== this.token || request.signal?.aborted) {
      request.signal?.removeEventListener("abort", abort);
      if (token === this.token && this.state.mode === "transit")
        this.set({ mode: "system" });
      settle();
      return;
    }
    this.transit = {
      request,
      token,
      t0: this.now,
      ms: this.reduced ? 1200 : SCENE_TIMING.transitMs,
      orbit,
      planet,
      half: transitHalfAngle(orbit, STAR_RADIUS, planet),
      back,
      right,
      staticHold: this.reduced,
      settle: () => {
        request.signal?.removeEventListener("abort", abort);
        settle();
      },
    };
    this.parked = null;
    this.system.transitBody.visible = true;
    this.system.transitBody.scale.setScalar(planet);
    if (this.reduced) {
      // Static sequence: the whole curve at once, then a held frame.
      const samples = 48;
      for (let i = 0; i <= samples; i++) this.transitSample(i / samples, true);
      this.transitSample(0.5, false);
    }
  }

  /** Planet position at pass fraction t; flux from the projected discs. */
  private transitSample(t: number, report: boolean) {
    const run = this.transit;
    if (!run) return;
    const theta = transitTheta(run.half, t);
    const local = run.back
      .clone()
      .multiplyScalar(run.orbit * Math.cos(theta))
      .addScaledVector(run.right, run.orbit * Math.sin(theta))
      .addScaledVector(UP, STAR_RADIUS * 0.12);
    const body = this.system.transitBody;
    body.position.copy(local);
    body.updateMatrixWorld();
    const world = this.system.root.position;
    this.updateViewProjection();
    const camUp = new Vector3(0, 1, 0).applyQuaternion(
      this.rig.camera.quaternion,
    );
    const w = this.width,
      h = this.height,
      m = this.viewProjection.elements;
    const star = projectPoint(m, world.x, world.y, world.z, w, h);
    const edge = world
      .clone()
      .addScaledVector(camUp, this.system.starRadiusShown);
    const starEdge = projectPoint(m, edge.x, edge.y, edge.z, w, h);
    const p = world.clone().add(local);
    const planet = projectPoint(m, p.x, p.y, p.z, w, h);
    const pe = p.clone().addScaledVector(camUp, run.planet);
    const planetEdge = projectPoint(m, pe.x, pe.y, pe.z, w, h);
    let coverage = 0,
      covered = 0,
      rho = 1;
    if (star.inFront && planet.inFront && planet.depth < star.depth) {
      const R = Math.hypot(starEdge.x - star.x, starEdge.y - star.y);
      const r = Math.hypot(planetEdge.x - planet.x, planetEdge.y - planet.y);
      const d = Math.hypot(planet.x - star.x, planet.y - star.y);
      coverage = transitCoverage(R, r, d);
      covered = coveredFraction(R, r, d);
      rho = R > 0 ? d / R : 1;
    }
    this.system.brightness = transitBrightness(covered);
    this.system.transitMaterial.uniforms.uOpacity.value = this.reduced
      ? 1
      : clamp01(t * 6);
    if (report && run.request.onFlux)
      try {
        run.request.onFlux(t, transitFlux(run.request.depth, coverage, rho));
      } catch (error) {
        console.error("[scene] onFlux failed", error);
      }
  }

  private stepTransit(now: number) {
    const run = this.transit;
    if (!run) return;
    const k = clamp01((now - run.t0) / run.ms);
    if (!run.staticHold) this.transitSample(k, true);
    if (k < 1) return;
    this.finishTransit(true);
  }

  private finishTransit(park: boolean) {
    const run = this.transit;
    if (!run) return;
    if (park) this.transitSample(1, false);
    this.transit = null;
    this.system.brightness = 1;
    if (park) {
      const p = this.system.transitBody.position;
      this.parked = {
        until: this.now + 9000,
        radius: run.orbit,
        angle: Math.atan2(p.z, p.x),
        size: run.planet,
      };
    } else this.system.transitBody.visible = false;
    if (this.state.mode === "transit") this.set({ mode: "system" });
    this.rig.setZoom(1, this.reduced);
    run.settle();
    if (park && run.token === this.token) {
      // Drift back to a three-quarter view of the system.
      const world = this.system.root.position.clone();
      const token = ++this.token;
      void this.track(
        this.rig
          .fly(this.systemPose(world, run.back.clone()), this.ms(3200), {
            arc: 0.1,
            lift: 0.05,
            now: this.now,
          })
          .then(() => {
            if (token === this.token) this.applyControls();
          }),
      );
    }
  }

  private endTransit() {
    if (this.transit) this.finishTransit(false);
    if (this.parked) {
      this.parked = null;
      this.system.transitBody.visible = false;
    }
    if (this.rig.zoom !== 1) this.rig.setZoom(1, this.reduced);
  }

  revealPlanet(planet: PlanetReveal): Promise<void> {
    if (!planet || !this.systemOpen || planet.ticId !== this.state.focusedTicId)
      return Promise.resolve();
    const parked = this.parked;
    this.parked = null;
    this.system.transitBody.visible = false;
    const ms = this.ms(SCENE_TIMING.revealMs);
    return this.track(
      this.settleable(ms + 2000, (settle) => {
        void this.system
          .reveal(
            {
              candidateId: planet.candidateId,
              kind: planet.kind,
              periodDays: planet.periodDays,
              depthPpm: planet.depthPpm,
              seed: planet.seed,
            },
            parked,
            ms,
            this.now,
          )
          .then(settle);
      }),
    );
  }

  // ---------------------------------------------------------------- ignite

  ignite(target: IgniteTarget): Promise<void> {
    const ticId = typeof target === "string" ? target : target?.ticId;
    if (!ticId) return Promise.resolve();
    const given = typeof target === "string" ? null : target;
    // Held since the unlock (holdStars): the ignition owns it from here.
    if (this.held.delete(ticId)) this.showHeld();
    this.pendingIgnite.add(ticId);
    this.stars.setHidden(ticId, true);
    const instant = this.instant;
    const release = () => {
      this.pendingIgnite.delete(ticId);
      this.stars.setHidden(ticId, false);
      this.stars.setScale(ticId, null);
    };
    const run = async () => {
      const known = this.worldOf(ticId);
      const world =
        known ??
        (given
          ? toV(starWorld(given.x, given.y, given.depthZ))
          : await this.waitForStar(ticId));
      if (!world) {
        release();
        return;
      }
      const token = ++this.token;
      const open = this.grow > 0 || this.systemOpen;
      this.set({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
      this.rig.controls.enabled = false;
      // Where to rest afterwards: where the member was before the system.
      const rest = this.galaxyPose
        ? clonePose(this.galaxyPose)
        : this.homePose();
      // Close enough to see the flash, far enough that a star in the dense
      // core is not lost in a blown-out knot of neighbours.
      const back = toV(viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt));
      const pose: Pose = {
        position: world
          .clone()
          .addScaledVector(back, clamp(this.overviewDistance * 0.42, 6, 18)),
        target: world.clone(),
        roll: DEFAULT_VIEW.roll,
      };
      await this.galaxyFlight(
        pose,
        open ? SCENE_TIMING.toGalaxyMs : SCENE_TIMING.overviewMs,
        token,
        { arc: 0.12, lift: 0.08, instant },
      );
      if (token !== this.token) {
        release();
        return;
      }
      this.applyControls();
      const star = this.stars.star(ticId) ?? given;
      let rgb = [0.85, 0.8, 1],
        baseSize = 5;
      if (star)
        try {
          const style = starStyle(star);
          rgb = style.rgb;
          baseSize = style.baseSize;
        } catch {
          /* default look */
        }
      const ms = this.ms(SCENE_TIMING.igniteMs, instant);
      await this.settleable(ms + 2500, (settle) => {
        this.finishIgnition();
        const loose = !this.stars.has(ticId);
        this.ignition = {
          ticId,
          world,
          rgb,
          baseSize,
          t0: this.now,
          ms,
          loose,
          settle,
        };
        this.pendingIgnite.delete(ticId);
        if (loose) {
          this.looseTic = ticId;
          this.looseWorld.copy(world);
          this.loose.set(world, rgb, 0);
        }
        this.flash.position.copy(world);
        this.ring.position.copy(world);
        if (ms === 0) this.stepIgnition(this.now + 1);
      });
      // Settle back out, so the markers and the rest of the galaxy are in
      // view again. The promise does not wait for it; a later move wins.
      if (token !== this.token) return;
      const settleToken = ++this.token;
      void this.track(
        this.rig
          .fly(rest, this.ms(SCENE_TIMING.overviewMs + 400, instant), {
            arc: 0.06,
            lift: 0.04,
            now: this.now,
          })
          .then(() => {
            if (settleToken === this.token) this.applyControls();
          }),
      );
    };
    return this.track(run().finally(() => this.pendingIgnite.delete(ticId)));
  }

  private stepIgnition(now: number) {
    const run = this.ignition;
    if (!run) return;
    const k = run.ms > 0 ? clamp01((now - run.t0) / run.ms) : 1;
    const scale =
      easeOutCubic(clamp01(k * 2.5)) +
      2.2 * Math.sin(Math.min(1, k * 1.4) * Math.PI) * (1 - k);
    if (run.loose && !this.stars.has(run.ticId))
      this.loose.size(run.baseSize * scale);
    else {
      if (run.loose) {
        this.loose.hide();
        run.loose = false;
      }
      this.stars.setHidden(run.ticId, false);
      this.stars.setScale(run.ticId, scale);
    }
    const show = k < 1 && run.ms > 0;
    this.flash.visible = show;
    this.ring.visible = show;
    if (show) {
      this.flashMaterial.uniforms.uOpacity.value =
        Math.sin(Math.min(1, k * 2) * (Math.PI / 2)) * (1 - k);
      this.flash.scale.setScalar(0.2 + 2.6 * easeInOutCubic(clamp01(k * 1.3)));
      this.ringMaterial.uniforms.uOpacity.value = 0.7 * (1 - k);
      this.ring.scale.setScalar(0.1 + 5.5 * easeInOutCubic(k) * 2);
    }
    if (k >= 1) this.finishIgnition();
  }
  private finishIgnition() {
    const run = this.ignition;
    if (!run) return;
    this.ignition = null;
    this.flash.visible = false;
    this.ring.visible = false;
    if (this.stars.has(run.ticId)) {
      this.loose.hide();
      this.stars.setHidden(run.ticId, false);
      this.stars.setScale(run.ticId, null);
    } else {
      this.loose.size(run.baseSize);
      this.looseTic = run.ticId;
    }
    run.settle();
  }

  holdStars(ticIds: readonly string[] | null) {
    if (ticIds === null) {
      for (const tic of this.held)
        if (!this.pendingIgnite.has(tic) && this.ignition?.ticId !== tic)
          this.stars.setHidden(tic, false);
      this.held.clear();
    } else if (Array.isArray(ticIds))
      for (const tic of ticIds) {
        if (typeof tic !== "string" || !tic) continue;
        this.held.add(tic);
        this.stars.setHidden(tic, true);
      }
    this.showHeld();
  }
  /** Held TICs on the canvas (`data-held`), for checks and debugging. */
  private showHeld() {
    this.canvas.dataset.held = [...this.held].join(" ");
  }

  // ---------------------------------------------------------------- effects

  /**
   * The member's choice holds on every tier, the cheap one included: there
   * it switches to the composer path (bloom, nebula, dust) as asked.
   */
  setEffects(enabled: boolean) {
    this.effectsChoice = !!enabled;
    this.applyEffects();
  }
  private applyEffects() {
    const on = effectsFor(this.tier, this.effectsChoice);
    this.bloom.enabled = on;
    this.nebula.mesh.visible = on;
    this.dust.points.visible = on;
    // Turning them on compiles new programs on the next frames (no warm-up
    // on software WebGL): that stall is not the frame rate.
    if (on !== this.state.effects) this.monitor.hold(performance.now());
    this.set({ effects: on });
    this.wake();
  }

  // ---------------------------------------------------------------- power

  /** Frame-rate watch on the galaxy or a system at rest (./power.ts). */
  private watchPower(now: number, mode: SceneMode, moving: boolean) {
    if (this.pinned) return;
    if (mode !== this.monitoredMode) {
      this.monitoredMode = mode;
      this.monitor.hold(now);
    }
    const measurable =
      this.state.ready && !moving && (mode === "galaxy" || mode === "system");
    const action = this.monitor.frame(now, measurable, {
      tier: this.tier,
      effects: this.state.effects,
    });
    if (action) this.stepPower(action);
  }
  private stepPower(action: PowerAction) {
    const fps = Math.round(this.monitor.lastFps ?? 0);
    if (action === "list") {
      rememberPower("list");
      console.warn(`[scene] slow frames (${fps} fps) at low: star list`);
      this.fail(POWER_SLOW_MESSAGE);
      return;
    }
    // Lower resolution and the tier's default effects (off below `full`).
    // An explicit member choice stays as it is.
    this.tier = action;
    rememberPower(action);
    this.canvas.dataset.power = action;
    this.sizeDirty = true;
    console.info(`[scene] slow frames (${fps} fps): power ${action}`);
    this.set({ power: this.tier });
    this.applyEffects();
  }

  /**
   * Behind a page and at rest for a moment (dimmed, nothing moving): stop
   * drawing and keep the last frame as the backdrop. Any move, a mode
   * change or new data draws again.
   */
  private freeze(now: number, mode: SceneMode, moving: boolean) {
    let frozen = false;
    if (mode !== "backdrop" || moving) this.stillSince = 0;
    else {
      if (!this.stillSince) this.stillSince = now;
      frozen =
        now - this.stillSince >= FREEZE_AFTER_MS &&
        Math.abs(this.look - LOOK.backdrop) < 0.01 &&
        Math.abs(this.haze - HAZE.backdrop) < 0.01;
    }
    if (frozen !== this.frozen) {
      this.frozen = frozen;
      this.canvas.dataset.frozen = frozen ? "true" : "false";
    }
    return frozen;
  }
  private wake() {
    this.stillSince = 0;
  }

  // ---------------------------------------------------------------- projection

  private updateViewProjection() {
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
  }
  private screenOf(
    world: Vector3,
    radiusWorld: number | null,
    fallbackRadius = 6,
  ): ScreenPoint {
    const m = this.viewProjection.elements;
    const p = projectPoint(
      m,
      world.x,
      world.y,
      world.z,
      this.width,
      this.height,
    );
    let radius = fallbackRadius;
    if (radiusWorld !== null && p.inFront) {
      const up = new Vector3(0, 1, 0).applyQuaternion(
        this.rig.camera.quaternion,
      );
      const e = world.clone().addScaledVector(up, radiusWorld);
      const q = projectPoint(m, e.x, e.y, e.z, this.width, this.height);
      radius = Math.max(fallbackRadius, Math.hypot(q.x - p.x, q.y - p.y));
    }
    return {
      x: p.inFront ? p.x : -1e5,
      y: p.inFront ? p.y : -1e5,
      depth: p.depth,
      radius,
      visible: p.visible,
    };
  }
  projectStar(ticId: string): ScreenPoint | null {
    if (this.disposed) return null;
    if (ticId === this.state.focusedTicId && this.grow > 0.5)
      return this.screenOf(
        this.system.root.position,
        this.system.starRadiusShown * this.grow,
        8,
      );
    const i = this.stars.decorative ? -1 : this.stars.indexOf(ticId);
    if (i >= 0) {
      const pos = this.stars.positions;
      const world = new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const point = this.screenOf(world, null);
      const size = this.stars.sizeAt(i);
      point.radius = starHitRadius(
        starPointCss(
          size * this.stars.material.uniforms.uSizeScale.value,
          this.height,
          this.stars.material.uniforms.uRef.value,
          point.depth,
          this.stars.material.uniforms.uAttMax.value,
        ),
      );
      if (size <= 0.01) point.visible = false;
      return point;
    }
    if (this.looseTic === ticId && this.loose.points.visible)
      return this.screenOf(this.looseWorld, null, 8);
    const world = this.worldOf(ticId);
    return world ? this.screenOf(world, null) : null;
  }
  projectPlanet(candidateId: string): ScreenPoint | null {
    if (this.disposed || this.grow < 0.05) return null;
    if (candidateId === GHOST_PLANET_ID) {
      const world = this.system.ghostWorld();
      return world
        ? this.screenOf(world, planetBodyRadius(0.5) * this.grow, 6)
        : null;
    }
    const world = this.system.planetWorld(candidateId);
    if (!world) return null;
    const point = this.screenOf(
      world,
      this.system.planetRadiusWorld(candidateId),
      6,
    );
    if (point.visible && this.behindStar(world)) point.visible = false;
    return point;
  }
  private behindStar(world: Vector3) {
    const cam = this.rig.camera.position;
    const star = this.system.root.position;
    if (world.distanceTo(cam) < star.distanceTo(cam)) return false;
    const a = this.screenOf(world, null);
    const s = this.screenOf(star, this.system.starRadiusShown * this.grow, 0);
    return Math.hypot(a.x - s.x, a.y - s.y) < s.radius * 1.05;
  }

  // ---------------------------------------------------------------- events

  onFrame(listener: (frame: SceneFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => void this.frameListeners.delete(listener);
  }
  onReady(listener: () => void): Unsubscribe {
    this.readyListeners.add(listener);
    if (this.state.ready)
      queueMicrotask(
        () =>
          this.readyListeners.has(listener) && safeCall(listener, undefined),
      );
    return () => void this.readyListeners.delete(listener);
  }
  onError(listener: (error: SceneError) => void): Unsubscribe {
    this.errorListeners.add(listener);
    const failed = this.state.failed;
    if (failed)
      queueMicrotask(
        () =>
          this.errorListeners.has(listener) &&
          safeCall(listener, { message: failed, recoverable: false }),
      );
    return () => void this.errorListeners.delete(listener);
  }
  onStarHover(listener: (star: StarPointer | null) => void): Unsubscribe {
    this.hoverListeners.add(listener);
    return () => void this.hoverListeners.delete(listener);
  }
  onStarClick(listener: (star: StarPointer) => void): Unsubscribe {
    this.clickListeners.add(listener);
    return () => void this.clickListeners.delete(listener);
  }
  onPlanetClick(listener: (planet: PlanetPointer) => void): Unsubscribe {
    this.planetListeners.add(listener);
    return () => void this.planetListeners.delete(listener);
  }

  private emitError(error: SceneError) {
    for (const listener of [...this.errorListeners]) safeCall(listener, error);
  }

  private local(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  private onPointerDown = (e: PointerEvent) => {
    this.down =
      e.button === 0 ? { ...this.local(e), t: this.now, moved: false } : null;
  };
  private onPointerMove = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointer = { ...p, inside: true };
    if (
      this.down &&
      Math.hypot(p.x - this.down.x, p.y - this.down.y) > CLICK_SLOP_PX
    )
      this.down.moved = true;
    this.hoverDirty = true;
  };
  private onPointerUp = (e: PointerEvent) => {
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0 || down.moved) return;
    const p = this.local(e);
    if (
      Math.hypot(p.x - down.x, p.y - down.y) > CLICK_SLOP_PX ||
      this.now - down.t > 800
    )
      return;
    this.click(p.x, p.y);
  };
  private onPointerCancel = () => {
    this.down = null;
  };
  private onPointerLeave = () => {
    this.pointer.inside = false;
    if (!this.down) this.hoverTo(null);
  };

  private pickStar(x: number, y: number) {
    if (this.stars.decorative || !this.stars.count) return null;
    this.updateViewProjection();
    const hit = pickNearest(
      this.stars.positions,
      this.stars.count,
      this.viewProjection.elements,
      this.width,
      this.height,
      x,
      y,
      HOVER_RADIUS_PX,
      (i) => !this.stars.visibleAt(i),
    );
    if (!hit) return null;
    const star = this.stars.stars[hit.index];
    const screen = this.projectStar(star.ticId);
    return screen ? { ticId: star.ticId, screen } : null;
  }
  private click(x: number, y: number) {
    if (this.state.failed || this.rig.flying) return;
    const mode = this.state.mode;
    if (mode === "galaxy") {
      const hit = this.pickStar(x, y);
      if (hit)
        for (const listener of [...this.clickListeners])
          safeCall(listener, hit);
    } else if ((mode === "system" || mode === "analysis") && this.grow > 0.9) {
      const id = this.pickPlanet(x, y);
      for (const listener of [...this.planetListeners])
        safeCall(listener, { candidateId: id });
    }
  }
  private pickPlanet(x: number, y: number) {
    this.updateViewProjection();
    const targets = this.system.pickTargets().map((t) => ({
      id: t.id,
      ...this.screenOf(t.world, t.radius, 4),
    }));
    const visible = targets.filter((t) => t.visible);
    const index = pickCircle(visible, x, y, 8);
    return index >= 0 ? visible[index].id : null;
  }
  private hoverTo(next: StarPointer | null) {
    const tic = next?.ticId ?? null;
    if (tic === this.hoverTic) return;
    this.hoverTic = tic;
    this.canvas.style.cursor = tic ? "pointer" : "";
    for (const listener of [...this.hoverListeners]) safeCall(listener, next);
  }
  private updateHover() {
    const mode = this.state.mode;
    if (mode === "system" || mode === "analysis") {
      if (this.hoverTic) this.hoverTo(null);
      if (this.hoverDirty && this.pointer.inside && !this.down?.moved) {
        const id =
          this.grow > 0.9
            ? this.pickPlanet(this.pointer.x, this.pointer.y)
            : null;
        this.canvas.style.cursor = id ? "pointer" : "";
      }
      this.hoverDirty = false;
      return;
    }
    if (
      mode !== "galaxy" ||
      !this.pointer.inside ||
      this.down?.moved ||
      this.rig.flying
    ) {
      if (this.hoverTic) this.hoverTo(null);
      this.hoverDirty = false;
      return;
    }
    const periodic = this.frameCount % 6 === 0 && this.stars.count <= 30000;
    if (!this.hoverDirty && !periodic) return;
    this.hoverDirty = false;
    this.hoverTo(this.pickStar(this.pointer.x, this.pointer.y));
  }

  // ---------------------------------------------------------------- frame

  private targetRatio() {
    const device = window.devicePixelRatio || 1;
    return Math.min(device, POWER_DPR[this.tier]);
  }
  private onWindowResize = () => {
    this.sizeDirty = true;
  };
  private onMotionChange = () => {
    this.set({ reducedMotion: this.media?.matches ?? false });
    this.applyControls();
  };
  private resize() {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(
      1,
      Math.round(rect.width || this.host.clientWidth || window.innerWidth),
    );
    const height = Math.max(
      1,
      Math.round(rect.height || this.host.clientHeight || window.innerHeight),
    );
    const ratio = this.targetRatio();
    this.sizeDirty = false;
    if (
      width === this.width &&
      height === this.height &&
      ratio === this.pixelRatio
    )
      return;
    const first = this.width === 1 && this.height === 1;
    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.rig.resize(width, height);
    const pix = ratio * clamp(height / 836, 0.8, 1.6);
    for (const m of [
      this.stars.material,
      this.looseMaterial,
      this.dust.material,
      this.background.material,
    ])
      m.uniforms.uPix.value = pix;
    this.applyBounds(this.bounds);
    if (first && !this.userMoved && !this.rig.flying) {
      const mode = this.state.mode;
      if (mode === "galaxy") this.rig.place(this.homePose());
      else if (mode === "intro") this.rig.place(this.introPose());
    }
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    // Nothing on screen (lost context, desktop gate, hidden tab): no work.
    if (this.lost || this.state.failed || this.hostHidden || document.hidden) {
      this.last = now;
      this.monitor.hold(now);
      return;
    }
    const mode = this.state.mode;
    const moving = this.rig.flying || !!this.ignition || !!this.transit;
    this.watchPower(now, mode, moving);
    if (this.state.failed) return;
    // Behind a page at rest: the last frame stays (a resize draws once).
    if (this.freeze(now, mode, moving) && !this.sizeDirty) {
      this.last = now;
      return;
    }
    // Login and other pages only drift: fewer frames will do, fewer still
    // on a weak tier. Flights and effects always draw every frame.
    const interval = moving ? 0 : driftInterval(this.tier, mode);
    if (interval && now - this.last < interval) return;
    const dt = clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;
    try {
      if (this.sizeDirty) this.resize();
      this.update(now, dt);
      if (this.tier === "low" && !this.state.effects)
        this.renderer.render(this.scene, this.rig.camera);
      else this.composer.render(dt);
      this.frameCount++;
      if (!this.state.ready) {
        this.set({ ready: true });
        for (const listener of [...this.readyListeners])
          safeCall(listener, undefined);
        // Compile every program now (hidden system, transit body, flash
        // included), so the first flight, transit or reveal never stalls on
        // a shader compile. KHR_parallel_shader_compile keeps it off the
        // main thread where the browser has it.
        window.setTimeout(() => this.warm(), 60);
      }
      this.updateHover();
      const frame = { time: now, width: this.width, height: this.height };
      for (const listener of [...this.frameListeners])
        safeCall(listener, frame);
    } catch (error) {
      console.error("[scene] frame failed", error);
      this.fail("장면을 그리지 못했습니다.");
    }
  };

  private warm() {
    if (this.warmed || this.disposed || this.state.failed || this.lost) return;
    this.warmed = true;
    // Software WebGL compiles on the CPU: all programs at once would stall
    // the page it is trying to keep responsive. It compiles as it draws.
    if (this.software) return;
    try {
      if (this.renderer.extensions.has("KHR_parallel_shader_compile"))
        void this.renderer
          .compileAsync(this.scene, this.rig.camera)
          .catch((error: unknown) =>
            console.error("[scene] warm-up failed", error),
          );
      // Without the extension a compile blocks either way: better now, at
      // rest, than on the first frame of a transit.
      else this.renderer.compile(this.scene, this.rig.camera);
    } catch (error) {
      console.error("[scene] warm-up failed", error);
    }
  }

  private update(now: number, dt: number) {
    const reduced = this.reduced;
    const mode = this.state.mode;
    const lightWorld = this.system.root.position;
    this.system.starScaleTarget = mode === "analysis" ? ANALYSIS_STAR_SCALE : 1;
    // System first: planets move, then the camera follows them.
    if (this.system.root.visible)
      this.system.update(now, dt, reduced, lightWorld);
    const planet = this.state.focusedPlanetId;
    if (planet && !this.rig.flying && this.systemOpen) {
      const world = this.system.planetWorld(planet);
      if (world) this.rig.translate(world.sub(this.rig.controls.target));
    }
    this.stepTransit(now);
    if (this.parked && now > this.parked.until) {
      this.parked = null;
      this.system.transitBody.visible = false;
    }
    this.stepIgnition(now);
    this.rig.update(now, dt, reduced);
    this.updateViewProjection();

    const look = LOOK[mode];
    this.look = reduced ? look : lerp(this.look, look, approach(3, dt));
    const distance = this.rig.camera.position.distanceTo(
      this.rig.controls.target,
    );
    const zoom = this.overviewDistance / Math.max(1e-3, distance);
    const count = this.stars.decorative ? 1400 : Math.max(this.stars.count, 1);
    const exposure = galaxyExposure(count, mode === "galaxy" ? zoom : 1);
    const time = reduced ? 0 : now / 1000;
    const s = this.stars.material.uniforms;
    s.uTime.value = time;
    s.uTwinkle.value = reduced ? 0 : 1;
    s.uBrightness.value = this.look * exposure;
    s.uFocus.value.copy(this.system.root.position);
    s.uFocusRadius.value = Math.max(this.frameRadius * 1.6, STAR_RADIUS * 6);
    s.uFocusAmount.value = this.grow;
    s.uSizeScale.value = densityScale(count, mode === "galaxy" ? zoom : 1);
    s.uAttMax.value = reduced
      ? ATTENUATION[mode]
      : lerp(s.uAttMax.value, ATTENUATION[mode], approach(2.5, dt));
    const l = this.looseMaterial.uniforms;
    l.uTime.value = time;
    l.uTwinkle.value = 0;
    l.uBrightness.value = this.look;
    this.haze = reduced
      ? HAZE[mode]
      : lerp(this.haze, HAZE[mode], approach(2.5, dt));
    const hazy = this.state.effects && this.haze > 0.005;
    this.dust.points.visible = hazy;
    this.nebula.mesh.visible = hazy;
    this.dust.material.uniforms.uBrightness.value = this.look * 0.9 * this.haze;
    this.nebula.material.uniforms.uBrightness.value = this.look * this.haze;
    const b = this.background.material.uniforms;
    b.uTime.value = time;
    b.uTwinkle.value = reduced ? 0 : 1;
    b.uBrightness.value = mode === "backdrop" ? 0.6 : 1;
    this.background.points.position.copy(this.rig.camera.position);
    const bloom = BLOOM[mode] * densityBloom(count);
    this.bloom.enabled = this.state.effects;
    this.bloom.strength = reduced
      ? bloom
      : lerp(this.bloom.strength, bloom, approach(3, dt));
  }

  // ---------------------------------------------------------------- failure

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.lossCount++;
    this.emitError({
      message: "그래픽 연결이 잠시 끊겼습니다.",
      recoverable: true,
    });
    clearTimeout(this.lossTimer);
    this.lossTimer = window.setTimeout(
      () => this.fail("그래픽 연결을 다시 만들지 못했습니다."),
      4000,
    );
  };
  private onContextRestored = () => {
    clearTimeout(this.lossTimer);
    this.lost = false;
    if (this.lossCount > 3)
      this.fail("그래픽 연결이 자주 끊겨 목록으로 보여 드립니다.");
    else this.sizeDirty = true;
  };
  private fail(message: string) {
    if (this.state.failed || this.disposed) return;
    this.set({ failed: message, busy: false });
    this.rig.cancel();
    for (const settle of [...this.settles]) settle();
    this.finishTransit(false);
    this.finishIgnition();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
    this.emitError({ message, recoverable: false });
  }

  /** Put the scene in a state instantly (used when a new engine takes over). */
  restore(
    target: Pick<SceneState, "mode" | "focusedTicId" | "focusedPlanetId">,
  ) {
    this.instant = true;
    try {
      if (
        target.focusedTicId &&
        (target.mode === "system" ||
          target.mode === "analysis" ||
          target.mode === "transit")
      ) {
        const tic = target.focusedTicId;
        void this.focusStar(tic).then(() => {
          if (target.mode === "analysis") this.setMode("analysis");
          if (target.focusedPlanetId) {
            this.instant = true;
            this.focusPlanet(target.focusedPlanetId);
            this.instant = false;
          }
        });
      } else if (target.mode === "intro" || target.mode === "backdrop") {
        this.setMode(target.mode);
      }
    } finally {
      this.instant = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.lossTimer);
    clearTimeout(this.reframeTimer);
    this.rig.cancel();
    for (const settle of [...this.settles]) settle();
    this.finishTransit(false);
    this.finishIgnition();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
    const c = this.canvas;
    c.removeEventListener("webglcontextlost", this.onContextLost);
    c.removeEventListener("webglcontextrestored", this.onContextRestored);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerCancel);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    this.media?.removeEventListener?.("change", this.onMotionChange);
    window.removeEventListener("resize", this.onWindowResize);
    this.resizeObserver?.disconnect();
    this.rig.dispose();
    this.stars.dispose();
    this.loose.dispose();
    this.looseMaterial.dispose();
    this.dust.points.geometry.dispose();
    this.dust.material.dispose();
    this.background.points.geometry.dispose();
    this.background.material.dispose();
    this.nebula.dispose();
    this.system.dispose();
    disposeSharedGeometry();
    this.flashMaterial.dispose();
    this.ringMaterial.dispose();
    this.quad.dispose();
    this.bloom.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    c.remove();
    this.state = { ...this.state, ready: false, busy: false };
    this.stateListeners.clear();
    this.frameListeners.clear();
    this.readyListeners.clear();
    this.errorListeners.clear();
    this.hoverListeners.clear();
    this.clickListeners.clear();
    this.planetListeners.clear();
  }
}

export function createSceneEngine(host: HTMLElement) {
  return new SceneEngine(host);
}
