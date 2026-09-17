import { useEffect, useMemo, useRef, useState } from "react";
import {
  SkyDataPage,
  type SkySceneProps,
} from "../src/features/sky-data/SkyDataPage";
import {
  orthographicMatrix,
  visibleStarCount,
  transform,
  viewportBounds,
} from "../src/features/sky-data/geometry";
import { publishSkyChange } from "../src/features/sky-data/events";
import "./sky-inspector.css";
function Inspector({ data, store }: SkySceneProps) {
  const [camera, setCamera] = useState(() => ({
    x: (data.meta!.bounds.minX + data.meta!.bounds.maxX) / 2,
    y: (data.meta!.bounds.minY + data.meta!.bounds.maxY) / 2,
    rotation: 0,
    tilt: 0,
    level: 0,
    overview: true,
  }));
  const [dimensions, setDimensions] = useState({ w: 1100, h: 520 });
  const area = useRef<HTMLDivElement>(null),
    meta = data.meta!;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setDimensions({ w: entry.contentRect.width, h: 520 }),
    );
    if (area.current) observer.observe(area.current);
    return () => observer.disconnect();
  }, []);
  const zoom =
    meta.zoomLevels[Math.min(camera.level, meta.zoomLevels.length - 1)];
  const initialScale =
    Math.min(
      dimensions.w / Math.max(1, meta.bounds.maxX - meta.bounds.minX),
      dimensions.h / Math.max(1, meta.bounds.maxY - meta.bounds.minY),
    ) * 0.85;
  const matrix = useMemo(
    () =>
      orthographicMatrix(
        { ...camera, scale: camera.overview ? initialScale : zoom.scale },
        dimensions.w,
        dimensions.h,
        256,
        Math.max(
          10000,
          Math.abs(meta.bounds.minX),
          Math.abs(meta.bounds.maxX),
          Math.abs(meta.bounds.minY),
          Math.abs(meta.bounds.maxY),
        ) * 4,
      ),
    [camera, zoom.scale, initialScale, dimensions, meta.bounds],
  );
  useEffect(() => {
    void store.setView({
      level: zoom.level,
      box: viewportBounds(matrix),
    });
  }, [store, matrix, camera.overview, zoom.level]);
  const point = (x: number, y: number, z = 0) => {
    const p = transform(matrix, { x, y, z });
    return {
      x: ((p.x + 1) * dimensions.w) / 2,
      y: ((1 - p.y) * dimensions.h) / 2,
    };
  };
  async function scenario(kind: "change" | "fail" | "recover") {
    const response = await fetch(`/api/dev-sky-203/${kind}`, {
      method: "POST",
    });
    if (kind === "change" || kind === "fail")
      publishSkyChange(store.memberId, await response.json());
  }
  return (
    <div className="sky-inspector">
      <p className="fixture-note">
        203 개발 검증 화면입니다. 서버 타일 응답과 카메라 범위를 확인하며, 최종
        3D 은하 디자인은 204에서 연결합니다.
      </p>
      <div className="sky-data-controls">
        <label>
          배율 단계{" "}
          <select
            aria-label="배율 단계"
            value={camera.level}
            onChange={(e) =>
              setCamera((c) => ({
                ...c,
                level: Number(e.target.value),
                overview: false,
              }))
            }
          >
            {meta.zoomLevels.map((z) => (
              <option key={z.level} value={z.level}>
                {z.level} · {z.scale}배 · 개별 별
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() =>
            setCamera((c) => ({ ...c, x: c.x - 700, overview: false }))
          }
        >
          왼쪽 영역
        </button>
        <button
          onClick={() =>
            setCamera((c) => ({ ...c, x: c.x + 700, overview: false }))
          }
        >
          오른쪽 영역
        </button>
        <button
          onClick={() =>
            setCamera((c) => ({
              ...c,
              rotation: c.rotation + Math.PI / 6,
              overview: false,
            }))
          }
        >
          30도 회전
        </button>
        <button
          onClick={() =>
            setCamera((c) => ({
              ...c,
              tilt: c.tilt ? 0 : Math.PI / 3,
              overview: false,
            }))
          }
        >
          기울기 전환
        </button>
        <button onClick={() => void store.refresh()}>지도 다시 확인</button>
      </div>
      <div ref={area} className="sky-data-area">
        <svg
          role="img"
          aria-label="수신한 개별 별"
          viewBox={`0 0 ${dimensions.w} ${dimensions.h}`}
        >
          {data.stars.map((s) => {
            const p = point(s.x, s.y, s.depthZ);
            return (
              <g key={s.ticId}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={s.ticId === data.selectedTicId ? 6 : 3}
                  fill={s.ticId === data.selectedTicId ? "#ffe3ae" : "#bddcff"}
                />
                <title>TIC {s.ticId}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <p data-testid="sky-loaded">
        현재 적재: 별 {data.loadedCount}개 · 가시{" "}
        {visibleStarCount(data.stars, matrix)}개
      </p>
      <p data-testid="sky-camera">
        카메라 {camera.x},{camera.y} · 회전 {camera.rotation.toFixed(2)} ·
        기울기 {camera.tilt.toFixed(2)}
      </p>
      <p data-testid="sky-version">
        버전 {meta.version} · {meta.asOf || "기준 시각 미제공"}
      </p>
      <label>
        적재된 별 선택{" "}
        <select
          aria-label="적재된 별 선택"
          value={data.selectedTicId || ""}
          onChange={(e) => store.select(e.target.value || null)}
        >
          <option value="">선택 안 함</option>
          {data.selectedTicId &&
            !data.stars.some((s) => s.ticId === data.selectedTicId) && (
              <option value={data.selectedTicId}>
                TIC {data.selectedTicId} (미적재)
              </option>
            )}
          {data.stars.map((s) => (
            <option key={s.ticId} value={s.ticId}>
              TIC {s.ticId}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>개발 응답 시나리오</summary>
        <button onClick={() => void scenario("change")}>새 발견 응답</button>
        <button onClick={() => void scenario("fail")}>일부 영역 실패</button>
        <button onClick={() => void scenario("recover")}>서버 응답 복구</button>
      </details>
      {data.pageProgress.map((range, i) => (
        <p key={i} data-testid="sky-page-progress">
          페이지 {range.pages} · 범위 {range.loaded}/
          {range.expected ?? "확인 중"}개
        </p>
      ))}
    </div>
  );
}
export function SkyDataInspector() {
  return <SkyDataPage renderScene={(props) => <Inspector {...props} />} />;
}
