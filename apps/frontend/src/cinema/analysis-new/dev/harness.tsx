// Temporary review harness (dev server only, never imported by the app).
// Mounts CinematicAnalysis on /analysis/:ticId with the real session, API and
// bridge, over a static stand-in for the scene. Query:
//   tic=900000010            star to analyse
//   retry=<submissionId>     open the retry flow (retryOfSubmissionId)
//   slowFold=<ms>            delay each fold in the worker (to see progress)
//   log=1                    show the bridge event log
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../../../styles.css";
import "../../styles/tokens.css";
import "../../styles/fonts";
import { SessionProvider, useSession } from "../../../auth/SessionProvider";
import { onAnalysis, type AnalysisEventType } from "../../analysis/bridge";
import { SceneProvider, useScene } from "../../scene/contract";
import { CinematicAnalysis } from "..";
import "./harness.css";

type LoggedEvent = { type: AnalysisEventType; payload: unknown; at: number };
declare global {
  interface Window {
    __cxBridge: LoggedEvent[];
    __cxInset: unknown[];
  }
}

const params = new URLSearchParams(location.search);
const tic = params.get("tic") ?? "900000010";
const retry = params.get("retry");
const slowFold = Number(params.get("slowFold") ?? 0);
const showLog = params.get("log") === "1";

// Delay fold requests inside a wrapped Worker so the progress state can be
// seen. The fold client and worker code are untouched.
if (slowFold > 0) {
  const Native = window.Worker;
  class SlowWorker extends Native {
    postMessage(message: unknown, options?: unknown) {
      const type = (message as { type?: string } | null)?.type;
      if (type === "fold")
        setTimeout(
          () =>
            super.postMessage(message, options as StructuredSerializeOptions),
          slowFold,
        );
      else super.postMessage(message, options as StructuredSerializeOptions);
    }
  }
  window.Worker = SlowWorker as typeof Worker;
}

window.__cxBridge = [];
window.__cxInset = [];
const types: AnalysisEventType[] = [
  "sessionChanged",
  "periodChanged",
  "selectionChanged",
  "stageChanged",
  "submitted",
  "outcome",
  "submitFailed",
];
for (const type of types)
  onAnalysis(type, (payload) =>
    window.__cxBridge.push({ type, payload, at: Date.now() }),
  );

/** A still stand-in for the galaxy: the panel is designed to sit over it. */
function Backdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current!;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = innerWidth,
        height = innerHeight;
      element.width = width * dpr;
      element.height = height * dpr;
      const ctx = element.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      let seed = 7;
      const random = () =>
        ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      for (let i = 0; i < 900; i++) {
        const x = random() * width,
          y = random() * height;
        const warm = random() < 0.25;
        ctx.fillStyle = warm
          ? `rgba(255, 200, 140, ${0.2 + random() * 0.5})`
          : `rgba(160, 190, 255, ${0.15 + random() * 0.45})`;
        const r = random() * 1.1 + 0.2;
        ctx.fillRect(x, y, r, r);
      }
      // The focused star, above the panel.
      const cx = width * 0.5,
        cy = height * 0.2;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120);
      glow.addColorStop(0, "rgba(255, 214, 150, 0.9)");
      glow.addColorStop(0.12, "rgba(255, 170, 90, 0.55)");
      glow.addColorStop(0.4, "rgba(255, 120, 60, 0.08)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(cx - 120, cy - 120, 240, 240);
      ctx.strokeStyle = "rgba(94, 196, 247, 0.35)";
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, 190, 46, 0, 0, Math.PI * 2);
      ctx.stroke();
    };
    draw();
    addEventListener("resize", draw);
    return () => removeEventListener("resize", draw);
  }, []);
  return (
    <canvas ref={canvas} className="cx-harness-backdrop" aria-hidden="true" />
  );
}

function EventLog() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const offs = types.map((type) =>
      onAnalysis(type, () => setTick((v) => v + 1)),
    );
    return () => offs.forEach((off) => off());
  }, []);
  return (
    <ol className="cx-harness-log" aria-label="브리지 이벤트">
      {window.__cxBridge.slice(-8).map((event, index) => (
        <li key={index}>
          {event.type} {JSON.stringify(event.payload).slice(0, 90)}
        </li>
      ))}
    </ol>
  );
}

/** Records what the panel tells the scene (the no-op controller drops it). */
function InsetProbe() {
  const scene = useScene();
  useEffect(() => {
    const original = scene.setViewInset.bind(scene);
    scene.setViewInset = (inset) => {
      window.__cxInset.push(inset);
      original(inset);
    };
  }, [scene]);
  return null;
}

function Harness() {
  const session = useSession();
  if (session.status !== "authenticated")
    return <p className="cx-harness-wait">세션 확인 중… ({session.status})</p>;
  return (
    <SceneProvider>
      <InsetProbe />
      <Backdrop />
      <div className="cx-harness-brand">PLANETORY</div>
      <Routes>
        <Route path="/analysis/:ticId" element={<CinematicAnalysis />} />
        <Route
          path="*"
          element={<p className="cx-harness-wait">분석 화면 밖입니다.</p>}
        />
      </Routes>
      {showLog && <EventLog />}
    </SceneProvider>
  );
}

const entry =
  `/analysis/${tic}?returnTo=${encodeURIComponent(`/sky?star=${tic}`)}` +
  (retry ? `&retryOfSubmissionId=${encodeURIComponent(retry)}` : "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter initialEntries={[entry]}>
      <SessionProvider>
        <Harness />
      </SessionProvider>
    </MemoryRouter>
  </StrictMode>,
);
