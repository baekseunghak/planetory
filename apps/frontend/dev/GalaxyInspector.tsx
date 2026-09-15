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
import { readOwnedSystem } from "../src/features/sky-renderer/model";
import type { RendererMetrics } from "../src/features/sky-renderer/renderer";
import "./galaxy-inspector.css";
function Inspector(props: SkySceneProps) {
  const control = useRef<SceneControl | null>(null),
    request = useRef(0);
  const [stats, setStats] = useState<RendererMetrics | null>(null),
    [error, setError] = useState("");
  const ready = useCallback((value: SceneControl | null) => {
    control.current = value;
  }, []);
  const metrics = useCallback((value: RendererMetrics) => setStats(value), []);
  async function scenario(action: string) {
    request.current++;
    const response = await fetch(`/api/dev-galaxy-204/${action}`, {
      method: "POST",
    });
    const result = await response.json();
    if (action === "fail") await props.store.refresh();
    else if (action === "recover") return;
    else publishSkyChange(props.store.memberId, result);
  }
  async function system() {
    const ticket = ++request.current;
    setError("");
    props.store.select("259377017");
    try {
      const value = readOwnedSystem(await api("/v1/me/stars/259377017"));
      if (ticket !== request.current) return;
      control.current?.setCamera(
        { x: value.position.x, y: value.position.y, scale: 5.6, tilt: 0.7 },
        { level: 5 },
      );
      control.current?.setSystem(value);
    } catch (e) {
      if (ticket === request.current) setError(String(e));
    }
  }
  return (
    <>
      <div className="galaxy-inspector-controls">
        <details>
          <summary>204 렌더 검증 도구</summary>
          <p>
            가상 HTTP 응답입니다. 지도 클릭·드래그 연결은 205번에서 진행합니다.
          </p>
          <div>
            <button
              onClick={() =>
                control.current?.setCamera(
                  { x: 0, y: 0, scale: 0.2 },
                  { level: 3 },
                )
              }
            >
              예산 초과 영역
            </button>
            {props.data.meta!.zoomLevels.map((z) => (
              <button
                key={z.level}
                onClick={() => {
                  request.current++;
                  control.current?.setSystem(null);
                  control.current?.setCamera(
                    { scale: z.scale },
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
                  x: (control.current.getCamera()?.x || 0) + 350,
                })
              }
            >
              오른쪽 영역
            </button>
            <button
              onClick={() =>
                control.current?.setCamera({
                  rotation: (control.current.getCamera()?.rotation || 0) + 0.4,
                })
              }
            >
              회전
            </button>
            <button
              onClick={() =>
                control.current?.setCamera({
                  tilt: control.current.getCamera()?.tilt === 0 ? 0.78 : 0,
                })
              }
            >
              기울기
            </button>
            <button onClick={() => void system()}>선택 별의 내 행성</button>
            <button
              onClick={() => {
                request.current++;
                props.store.select(null);
                control.current?.setSystem(null);
                control.current?.setCamera(
                  { x: 0, y: 0, scale: 0.2, tilt: 0.78, rotation: 0.12 },
                  { overview: true },
                );
              }}
            >
              전체 보기
            </button>
          </div>
          <div>
            {[1, 10, 100, 1000].map((n) => (
              <button key={n} onClick={() => void scenario(`reset?count=${n}`)}>
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
        </details>
      </div>
      {error && <p role="alert">{error}</p>}
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
            clusters: props.data.clusters.length,
          })}
        </output>
        <p>
          이 수치는 204번 렌더 예산 검사입니다. 10만 별 전체 성능 인수는 별도로
          진행합니다.
        </p>
      </details>
    </>
  );
}
export function GalaxyInspector() {
  return <SkyDataPage renderScene={(props) => <Inspector {...props} />} />;
}
