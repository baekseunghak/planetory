// DEV-only harness: drives every SceneController command without the shell.
// Open /src/cinema/scene/dev/harness.html on the dev server, or mount
// <SceneHarness/> behind an import.meta.env.DEV route. Also exposes
// window.__harness for the Playwright screenshot script (scene-shots.mjs).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Star } from "../../../features/sky-data/contracts";
import { signalSeed } from "../../../features/sky-renderer/personal-system";
import {
  SceneProvider,
  scenePlanet,
  useScene,
  useSceneState,
  type SceneController,
} from "../contract";
import { SceneCanvas } from "../SceneCanvas";
import { GHOST_PLANET_ID } from "../math";
import { decorativeStar } from "../procedural";
import { harnessSky, harnessStar, harnessSystem, ticOf } from "./fake-sky";

const progress = {
  unexplored: "미탐사",
  in_progress: "탐색 중",
  completed: "탐색 완료",
};
const REVEAL_ID = "harness-reveal-1";

type Harness = ReturnType<typeof makeHarnessApi>;
declare global {
  interface Window {
    __harness?: Harness;
    __flux?: [number, number][];
    __harnessMount?: (mounted: boolean) => void;
  }
}

export function SceneHarness() {
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    window.__harnessMount = setMounted;
  }, []);
  return (
    <SceneProvider>
      {mounted && <SceneCanvas />}
      <HarnessOverlay />
    </SceneProvider>
  );
}

function makeHarnessApi(
  scene: SceneController,
  setCount: (n: number) => void,
  setExtra: (s: Star[]) => void,
  stars: () => readonly Star[],
  setPanel: (on: boolean) => void,
  panelHeight: () => number,
  drawFlux: () => void,
) {
  const frame = () =>
    new Promise<void>((r) => requestAnimationFrame(() => r()));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    scene,
    frame,
    wait,
    setCount: async (n: number) => {
      setCount(n);
      await wait(50);
      await frame();
      await frame();
    },
    focus: async (tic: string) => {
      const star = stars().find((s) => s.ticId === tic);
      if (star) scene.setSystem(harnessSystem(star));
      await scene.focusStar(tic);
    },
    analysis: async (on: boolean) => {
      setPanel(on);
      await frame();
      scene.setViewInset({ bottom: on ? panelHeight() : 0, right: 0 });
      scene.setMode(on ? "analysis" : "system");
    },
    hint: (periodDays: number, strength: number, selection: boolean) =>
      scene.setAnalysisHint({
        periodDays,
        strength,
        selection: selection
          ? { startPhase: 0.99, endPhase: 1.01, durationHours: 2 }
          : null,
      }),
    transit: async () => {
      window.__flux = [];
      setPanel(false);
      scene.setViewInset({ bottom: 0, right: 0 });
      await scene.playTransit({
        periodDays: 11.7346,
        depth: 0.008,
        durationHours: 2,
        onFlux: (t, flux) => {
          window.__flux!.push([t, flux]);
          drawFlux();
        },
      });
    },
    reveal: async () => {
      const tic = scene.getState().focusedTicId;
      if (!tic) return;
      await scene.revealPlanet({
        ...scenePlanet({
          candidateId: REVEAL_ID,
          kind: "confirmed",
          periodDays: 11.7346,
          depthPpm: 8000,
        }),
        ticId: tic,
      });
    },
    ignite: async (delayStarMs = 600) => {
      // An ordinal that lands on a spiral arm (not the core, not scattered).
      let ordinal = stars().length + 1;
      while (ordinal % 10 < 2 || ordinal % 7 === 0 || ordinal % 9 === 0)
        ordinal++;
      const star: Star = {
        ...harnessStar(ordinal),
        ticId: "900001001",
        ...decorativeStar(ordinal),
        marker: null,
      };
      const done = scene.ignite(star.ticId);
      setTimeout(() => setExtra([star]), delayStarMs);
      await done;
    },
    effects: (on: boolean) => scene.setEffects(on),
  };
}

