// Camera: perspective, OrbitControls (drag rotate, wheel zoom, right or
// shift drag pan, damping), curved flights, the real view's roll and the
// view offset that keeps the target above the panels.
import { CatmullRomCurve3, PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ViewInset } from "./contract";
import {
  BASE_FOV,
  approach,
  arcMidpoint,
  clamp,
  clamp01,
  easeInOutCubic,
  focalPx,
  lerp,
  viewOffset,
  type Vec3,
} from "./math";

export type Pose = { position: Vector3; target: Vector3; roll: number };
export const clonePose = (p: Pose): Pose => ({
  position: p.position.clone(),
  target: p.target.clone(),
  roll: p.roll,
});

type Flight = {
  from: Pose;
  to: () => Pose;
  curve: CatmullRomCurve3 | null;
  t0: number;
  ms: number;
  onStep?: (e: number, k: number) => void;
  settle: (finished: boolean) => void;
};

const v3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];

export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  roll = 0;
  zoom = 1;
  private zoomTarget = 1;
  width = 1;
  height = 1;
  private inset = { top: 0, right: 0, bottom: 0, left: 0 };
  private insetTarget = { top: 0, right: 0, bottom: 0, left: 0 };
  private flight: Flight | null = null;
  private lastNear = 0;

  constructor(dom: HTMLElement) {
    this.camera = new PerspectiveCamera(BASE_FOV, 1, 0.05, 2400);
    this.camera.up.set(0, 1, 0);
    this.controls = new OrbitControls(this.camera, dom);
    const c = this.controls;
    c.enableDamping = true;
    c.dampingFactor = 0.07;
    c.rotateSpeed = 0.5;
    c.zoomSpeed = 0.8;
    c.panSpeed = 0.8;
    c.screenSpacePanning = true;
    c.minPolarAngle = 0.12;
    c.maxPolarAngle = Math.PI - 0.12;
    c.autoRotateSpeed = 0.18;
    c.enabled = false;
  }

  get flying() {
    return this.flight !== null;
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.applyProjection();
  }

  setInset(inset: ViewInset, instant: boolean) {
    this.insetTarget = {
      top: inset.top ?? 0,
      right: inset.right ?? 0,
      bottom: inset.bottom ?? 0,
      left: inset.left ?? 0,
    };
    if (instant) {
      this.inset = { ...this.insetTarget };
      this.applyProjection();
    }
  }
  /** Inset the camera is heading to (framing uses the final free area). */
  targetView() {
    return viewOffset(this.width, this.height, this.insetTarget);
  }
  setZoom(zoom: number, instant: boolean) {
    this.zoomTarget = clamp(zoom, 0.2, 40);
    if (instant) {
      this.zoom = this.zoomTarget;
      this.applyProjection();
    }
  }
  /** Focal length in CSS px at the current zoom. */
  focal() {
    return focalPx(this.height) * this.zoom;
  }

  private applyProjection() {
    const view = viewOffset(this.width, this.height, this.inset);
    const cam = this.camera;
    cam.fov = view.fov;
    cam.aspect = view.aspect;
    cam.zoom = this.zoom;
    if (view.shifted)
      cam.setViewOffset(
        view.fullWidth,
        view.fullHeight,
        view.offsetX,
        view.offsetY,
        view.width,
        view.height,
      );
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }

  pose(): Pose {
    return {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      roll: this.roll,
    };
  }
  /** Jump without animation. */
  place(pose: Pose) {
    this.cancel();
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.roll = pose.roll;
    this.orient();
  }

  /**
   * Curved flight: Catmull-Rom through a lifted, sideways middle point,
   * ease in-out; the look target leads slightly. `to` may move while flying
   * (a planet on its orbit), then the path is a straight eased blend.
   * Resolves true when it arrives, false when superseded or cancelled.
   */
  fly(
    to: Pose | (() => Pose),
    ms: number,
    options: {
      arc?: number;
      lift?: number;
      now: number;
      onStep?: (e: number, k: number) => void;
    },
  ): Promise<boolean> {
    this.cancel();
    const from = this.pose();
    const dynamic = typeof to === "function";
    const target = dynamic ? to : () => to;
    return new Promise<boolean>((resolve) => {
      let curve: CatmullRomCurve3 | null = null;
      if (!dynamic) {
        const end = (to as Pose).position;
        const mid = arcMidpoint(
          v3(from.position),
          v3(end),
          options.arc ?? 0.18,
          options.lift ?? 0.12,
        );
        curve =
          from.position.distanceTo(end) > 1e-6
            ? new CatmullRomCurve3([
                from.position.clone(),
                new Vector3(...mid),
                end.clone(),
              ])
            : null;
      }
      this.flight = {
        from,
        to: target,
        curve,
        t0: options.now,
        ms: Math.max(0, ms),
        onStep: options.onStep,
        settle: resolve,
      };
      if (ms <= 0) this.step(options.now);
    });
  }

  cancel() {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    f.settle(false);
  }

  private step(now: number) {
    const f = this.flight;
    if (!f) return;
    const k = f.ms > 0 ? clamp01((now - f.t0) / f.ms) : 1;
    const e = easeInOutCubic(k);
    const to = f.to();
    if (f.curve) this.camera.position.copy(f.curve.getPoint(e));
    else this.camera.position.copy(f.from.position).lerp(to.position, e);
    this.controls.target
      .copy(f.from.target)
      .lerp(to.target, easeInOutCubic(clamp01(k * 1.25)));
    this.roll = lerp(f.from.roll, to.roll, e);
    f.onStep?.(e, k);
    if (k >= 1) {
      this.flight = null;
      this.camera.position.copy(to.position);
      this.controls.target.copy(to.target);
      this.roll = to.roll;
      f.settle(true);
    }
  }

  private orient() {
    this.camera.lookAt(this.controls.target);
    if (this.roll) this.camera.rotateZ(this.roll);
    this.camera.updateMatrixWorld();
  }

  /** Move camera and target together (follow a planet on its orbit). */
  translate(delta: Vector3) {
    this.camera.position.add(delta);
    this.controls.target.add(delta);
  }

  update(now: number, dt: number, reduced: boolean) {
    const insetRate = reduced ? 1 : approach(5, dt);
    let changed = false;
    for (const key of ["top", "right", "bottom", "left"] as const) {
      const a = this.inset[key],
        b = this.insetTarget[key];
      if (a === b) continue;
      this.inset[key] = Math.abs(b - a) < 0.5 ? b : lerp(a, b, insetRate);
      changed = true;
    }
    if (this.zoom !== this.zoomTarget) {
      this.zoom =
        Math.abs(this.zoomTarget - this.zoom) < 1e-3
          ? this.zoomTarget
          : lerp(this.zoom, this.zoomTarget, reduced ? 1 : approach(2.2, dt));
      changed = true;
    }
    if (this.flight) this.step(now);
    else this.controls.update(dt);
    this.orient();
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = clamp(distance * 0.01, 2e-4, 0.05);
    if (Math.abs(near - this.lastNear) > this.lastNear * 0.15) {
      this.camera.near = near;
      this.lastNear = near;
      changed = true;
    }
    if (changed) this.applyProjection();
  }

  dispose() {
    this.cancel();
    this.controls.dispose();
  }
}
