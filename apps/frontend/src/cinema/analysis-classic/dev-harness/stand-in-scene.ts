// Harness only. A 2D stand-in for the scene engine so the classic panel can
// be judged over "a star" before the real engine and shell exist. It is a
// SceneController (../../scene/contract), so the panel talks to it exactly as
// it will talk to the engine (setViewInset), and the harness drives it from
// the bridge the way the shell will (setAnalysisHint, playMismatch, ...).
// Every call is recorded on window.__classicScene for the screenshot script.
import {
  createNoopSceneController,
  type AnalysisHint,
  type PlanetReveal,
  type SceneController,
  type TransitRequest,
  type ViewInset,
} from "../../scene/contract";

type Call = { method: string; args: unknown; at: number };
type Look = {
  inset: ViewInset;
  hint: AnalysisHint | null;
  mismatchAt: number;
  planet: PlanetReveal | null;
  transitAt: number;
  ignited: string[];
};

declare global {
  interface Window {
    __classicScene?: { calls: Call[]; look: Look };
  }
}

export function createStandInScene(canvas: HTMLCanvasElement): {
  controller: SceneController;
  dispose(): void;
} {
  const base = createNoopSceneController();
  const look: Look = {
    inset: { right: 0, bottom: 0 },
    hint: null,
    mismatchAt: -1e9,
    planet: null,
    transitAt: -1e9,
    ignited: [],
  };
  const calls: Call[] = [];
  window.__classicScene = { calls, look };
  const record = (method: string, args: unknown) =>
    calls.push({ method, args, at: Math.round(performance.now()) });
  const done = () => Promise.resolve();

  const controller: SceneController = {
    ...base,
    setViewInset(inset) {
      record("setViewInset", inset);
      look.inset = inset;
    },
    setAnalysisHint(hint) {
      record("setAnalysisHint", hint);
      look.hint = hint;
      if (!hint) look.planet = null;
    },
    playMismatch() {
      record("playMismatch", null);
      look.mismatchAt = performance.now();
      return done();
    },
    playTransit(request: TransitRequest) {
      record("playTransit", { ...request, onFlux: undefined });
      look.transitAt = performance.now();
      return done();
    },
    revealPlanet(planet) {
      record("revealPlanet", planet);
      look.planet = planet;
      return done();
    },
    ignite(target) {
      record("ignite", target);
      look.ignited.push(typeof target === "string" ? target : target.ticId);
      return done();
    },
  };

  // Seeded field so screenshots are stable.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const field = Array.from({ length: 420 }, () => ({
    x: random(),
    y: random(),
    r: 0.3 + random() * 1.1,
    a: 0.15 + random() * 0.6,
    blue: random() > 0.55,
  }));
  let frame = 0;

  const draw = (now: number) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr) canvas.width = width * dpr;
    if (canvas.height !== height * dpr) canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    for (const star of field) {
      ctx.globalAlpha = star.a;
      ctx.fillStyle = star.blue ? "#8fb4ff" : "#e8eef8";
      ctx.beginPath();
      ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The focused star sits in the middle of what the panel leaves free.
    const top = look.inset.top ?? 0;
    const free = Math.max(80, height - look.inset.bottom - top);
    const cx = width / 2;
    const cy = top + free / 2;
    const radius = Math.min(34, free * 0.12);
    const corona = ctx.createRadialGradient(
      cx,
      cy,
      radius * 0.4,
      cx,
      cy,
      radius * 3.2,
    );
    corona.addColorStop(0, "rgba(255,190,110,0.55)");
    corona.addColorStop(1, "rgba(255,120,60,0)");
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 3.2, 0, Math.PI * 2);
    ctx.fill();
    const surface = ctx.createRadialGradient(
      cx - radius * 0.3,
      cy - radius * 0.3,
      1,
      cx,
      cy,
      radius,
    );
    surface.addColorStop(0, "#fff1c9");
    surface.addColorStop(0.55, "#ffb870");
    surface.addColorStop(1, "#c2411c");
    ctx.fillStyle = surface;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // Ghost orbit: wider for longer periods, brighter near a strong peak.
    const hint = look.hint;
    if (hint) {
      const rx = Math.min(
        width * 0.42,
        120 + 95 * Math.log10(1 + hint.periodDays),
      );
      const ry = Math.min(free * 0.4, rx * 0.3);
      const mismatch = Math.max(0, 1 - (now - look.mismatchAt) / 1400);
      const alpha = 0.14 + 0.78 * hint.strength;
      ctx.lineWidth = 1 + hint.strength * 1.2;
      ctx.setLineDash(look.planet?.kind === "confirmed" ? [] : [6, 6]);
      ctx.strokeStyle =
        mismatch > 0
          ? `rgba(242,139,130,${0.35 + 0.6 * mismatch})`
          : `rgba(94,196,247,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const selection = hint.selection;
      if (selection || look.planet) {
        const mid = selection
          ? (selection.startPhase + selection.endPhase) / 2
          : 0;
        // Phase 0 is the transit: the planet crosses in front, below the star.
        const angle = Math.PI / 2 - mid * Math.PI * 2;
        const px = cx + Math.cos(angle) * rx;
        const py = cy + Math.sin(angle) * ry;
        ctx.globalAlpha = look.planet ? 1 : 0.55;
        ctx.fillStyle = look.planet ? "#5aa9d6" : "rgba(94,196,247,0.8)";
        ctx.beginPath();
        ctx.arc(px, py, look.planet ? 6 : 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    const label = (text: string, y: number, color = "#8d99ad") => {
      ctx.font = "12px 'IBM Plex Mono', monospace";
      ctx.fillStyle = color;
      ctx.fillText(text, 24, y);
    };
    label("하네스 대역 장면 · 실제 엔진 아님", 24);
    if (hint)
      label(
        `ghost ${hint.periodDays.toFixed(4)} d · strength ${hint.strength.toFixed(2)}${hint.selection ? ` · window ${hint.selection.startPhase.toFixed(3)}–${hint.selection.endPhase.toFixed(3)}` : ""}`,
        44,
      );
    if (now - look.transitAt < 5200) label("playTransit", 64, "#5ec4f7");
    if (look.planet)
      label(`revealPlanet ${look.planet.candidateId}`, 84, "#5ec4f7");
    if (look.ignited.length)
      label(`ignite ${look.ignited.join(", ")}`, 104, "#b69cff");
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return {
    controller,
    dispose: () => cancelAnimationFrame(frame),
  };
}
