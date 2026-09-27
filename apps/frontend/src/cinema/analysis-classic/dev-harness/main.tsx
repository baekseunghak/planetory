// Dev harness for ClassicAnalysis (temporary, until the cinema shell is wired).
// Renders the classic panel exactly as the /analysis/:ticId route will, over a
// 2D stand-in scene, and maps bridge events to scene calls the way the shell
// is expected to. Query: ?tic=<TIC> (default 900000010), ?switch=1 renders
// AnalysisSwitch (with its variant toggle) instead of ClassicAnalysis alone.
import {
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "../../../auth/SessionProvider";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import {
  onAnalysis,
  type AnalysisBridgeEvents,
  type AnalysisEventType,
} from "../../analysis/bridge";
import {
  SceneProvider,
  scenePlanet,
  useRegisterScene,
  useScene,
  type AnalysisHint,
  type SceneController,
} from "../../scene/contract";
import { ClassicAnalysis } from "..";
import { createStandInScene } from "./stand-in-scene";
import "../../../styles.css";
import "../../styles/fonts";
import "./harness.css";

type LogEntry = { type: AnalysisEventType; payload: unknown; at: number };
declare global {
  interface Window {
    __classicBridgeLog?: LogEntry[];
  }
}

// Record every bridge event from the very first one.
const log: LogEntry[] = (window.__classicBridgeLog = []);
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
    log.push({ type, payload, at: Math.round(performance.now()) }),
  );

const params = new URLSearchParams(location.search);
const tic = params.get("tic") ?? "900000010";
const entry = `/analysis/${tic}?returnTo=${encodeURIComponent(`/sky?star=${tic}`)}`;
const Switch = lazy(async () => ({
  default: (await import("../../analysis/AnalysisSwitch"))
    .AnalysisSwitch as ComponentType,
}));

function StandInCanvas() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [controller, setController] = useState<SceneController | null>(null);
  useEffect(() => {
    const scene = createStandInScene(canvas.current!);
    setController(scene.controller);
    return scene.dispose;
  }, []);
  useRegisterScene(controller);
  return <canvas ref={canvas} className="harness-scene" aria-hidden="true" />;
}

/** What the shell is expected to do with the bridge (see src/cinema/README.md). */
function BridgeToScene() {
  const scene = useScene();
  const hint = useRef<AnalysisHint | null>(null);
  useEffect(() => {
    const set = (next: AnalysisHint | null) => {
      hint.current = next;
      scene.setAnalysisHint(next);
    };
    const on = <K extends AnalysisEventType>(
      type: K,
      fn: (payload: AnalysisBridgeEvents[K]) => void,
    ) => onAnalysis(type, fn);
    const off = [
      on("sessionChanged", ({ ticId, active }) => {
        if (active) {
          scene.setMode("analysis");
          void scene.focusStar(ticId);
        } else set(null);
      }),
      on("periodChanged", ({ periodDays, strength }) =>
        set({ periodDays, strength, selection: null }),
      ),
      on("selectionChanged", ({ selection }) => {
        if (!hint.current) return;
        set({
          ...hint.current,
          selection: selection && {
            startPhase: selection.startPhase,
            endPhase: selection.endPhase,
            durationHours: selection.durationHours,
          },
        });
      }),
      on("outcome", async (outcome) => {
        if (outcome.kind === "numericMismatch") {
          await scene.playMismatch();
          return;
        }
        if (!outcome.firstView) return;
        const planet = outcome.planet;
        if (planet && outcome.revealsPlanet) {
          await scene.playTransit({
            periodDays: planet.periodDays,
            depth: planet.depthPpm / 1e6,
            durationHours: planet.durationHours,
          });
          await scene.revealPlanet({
            ticId: outcome.ticId,
            ...scenePlanet({
              candidateId: planet.candidateId,
              kind:
                planet.disposition === "CONFIRMED"
                  ? "confirmed"
                  : "unconfirmed",
              periodDays: planet.periodDays,
              depthPpm: planet.depthPpm,
            }),
          });
        }
        for (const unlocked of outcome.achievement.unlockedTicIds)
          void scene.ignite(unlocked);
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [scene]);
  return null;
}

function Analysis() {
  const { status } = useSession();
  const useSwitch = params.get("switch") === "1";
  const element = useMemo(
    () =>
      useSwitch ? (
        <Suspense fallback={null}>
          <Switch />
        </Suspense>
      ) : (
        <ClassicAnalysis />
      ),
    [useSwitch],
  );
  if (status !== "authenticated")
    return <p className="harness-status">세션 확인 중 ({status})</p>;
  return (
    <Routes>
      <Route path="/analysis/:ticId" element={element} />
      <Route
        path="*"
        element={<p className="harness-status">하네스 밖 경로</p>}
      />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <SceneProvider>
        <StandInCanvas />
        <BridgeToScene />
        <MemoryRouter initialEntries={[entry]}>
          <SessionProvider>
            <Analysis />
          </SessionProvider>
        </MemoryRouter>
      </SceneProvider>
    </ErrorBoundary>
  </StrictMode>,
);
