import { useCallback, useRef, useState } from "react";
import { api } from "../src/api";
import {
  SkyDataPage,
  type SkySceneProps,
} from "../src/features/sky-data/SkyDataPage";
import { publishSkyChange } from "../src/features/sky-data/events";
import {
  GalaxyScene,
  type SceneControl,
} from "../src/features/sky-renderer/GalaxyScene";
import {
  INITIAL_CAMERA,
  cameraMatrix,
  screenPoint,
  readOwnedSystem,
  type GalaxyCamera,
} from "../src/features/sky-renderer/model";
import type { RendererMetrics } from "../src/features/sky-renderer/renderer";
import "./galaxy-inspector.css";
const referenceCamera = {
  ...INITIAL_CAMERA,
  x: 0.8116955263673162,
  y: -104.409147077857,
  zoom: 1.0568820479252328,
};
function Inspector(props: SkySceneProps) {
  const control = useRef<SceneControl | null>(null),
    request = useRef(0),
    returnCamera = useRef<GalaxyCamera | null>(null);
  const [stats, setStats] = useState<RendererMetrics | null>(null),
    [error, setError] = useState("");
  const [reference, setReference] = useState(
    new URLSearchParams(location.search).get("reference") === "1",
  );
  const ready = useCallback((value: SceneControl | null) => {
    control.current = value;
  }, []);
  const metrics = useCallback((value: RendererMetrics) => setStats(value), []);
  async function scenario(action: string) {
    request.current++;
    setError("");
    const response = await fetch("/api/dev-galaxy-204/" + action, {
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok) {
      setError(result.message);
      return;
    }
    if (action === "fail") await props.store.refresh();
    else if (action === "recover") return;
    else publishSkyChange(props.store.memberId, result);
  }
  async function system() {
    const ticket = ++request.current;
    const id = "900000001";
    setError("");
    props.store.select(id);
    returnCamera.current = control.current?.getCamera() ?? null;
    try {
      const value = readOwnedSystem(
        await api("/v1/me/stars/" + id),
        props.data.meta!,
        id,
        props.data.stars.find((s) => s.ticId === id),
      );
      if (ticket !== request.current) return;
      const c = control.current?.getCamera() ?? INITIAL_CAMERA;
      const projected = screenPoint(
        cameraMatrix({ ...c, x: 0, y: 0, zoom: 1 }, 3100, 2020),
        3100,
        2020,
        value.position.x,
        value.position.y,
        value.position.depthZ,
      );
      control.current?.setCamera({
        x: projected.x - 1550,
        y: projected.y - 2020 * 0.46,
        zoom: 8,
      });
      control.current?.setSystem(value);
    } catch (e) {
      if (ticket === request.current) setError(String(e));
    }
  }
  function back() {
    request.current++;
    props.store.select(null);
    control.current?.setSystem(null);
    if (returnCamera.current) control.current?.setCamera(returnCamera.current);
  }
  return (
    <div
      className={
        "galaxy-inspection" + (reference ? " galaxy-reference-mode" : "")
      }
    >
      <div className="galaxy-inspector-controls">
        <details>
          <summary>204 렌더 검증 도구</summary>
          <p>
            가상 HTTP 자료 · 지도 클릭·드래그·휠 연결은 205번에서 진행합니다.
          </p>
          <a href="/dev/galaxy-comparison">이전 군집 비교 보관본</a>
          <div>
            <button onClick={() => setReference((v) => !v)}>
              시각 비교 화면
            </button>
            <button
              onClick={() => {
                props.store.select(null);
                control.current?.setSystem(null);
                control.current?.setCamera(referenceCamera);
              }}
            >
              원본 카메라
            </button>
            {props.data.meta!.zoomLevels.map((z) => (
              <button
                key={z.level}
                onClick={() => {
                  request.current++;
                  props.store.select(null);
                  control.current?.setSystem(null);
                  control.current?.setCamera(
                    { zoom: z.scale },
                    { level: z.level },
                  );
                }}
              >
                LOD {z.level}
              </button>
            ))}
          </div>
          <div>
            <button
              onClick={() =>
                control.current?.setCamera({
                  x: (control.current.getCamera()?.x ?? 0) + 350,
                })
              }
            >
              오른쪽 영역
            </button>
            <button
              onClick={() =>
                control.current?.setCamera({
                  yaw: (control.current.getCamera()?.yaw ?? 0) + 0.6,
                  tilt: 1.1575,
                })
              }
            >
              회전
            </button>
            <button
              onClick={() =>
                control.current?.setCamera({
                  tilt: control.current.getCamera()?.tilt === 0 ? 1 : 0,
                })
              }
            >
              기울기
            </button>
            <button onClick={() => void system()}>선택 별의 내 행성</button>
            <button onClick={back}>은하로 복귀</button>
            <button
              onClick={() => {
                request.current++;
                props.store.select(null);
                control.current?.fitAll();
              }}
            >
              전체 보기
            </button>
          </div>
          <div>
            {[1, 10, 100, 1000, 2501].map((n) => (
              <button key={n} onClick={() => void scenario("reset?count=" + n)}>
                별 {n}개 계정
              </button>
            ))}
            <button onClick={() => void scenario("change")}>
              새 발견 응답
            </button>
            <button onClick={() => void scenario("status")}>
              행성 없는 완료 응답
            </button>
            <button onClick={() => void scenario("fail")}>
              일부 영역 실패
            </button>
            <button onClick={() => void scenario("recover")}>응답 복구</button>
            <button onClick={() => void scenario("empty")}>빈 응답</button>
          </div>
          <p data-testid="selected-info">
            {props.data.stars.find((s) => s.ticId === props.data.selectedTicId)
              ?.completedWithoutPlanets
              ? "행성 없이 완료"
              : ""}
          </p>
        </details>
      </div>
      {error && (
        <p className="galaxy-dev-error" role="alert">
          {error}
        </p>
      )}
      <GalaxyScene {...props} onReady={ready} onMetrics={metrics} />
      <details className="galaxy-measure">
        <summary>렌더 계측</summary>
        <output data-testid="render-stats">{JSON.stringify(stats)}</output>
        <output data-testid="render-view">
          {JSON.stringify({
            level: props.data.view?.level,
            version: props.data.meta?.version,
            camera: control.current?.getCamera(),
            stars: props.data.stars.length,
            total: props.data.meta?.starCount,
            pending: props.data.pending,
          })}
        </output>
        <p>10만 별 성능 인수는 별도로 진행합니다.</p>
      </details>
    </div>
  );
}
export function GalaxyInspector() {
  return (
    <SkyDataPage
      renderScene={(props) => (
        <Inspector key={props.store.memberId} {...props} />
      )}
    />
  );
}
