import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Minus,
  Maximize,
  Search,
  List,
  ChevronDown,
  ChevronRight,
  X,
  ArrowUpRight,
  Orbit,
  Move,
} from "lucide-react";
import type { Page, Quests, StarDetail, StarNode } from "../../shared/types";
import { STATUSES, TYPES } from "../../shared/types";
import {
  INITIAL_CAMERA,
  MIN_ZOOM,
  MAX_ZOOM,
  DETAIL_ZOOM,
  zoomCamera,
  zoomLabel,
  project,
  sceneScale,
  sceneCenterX,
  readCamera,
  readGalaxyData,
  type GalaxyCamera,
  type GalaxyData,
  type GalaxyStar,
} from "../../shared/galaxy";
import { api, mutation, query } from "../api/client";
import { useResource } from "../api/hooks";
import {
  ActionError,
  Empty,
  Grade,
  Pager,
  RequestState,
  Status,
  useAction,
} from "../components/ui";
import { useApp } from "../App";
import { GalaxyRenderer } from "../map/galaxy-renderer";
import { starColor } from "../map/renderer";
import "../galaxy.css";

function readDisplay<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function SkyPage() {
  const {
    member,
    guide,
    setGuide,
    refresh,
    startGuide,
    guideStarId,
    advanceGuide,
  } = useApp();
  const navigate = useNavigate(),
    [params, setParams] = useSearchParams(),
    selected = params.get("star");
  const resource = useResource<unknown>("/map/galaxy"),
    quests = useResource<Quests>("/quests"),
    detail = useResource<StarDetail>(selected ? "/stars/" + selected : null);
  const [data, setData] = useState<GalaxyData | null>(null),
    [mapError, setMapError] = useState("");
  const manifest = { ...resource, data };
  const [view, setView] = useState<GalaxyCamera>(() =>
    readCamera(readDisplay("planetory-galaxy-camera", INITIAL_CAMERA)),
  );
  const [fallback, setFallback] = useState(false),
    [showList, setShowList] = useState(false),
    [retry, setRetry] = useState(0);
  const [tooltip, setTooltip] = useState<{
      x: number;
      y: number;
      text: string;
    } | null>(null),
    [hovered, setHovered] = useState<GalaxyStar | null>(null);
  const [listQuery, setListQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [grade, setGrade] = useState("all"),
    [page, setPage] = useState(1);
  const list = useResource<Page<StarNode>>(
    showList || fallback
      ? "/stars?" + query({ query: listQuery, status, grade, page })
      : null,
  );
  const [collapsed, setCollapsed] = useState(() =>
    readDisplay("planetory-galaxy-quests", { tutorial: true, challenge: true }),
  );
  const [interaction, setInteraction] = useState<"rotate" | "pan">("rotate");
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    renderer = useRef<GalaxyRenderer | null>(null);
  const [dimensions, setDimensions] = useState({ w: 1440, h: 850 });
  const live = useRef({ view, data, selected });
  live.current = { view, data, selected };
  const drag = useRef<{
    x: number;
    y: number;
    view: GalaxyCamera;
    moved: boolean;
    pan: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const reducedMotion = useMemo(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const initialized = useRef(false),
    a = useAction(),
    guideAction = useAction();
  const starMap = useMemo(
    () => new Map(data?.stars.map((s) => [s.id, s]) || []),
    [data],
  );
  const highlighted = selected ? starMap.get(selected) : undefined;
  const tutorialMarkers = useMemo(
    () => data?.stars.filter((s) => s.tutorial || s.challenge) || [],
    [data],
  );
  const markerStars = useMemo(() => {
    const visible = new Map<string, GalaxyStar>();
    for (const s of tutorialMarkers) visible.set(s.id, s);
    if (highlighted) visible.set(highlighted.id, highlighted);
    if (hovered) visible.set(hovered.id, hovered);
    return [...visible.values()];
  }, [tutorialMarkers, highlighted, hovered]);
  useEffect(() => {
    if (!resource.data) return;
    try {
      setData(readGalaxyData(resource.data));
      setMapError("");
    } catch (e) {
      setMapError((e as Error).message);
    }
  }, [resource.data]);
  useEffect(() => {
    if (retry) resource.reload();
  }, [retry]);
  useEffect(() => {
    sessionStorage.setItem("planetory-galaxy-camera", JSON.stringify(view));
  }, [view]);
  useEffect(() => {
    sessionStorage.setItem(
      "planetory-galaxy-quests",
      JSON.stringify(collapsed),
    );
  }, [collapsed]);
  useEffect(() => {
    if (!data || initialized.current) return;
    initialized.current = true;
    if (!selected && !params.has("entry") && starMap.has("259377017"))
      setParams({ star: "259377017" }, { replace: true });
  }, [data]);
  useEffect(() => {
    if (detail.data) advanceGuide(detail.data.id, "star_selected");
  }, [detail.data]);
  const acknowledgeGuide = () =>
    guideAction.run(async () => {
      await mutation("/me/guide", {});
      await refresh();
    });
  useEffect(() => {
    if (!container.current) return;
    const host = container.current;
    const resize = new ResizeObserver(() =>
      setDimensions({ w: host.clientWidth, h: host.clientHeight }),
    );
    resize.observe(host);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const create = () => {
      try {
        renderer.current?.destroy();
        renderer.current = new GalaxyRenderer(c);
        if (live.current.data)
          renderer.current.setStars(live.current.data.stars);
        setFallback(false);
      } catch {
        setFallback(true);
        setShowList(true);
      }
    };
    create();
    const lost = (e: Event) => {
      e.preventDefault();
      setFallback(true);
      setShowList(true);
    };
    c.addEventListener("webglcontextlost", lost);
    c.addEventListener("webglcontextrestored", create);
    let frame = 0;
    const draw = () => {
      if (!document.hidden && renderer.current) {
        renderer.current.select(live.current.selected);
        renderer.current.draw(live.current.view);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      c.removeEventListener("webglcontextlost", lost);
      c.removeEventListener("webglcontextrestored", create);
      renderer.current?.destroy();
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    if (data) renderer.current?.setStars(data.stars);
  }, [data]);
  const fit = useCallback(() => {
    setView({ ...INITIAL_CAMERA });
    setTooltip(null);
    setHovered(null);
  }, []);
  const zoom = useCallback(
    (
      factor: number,
      px = sceneCenterX(dimensions.w),
      py = dimensions.h * 0.46,
      anchorStar?: GalaxyStar,
    ) => {
      setView((v) => {
        // Wheel coordinates can be rounded to CSS pixels. Use the exact star
        // center when pointing at a marker so that error cannot grow with zoom.
        const anchor = anchorStar
          ? project(anchorStar, v, dimensions.w, dimensions.h)
          : { x: px, y: py };
        return zoomCamera(
          v,
          factor,
          dimensions.w,
          dimensions.h,
          anchor.x,
          anchor.y,
        );
      });
      setTooltip(null);
      setHovered(anchorStar ?? null);
    },
    [dimensions],
  );
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const wheel = (e: WheelEvent) => {
      if (
        (e.target as Element).closest("button,aside,input,select") &&
        !(e.target as Element).closest(".star-hit")
      )
        return;
      e.preventDefault();
      const b = host.getBoundingClientRect();
      const marker = (e.target as Element).closest<HTMLElement>(".star-hit");
      const anchorStar = marker
        ? renderer.current?.getStar(marker.dataset.starId || "")
        : undefined;
      const pixels =
        e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.height : 1);
      zoom(
        Math.exp(-Math.max(-2400, Math.min(2400, pixels)) * 0.0012),
        e.clientX - b.left,
        e.clientY - b.top,
        anchorStar,
      );
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [zoom]);
  const select = (n: Pick<StarNode, "id" | "x" | "y">) => {
    setParams({ star: n.id });
    setTooltip(null);
    setHovered(null);
    const s = starMap.get(n.id);
    if (!s) return;
    setView((v) => {
      const next = { ...v, x: 0, y: 0, zoom: Math.max(1.8, v.zoom) },
        p = project(s, next, dimensions.w, dimensions.h),
        scale = sceneScale(dimensions.w, dimensions.h, next.zoom);
      return {
        ...next,
        x: (p.x - dimensions.w * 0.57) / scale,
        y: (p.y - dimensions.h * 0.52) / scale,
      };
    });
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = container.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) {
      const d = drag.current,
        dx = e.clientX - d.x,
        dy = e.clientY - d.y;
      d.moved ||= Math.hypot(dx, dy) > 4;
      if (!d.moved) return;
      suppressClick.current = true;
      setView(
        d.pan
          ? readCamera({
              ...d.view,
              x:
                d.view.x -
                dx / sceneScale(dimensions.w, dimensions.h, d.view.zoom),
              y:
                d.view.y -
                dy / sceneScale(dimensions.w, dimensions.h, d.view.zoom),
            })
          : readCamera({
              ...d.view,
              yaw: d.view.yaw + dx * 0.004,
              tilt: d.view.tilt + dy * 0.0035,
            }),
      );
      setTooltip(null);
      setHovered(null);
      return;
    }
    if (
      view.zoom < DETAIL_ZOOM ||
      (e.target as Element).closest("button,.galaxy-orbits")
    )
      return;
    const p = local(e),
      s = renderer.current?.hit(p.x, p.y, view) || null;
    setHovered((old) => (old?.id === s?.id ? old : s));
    setTooltip(
      s ? { ...p, text: "TIC " + s.id + " · " + STATUSES[s.status] } : null,
    );
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.moved) {
      const p = local(e),
        s = renderer.current?.hit(p.x, p.y, view);
      setParams(s ? { star: s.id } : {});
      setTooltip(null);
    }
  };
  const selectedPoint = highlighted
    ? project(highlighted, view, dimensions.w, dimensions.h)
    : null;
  const pointOnScreen =
    view.zoom >= DETAIL_ZOOM &&
    selectedPoint &&
    selectedPoint.x > 0 &&
    selectedPoint.y > 0 &&
    selectedPoint.x < dimensions.w &&
    selectedPoint.y < dimensions.h;
  return (
    <main
      className="sky-page galaxy-page"
      data-star-count={data?.count}
      data-scene="galaxy-demo"
    >
      <div
        className="sky-surface"
        ref={container}
        tabIndex={0}
        aria-label="은하 별 지도. 드래그 회전, Shift 드래그 이동, 방향키 이동, 더하기와 빼기로 확대 축소, Home 전체 보기"
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (
            [
              "+",
              "=",
              "-",
              "Home",
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Escape",
            ].includes(e.key)
          )
            e.preventDefault();
          if (e.key === "Home") fit();
          else if (e.key === "+" || e.key === "=") zoom(1.25);
          else if (e.key === "-") zoom(0.8);
          else if (e.key === "Escape") setParams({});
          else {
            const moves: Record<string, [number, number]> = {
              ArrowLeft: [-80, 0],
              ArrowRight: [80, 0],
              ArrowUp: [0, -80],
              ArrowDown: [0, 80],
            };
            if (moves[e.key])
              setView((v) =>
                readCamera({
                  ...v,
                  x:
                    v.x +
                    moves[e.key][0] /
                      sceneScale(dimensions.w, dimensions.h, v.zoom),
                  y:
                    v.y +
                    moves[e.key][1] /
                      sceneScale(dimensions.w, dimensions.h, v.zoom),
                }),
              );
          }
        }}
        onPointerDown={(e) => {
          if (
            ![0, 2].includes(e.button) ||
            ((e.target as Element).closest(
              "button,aside,a,input,select,.galaxy-orbits",
            ) &&
              !(e.target as Element).closest(".star-hit"))
          )
            return;
          suppressClick.current = false;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            view: { ...view },
            moved: false,
            pan: interaction === "pan" || e.shiftKey || e.button === 2,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={pointerMove}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          setTooltip(null);
          setHovered(null);
        }}
      >
        <canvas ref={canvas} aria-hidden="true" hidden={fallback} />
        {!fallback &&
          view.zoom >= DETAIL_ZOOM &&
          markerStars.map((s) => {
            const p = project(s, view, dimensions.w, dimensions.h);
            if (p.x < 0 || p.y < 0 || p.x > dimensions.w || p.y > dimensions.h)
              return null;
            return (
              <button
                key={s.id}
                className={
                  "star-hit " +
                  (s.id === selected ? "selected" : "") +
                  (s.id === hovered?.id ? " hovered" : "")
                }
                style={{ left: p.x, top: p.y }}
                data-star-id={s.id}
                aria-label={"TIC " + s.id + " · " + STATUSES[s.status]}
                onClick={(e) => {
                  if (e.detail > 0 && suppressClick.current) return;
                  setParams({ star: s.id });
                  setTooltip(null);
                }}
                onMouseEnter={() =>
                  setTooltip({
                    x: p.x,
                    y: p.y,
                    text: "TIC " + s.id + " · 행성 " + s.planetCount + "개",
                  })
                }
                onMouseLeave={() => setTooltip(null)}
              >
                <span className="star-focus-ring" />
                {s.tutorial && (
                  <span className="quest-marker tutorial">{s.tutorial}</span>
                )}
                {s.challenge && (
                  <span className="quest-marker challenge">!</span>
                )}
                <span className="star-name">TIC {s.id}</span>
              </button>
            );
          })}
        {!fallback && pointOnScreen && selectedPoint && (
          <>
            <svg
              className="galaxy-connector"
              width={dimensions.w}
              height={dimensions.h}
              aria-hidden="true"
            >
              <path
                d={
                  "M " +
                  (selectedPoint.x + 24) +
                  " " +
                  (selectedPoint.y - 16) +
                  " L " +
                  (dimensions.w - (dimensions.w < 1200 ? 344 : 372)) +
                  (dimensions.w < 1200 ? " 132 L " : " 192 L ") +
                  (dimensions.w - (dimensions.w < 1200 ? 304 : 332)) +
                  (dimensions.w < 1200 ? " 132" : " 192")
                }
              />
            </svg>
            {detail.data && detail.data.planetCount > 0 && (
              <svg
                className="galaxy-orbits"
                width="200"
                height="140"
                style={{
                  left: selectedPoint.x - 100,
                  top: selectedPoint.y - 70,
                  transform: `scale(${Math.min(1, view.zoom)})`,
                }}
                aria-label="선택한 별의 행성 궤도"
              >
                {detail.data.knownSignals
                  .filter(
                    (s) =>
                      s.type === "confirmed" ||
                      (s.type === "unconfirmed" &&
                        s.judgment === "LIKELY_PLANET"),
                  )
                  .map((s, i) => {
                    const rx = 34 + i * 15,
                      ry =
                        rx *
                        Math.max(0.2, Math.abs(Math.cos(view.tilt)) * 0.52),
                      path =
                        "M " +
                        (100 - rx) +
                        " 70 a " +
                        rx +
                        " " +
                        ry +
                        " 0 1 0 " +
                        2 * rx +
                        " 0 a " +
                        rx +
                        " " +
                        ry +
                        " 0 1 0 " +
                        -2 * rx +
                        " 0";
                    return (
                      <g key={s.id}>
                        <ellipse cx="100" cy="70" rx={rx} ry={ry} />
                        <circle
                          className="orbit-planet"
                          r="4"
                          cx={reducedMotion ? 100 + rx : 0}
                          cy={reducedMotion ? 70 : 0}
                          fill={i % 2 ? "#b9d5ff" : "#efc59c"}
                          onPointerEnter={(e) => {
                            const p = local(e);
                            setTooltip({
                              ...p,
                              text:
                                TYPES[s.type] +
                                " · 반복 주기 " +
                                s.period +
                                "일 · 어두워진 정도 " +
                                s.depth +
                                "%",
                            });
                          }}
                          onPointerLeave={() => setTooltip(null)}
                        >
                          {!reducedMotion && (
                            <animateMotion
                              dur={18 + i * 13 + "s"}
                              repeatCount="indefinite"
                              path={path}
                            />
                          )}
                        </circle>
                      </g>
                    );
                  })}
              </svg>
            )}
          </>
        )}
        {tooltip && !drag.current && (
          <div
            role="tooltip"
            className="sky-tooltip"
            style={{
              left: Math.max(10, Math.min(dimensions.w - 360, tooltip.x + 18)),
              top: Math.max(10, tooltip.y - 47),
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
      <div className="sky-heading">
        <p className="eyebrow">YOUR NIGHT SKY</p>
        <h1>나의 밤하늘</h1>
        <p>내가 발견한 별들이 모이는 곳</p>
        <strong>
          {manifest.data?.count.toLocaleString() || "—"}{" "}
          <small>시연용 별</small>
        </strong>
      </div>
      <aside className="quest-panel">
        <section>
          <button
            className="quest-heading"
            aria-expanded={!collapsed.tutorial}
            onClick={() =>
              setCollapsed((v) => ({ ...v, tutorial: !v.tutorial }))
            }
          >
            <span>
              튜토리얼{" "}
              <small>
                {quests.data?.tutorials.filter(
                  (t) => t.state === "complete" || t.state === "skipped",
                ).length || 0}
                /5
              </small>
            </span>
            {collapsed.tutorial ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronDown size={16} />
            )}
          </button>
          {!collapsed.tutorial &&
            quests.data?.tutorials.map((t) => (
              <button
                key={t.id}
                className={"quest-item " + t.state}
                disabled={t.state === "locked"}
                onClick={() =>
                  a.run(async () => {
                    const d = await api<StarDetail>("/stars/" + t.id);
                    select(d);
                  })
                }
              >
                <span>{t.number}</span>
                <div>
                  {t.purpose}
                  <small>
                    {
                      {
                        locked: "아직 못 찾은 별",
                        ready: "시작하기",
                        in_progress: "진행 중",
                        complete: "안내 완료",
                        skipped: "건너뛰어 완료",
                      }[t.state]
                    }
                  </small>
                </div>
              </button>
            ))}
        </section>
        <section>
          <button
            className="quest-heading"
            aria-expanded={!collapsed.challenge}
            onClick={() =>
              setCollapsed((v) => ({ ...v, challenge: !v.challenge }))
            }
          >
            <span>
              이번 주 챌린지 <b className="red">!</b>
            </span>
            {collapsed.challenge ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronDown size={16} />
            )}
          </button>
          {!collapsed.challenge && quests.data && (
            <div className="challenge-copy">
              <strong>TIC {quests.data.challenge.id}</strong>
              <p>{quests.data.challenge.description}</p>
              <small>
                {quests.data.challenge.start.slice(0, 10)} ~{" "}
                {quests.data.challenge.end.slice(0, 10)}
                <br />
                {Math.max(
                  0,
                  Math.ceil(
                    (+new Date(quests.data.challenge.end) - Date.now()) /
                      86400000,
                  ),
                )}
                일 남음 · 참여 {quests.data.challenge.participants}명
              </small>
              <p>
                {quests.data.challenge.unlocked
                  ? STATUSES[quests.data.challenge.status]
                  : "튜토리얼 다섯 개 완료 후 열립니다."}
              </p>
              <button
                disabled={!quests.data.challenge.unlocked}
                onClick={() =>
                  navigate("/analysis/" + quests.data!.challenge.id)
                }
              >
                별 분석하기 <ArrowUpRight size={14} />
              </button>
            </div>
          )}
        </section>
        {quests.data?.reopened.map((n) => (
          <Link key={n.id} className="reopened" to={"/analysis/" + n.id}>
            TIC {n.id}
            <br />
            새로 찾을 수 있는 신호가 생겼습니다 → 다시 분석
          </Link>
        ))}
        <ActionError message={a.error} />
        <RequestState state={quests} />
      </aside>
      <div className="map-tools">
        <button
          aria-label="회전 모드"
          aria-pressed={interaction === "rotate"}
          onClick={() => setInteraction("rotate")}
        >
          <Orbit size={17} />
        </button>
        <button
          aria-label="이동 모드"
          aria-pressed={interaction === "pan"}
          onClick={() => setInteraction("pan")}
        >
          <Move size={17} />
        </button>
        <button
          aria-label="별 검색과 목록"
          onClick={() => setShowList(!showList)}
        >
          <Search size={17} />
        </button>
        <button
          aria-label="확대"
          onClick={() => zoom(1.25)}
          disabled={view.zoom >= MAX_ZOOM}
        >
          <Plus size={17} />
        </button>
        <button
          aria-label="축소"
          onClick={() => zoom(0.8)}
          disabled={view.zoom <= MIN_ZOOM}
        >
          <Minus size={17} />
        </button>
        <button aria-label="전체 보기" onClick={fit}>
          <Maximize size={17} />
        </button>
        <span aria-label="현재 배율">{zoomLabel(view.zoom)}</span>
      </div>
      <p className="galaxy-instructions">
        {interaction === "rotate" ? "드래그로 회전" : "드래그로 이동"} · 휠로
        확대/축소 · Shift + 드래그로 이동
      </p>
      {(showList || fallback) && (
        <aside className="map-list-panel">
          <div className="modal-head">
            <h2>{fallback ? "별 목록 · WebGL 대체" : "발견한 별"}</h2>
            {!fallback && (
              <button aria-label="목록 닫기" onClick={() => setShowList(false)}>
                <X size={16} />
              </button>
            )}
          </div>
          <div className="filters">
            <label>
              TIC 검색
              <input
                value={listQuery}
                onChange={(e) => {
                  setListQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="TIC ID"
              />
            </label>
            <label>
              진행
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">전체</option>
                {Object.entries(STATUSES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              등급
              <select
                value={grade}
                onChange={(e) => {
                  setGrade(e.target.value);
                  setPage(1);
                }}
              >
                {["all", "—", "A", "S", "SS", "SSS"].map((g) => (
                  <option key={g} value={g}>
                    {g === "all" ? "전체" : g === "—" ? "성과 없음" : g}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <RequestState state={list} />
          {list.data?.items.map((n) => (
            <button
              className="map-list-item"
              key={n.id}
              onClick={() => select(n)}
            >
              <i style={{ background: starColor(n.planetCount, n.status) }} />
              <div>
                <strong>{n.name}</strong>
                <small>
                  {STATUSES[n.status]} · 행성 {n.planetCount}개 · {n.grade} ·
                  성과 {n.achievementCount}건
                </small>
              </div>
            </button>
          ))}
          {list.data && !list.data.total && (
            <Empty title="조건에 맞는 별이 없습니다" />
          )}
          {list.data && <Pager data={list.data} onPage={setPage} />}
        </aside>
      )}
      {selected && (
        <aside className="star-detail">
          <div className="modal-head">
            <p className="eyebrow">STAR INFORMATION</p>
            <button aria-label="별 선택 해제" onClick={() => setParams({})}>
              <X size={16} />
            </button>
          </div>
          <RequestState state={detail} />
          {detail.data && (
            <>
              <h2>
                {detail.data.id === "259377017"
                  ? "TOI-270"
                  : detail.data.id === "307210830"
                    ? "L 98-59"
                    : detail.data.name}
              </h2>
              {["259377017", "307210830"].includes(detail.data.id) && (
                <p className="galaxy-alias">{detail.data.name}</p>
              )}
              <Status star={detail.data} />
              <dl className="facts">
                <div>
                  <dt>관측 회차</dt>
                  <dd>{detail.data.sectors.join(" · ")}</dd>
                </div>
                <div>
                  <dt>밝기 등급</dt>
                  <dd>{detail.data.magnitude.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>발견 경로</dt>
                  <dd>
                    {
                      {
                        tutorial: "튜토리얼",
                        achievement: "성과 인정",
                        challenge: "챌린지",
                      }[detail.data.source]
                    }
                  </dd>
                </div>
                {detail.data.parentId && (
                  <div>
                    <dt>이 별을 열어 준 별</dt>
                    <dd>TIC {detail.data.parentId}</dd>
                  </div>
                )}
                <div>
                  <dt>찾은 신호 / 표시 행성</dt>
                  <dd>
                    {detail.data.matchedCount}개 / {detail.data.planetCount}개
                  </dd>
                </div>
              </dl>
              <Grade star={detail.data} />
              <Link
                className="button primary full"
                to={"/analysis/" + selected}
                onClick={() => {
                  if (guide !== null && selected === guideStarId)
                    advanceGuide(selected, "star_selected");
                }}
              >
                {detail.data.status === "complete"
                  ? "다시 보기"
                  : detail.data.status === "in_progress"
                    ? "분석 계속"
                    : "분석 시작"}{" "}
                <ArrowUpRight size={16} />
              </Link>
              <div className="actions">
                {detail.data.historyCount > 0 && (
                  <Link className="button" to={"/results/" + selected}>
                    결과
                  </Link>
                )}
                <Link className="button" to={"/community/stars/" + selected}>
                  스레드
                </Link>
              </div>
              {detail.data.knownSignals.length > 0 && (
                <details>
                  <summary>
                    찾은 신호 {detail.data.knownSignals.length}개
                  </summary>
                  {detail.data.knownSignals.map((s) => (
                    <p className="known-signal" key={s.id}>
                      {TYPES[s.type]}
                      <small>
                        반복 주기 {s.period}일 · 어두워진 정도 {s.depth}%
                      </small>
                    </p>
                  ))}
                </details>
              )}
            </>
          )}
        </aside>
      )}
      <aside className="map-legend" aria-label="별 색과 표식 범례">
        <strong>선택한 별의 색은 표시하는 행성 수입니다</strong>
        <div>
          {[0, 1, 2, 3, 4].map((n) => (
            <span key={n}>
              <i style={{ background: starColor(n, "unexplored") }} />
              {n === 4 ? "4개 이상" : n + "개"}
            </span>
          ))}
          <span>
            <i style={{ background: "#f1cfa3" }} />
            행성 표시 없이 완료
          </span>
        </div>
        <small>
          <b className="blue">①</b> 튜토리얼 · <b className="red">!</b> 챌린지 ·
          등급과 성과 수는 별 색과 다릅니다. 은하 전체의 색은 시각 연출입니다.
        </small>
      </aside>
      {guide === 0 && (
        <aside className="coach">
          <small>처음 만나는 밤하늘 · 1/5</small>
          <h3>첫 번째 별을 선택해 보세요</h3>
          <p>파란 번호 1이 첫 튜토리얼입니다.</p>
          <button
            onClick={() =>
              a.run(async () =>
                select(
                  await api<StarDetail>(
                    "/stars/" + encodeURIComponent(guideStarId!),
                  ),
                ),
              )
            }
          >
            별 선택하기
          </button>
          <button className="text-button" onClick={() => setGuide(null)}>
            안내 닫기
          </button>
        </aside>
      )}
      {guide === 1 && selected && (
        <aside className="coach">
          <small>첫 탐사 안내 · 2/5</small>
          <h3>별의 빛을 살펴볼까요?</h3>
          <p>분석 화면에서 반복되는 봉우리를 찾아보세요.</p>
          <Link className="button primary" to={"/analysis/" + selected}>
            분석으로 이동
          </Link>
          <button className="text-button" onClick={() => setGuide(null)}>
            안내 닫기
          </button>
        </aside>
      )}
      {(manifest.loading || manifest.error) && (
        <div className="map-state">
          <RequestState state={manifest} />
        </div>
      )}
      {guideAction.error && (
        <aside className="map-error" role="alert">
          <p>안내 확인 상태를 저장하지 못했습니다. {guideAction.error}</p>
          <button
            disabled={guideAction.pending}
            onClick={() => void acknowledgeGuide()}
          >
            안내 확인 저장 다시 시도
          </button>
        </aside>
      )}
      {params.get("entry") === "locked" && (
        <aside className="map-error" role="alert">
          아직 못 찾은 별입니다. 나의 밤하늘에서 열린 별을 선택해 주세요.
          <button onClick={() => setParams({}, { replace: true })}>확인</button>
        </aside>
      )}
      {mapError && (
        <div role="alert" className="map-error">
          {mapError}
          <button onClick={() => setRetry((v) => v + 1)}>다시 시도</button>
        </div>
      )}
    </main>
  );
}