function HarnessOverlay() {
  const scene = useScene();
  const state = useSceneState();
  const [count, setCount] = useState(1000);
  const [extra, setExtra] = useState<Star[]>([]);
  const [panel, setPanel] = useState(false);
  const [period, setPeriod] = useState(11.7346);
  const [strength, setStrength] = useState(1);
  const [selection, setSelection] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const sky = useMemo(() => harnessSky(count, extra), [count, extra]);
  const skyRef = useRef(sky);
  skyRef.current = sky;
  const panelRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const fluxRef = useRef<HTMLCanvasElement>(null);
  const note = (text: string) => setLog((l) => [text, ...l].slice(0, 6));

  useEffect(() => scene.setStars(sky.stars, sky.meta), [scene, sky]);

  const drawFluxRef = useRef<() => void>(() => undefined);
  drawFluxRef.current = () => {
    const canvas = fluxRef.current;
    const samples = window.__flux ?? [];
    if (!canvas || !samples.length) return;
    const ratio = devicePixelRatio || 1;
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    const g = canvas.getContext("2d")!;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const y = (f: number) => 8 + ((1 - f) / 0.011) * (h - 16);
    g.strokeStyle = "rgba(150,180,225,.2)";
    g.beginPath();
    g.moveTo(0, y(1));
    g.lineTo(w, y(1));
    g.stroke();
    g.strokeStyle = "#5ec4f7";
    g.lineWidth = 2;
    g.beginPath();
    samples
      .slice()
      .sort((a, b) => a[0] - b[0])
      .forEach(([t, f], i) =>
        i ? g.lineTo(t * w, y(f)) : g.moveTo(t * w, y(f)),
      );
    g.stroke();
  };

  const api = useMemo(
    () =>
      makeHarnessApi(
        scene,
        setCount,
        setExtra,
        () => skyRef.current.stars,
        setPanel,
        () => panelRef.current?.offsetHeight ?? 0,
        () => drawFluxRef.current(),
      ),
    [scene],
  );
  useEffect(() => {
    window.__harness = api;
  });

  // Markers (blue numbered tutorial, red "!" challenge), hover and planet labels.
  useEffect(() => {
    const layer = markersRef.current,
      labels = labelsRef.current;
    if (!layer || !labels) return;
    layer.replaceChildren();
    const marked = sky.stars.filter((s) => s.marker);
    const markers = marked.map((s) => {
      const el = document.createElement("span");
      el.className =
        "h-marker" + (s.marker?.type === "challenge" ? " challenge" : "");
      el.textContent =
        s.marker?.type === "challenge"
          ? "!"
          : String(s.marker?.type === "tutorial" ? s.marker.seq : "");
      layer.appendChild(el);
      return { tic: s.ticId, el };
    });
    const offFrame = scene.onFrame(() => {
      const mode = scene.getState().mode;
      for (const m of markers) {
        const p = mode === "galaxy" ? scene.projectStar(m.tic) : null;
        m.el.hidden = !p?.visible;
        if (p?.visible) m.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      }
      const system = scene.getState().focusedTicId;
      const ids =
        system && (mode === "system" || mode === "analysis")
          ? [
              ...harnessSystem(
                skyRef.current.stars.find((s) => s.ticId === system) ??
                  harnessStar(0),
              ).planets.map((p) => p.candidateId),
              REVEAL_ID,
            ]
          : [];
      const nodes = [...labels.children] as HTMLElement[];
      ids.forEach((id, i) => {
        let el = nodes[i];
        if (!el) {
          el = document.createElement("span");
          el.className = "h-label";
          labels.appendChild(el);
        }
        const p = scene.projectPlanet(id);
        el.hidden = !p?.visible;
        el.textContent = id === REVEAL_ID ? "새 행성" : `행성 ${i + 1}`;
        if (p?.visible)
          el.style.transform = `translate(${p.x}px, ${p.y + p.radius + 6}px)`;
      });
      for (let i = ids.length; i < nodes.length; i++) nodes[i].hidden = true;
      const ghost =
        labels.querySelector<HTMLElement>(".h-ghost") ??
        (() => {
          const el = document.createElement("span");
          el.className = "h-label h-ghost";
          labels.appendChild(el);
          return el;
        })();
      const gp =
        mode === "analysis" ? scene.projectPlanet(GHOST_PLANET_ID) : null;
      ghost.hidden = !gp?.visible;
      if (gp?.visible)
        ghost.style.transform = `translate(${gp.x}px, ${gp.y + gp.radius + 6}px)`;
    });
    const offHover = scene.onStarHover((p) => {
      if (!p) return setHover(null);
      const star = skyRef.current.stars.find((s) => s.ticId === p.ticId);
      setHover(
        star
          ? `TIC ${star.ticId} · 내 행성 ${star.planetCount}개 · ${progress[star.progressStage]}|${p.screen.x}|${p.screen.y}`
          : null,
      );
    });
    const offClick = scene.onStarClick((p) => {
      note(`별 클릭 ${p.ticId}`);
      void api.focus(p.ticId);
    });
    const offPlanet = scene.onPlanetClick((p) => {
      note(`행성 클릭 ${p.candidateId ?? "없음"}`);
      scene.focusPlanet(p.candidateId);
    });
    const offError = scene.onError((e) => note(`오류 ${e.message}`));
    return () => {
      offFrame();
      offHover();
      offClick();
      offPlanet();
      offError();
    };
  }, [scene, sky, api]);

  useEffect(() => {
    api.hint(period, strength, selection);
  }, [period, strength, selection, api]);

  const [hoverText, hx, hy] = hover?.split("|") ?? [];
  const run =
    (label: string, work: () => Promise<unknown> | void) => async () => {
      const t0 = performance.now();
      note(`${label} 시작`);
      await work();
      note(`${label} 끝 ${Math.round(performance.now() - t0)}ms`);
    };
  const focusTic = state.focusedTicId;

  return (
    <>
      <div ref={markersRef} className="h-layer" aria-hidden="true" />
      <div ref={labelsRef} className="h-layer" aria-hidden="true" />
      {hoverText && (
        <div
          className="h-hover"
          style={{
            transform: `translate(${Number(hx) + 12}px, ${Number(hy) - 18}px)`,
          }}
        >
          {hoverText}
        </div>
      )}
      <aside className="h-panel" aria-label="장면 점검">
        <h1>장면 점검</h1>
        <p className="h-state">
          {state.mode} · {state.ready ? "ready" : "loading"}
          {state.failed ? ` · ${state.failed}` : ""} ·{" "}
          {state.busy ? "busy" : "idle"} ·{" "}
          {state.reducedMotion ? "reduced" : "motion"}
          <br />
          focus {focusTic ?? "-"} · planet {state.focusedPlanetId ?? "-"}
        </p>
        <fieldset>
          <legend>별 수</legend>
          {[1000, 10000, 100000].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={count === n}
              onClick={() => void api.setCount(n)}
            >
              {n.toLocaleString("ko-KR")}
            </button>
          ))}
        </fieldset>
        <fieldset>
          <legend>은하</legend>
          <button type="button" onClick={() => scene.setMode("intro")}>
            인트로
          </button>
          <button type="button" onClick={run("진입", () => scene.playIntro())}>
            은하로 진입
          </button>
          <button
            type="button"
            onClick={run("전체", () => scene.showOverview())}
          >
            전체 보기
          </button>
          <button type="button" onClick={() => scene.setMode("backdrop")}>
            배경
          </button>
          <button type="button" onClick={() => scene.setMode("galaxy")}>
            은하
          </button>
          <button
            type="button"
            aria-pressed={state.effects}
            onClick={() => scene.setEffects(!state.effects)}
          >
            빛 효과 {state.effects ? "켬" : "끔"}
          </button>
        </fieldset>
        <fieldset>
          <legend>별과 행성</legend>
          {[0, 7, 9].map((i) => (
            <button
              key={i}
              type="button"
              onClick={run(`별 ${ticOf(i)}`, () => api.focus(ticOf(i)))}
            >
              {ticOf(i)}
            </button>
          ))}
          <button
            type="button"
            onClick={run("복귀", () => scene.returnToGalaxy())}
          >
            은하로 복귀
          </button>
          <button type="button" onClick={() => scene.focusPlanet(null)}>
            항성계 전체
          </button>
          <button
            type="button"
            onClick={() => scene.focusPlanet("fixture-204-p-2")}
          >
            행성 3
          </button>
        </fieldset>
        <fieldset>
          <legend>분석</legend>
          <button
            type="button"
            aria-pressed={panel}
            onClick={() => void api.analysis(!panel)}
          >
            분석 패널 {panel ? "닫기" : "열기"}
          </button>
          <label>
            주기 <output>{period.toFixed(2)}일</output>
            <input
              type="range"
              min={Math.log(0.5)}
              max={Math.log(30)}
              step={0.001}
              value={Math.log(period)}
              onChange={(e) => setPeriod(Math.exp(Number(e.target.value)))}
            />
          </label>
          <label>
            강도 <output>{strength.toFixed(2)}</output>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
            />
          </label>
          <label className="h-check">
            <input
              type="checkbox"
              checked={selection}
              onChange={(e) => setSelection(e.target.checked)}
            />{" "}
            구간 선택
          </label>
          <button
            type="button"
            onClick={run("불일치", () => scene.playMismatch())}
          >
            불일치
          </button>
          <button type="button" onClick={run("통과", () => api.transit())}>
            통과 장면
          </button>
          <button type="button" onClick={run("등장", () => api.reveal())}>
            행성 등장
          </button>
          <button type="button" onClick={run("점화", () => api.ignite())}>
            새 별 점화
          </button>
        </fieldset>
        <ol className="h-log">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </aside>
      <div ref={panelRef} className="h-analysis" hidden={!panel}>
        분석 패널 자리 (setViewInset bottom)
      </div>
      <div className="h-transit" hidden={state.mode !== "transit"}>
        <p>행성이 별 앞을 지나갑니다</p>
        <canvas ref={fluxRef} />
      </div>
      <p className="h-caption">
        표면과 궤도는 이해를 돕기 위한 시각화입니다. · 시드{" "}
        {signalSeed(REVEAL_ID).toFixed(2)}
      </p>
    </>
  );
}
