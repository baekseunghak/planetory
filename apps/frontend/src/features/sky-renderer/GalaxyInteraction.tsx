import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { api } from "../../api";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import type { Matrix } from "../sky-data/geometry";
import {
  HitGrid,
  markerLabel,
  panCamera,
  readTutorialMarkers,
  readChallengeTicId,
  rotateCamera,
  starTargets,
  zoomCamera,
  type HitTarget,
  type TutorialMarkers,
} from "./interaction";
import type { GalaxyCamera, OwnedSystem } from "./model";

export type InteractionControl = { frame(planets: HitTarget[]): void };
type Props = SkySceneProps & {
  canvas: RefObject<HTMLCanvasElement | null>;
  camera: GalaxyCamera;
  matrix: Matrix;
  width: number;
  height: number;
  stars: SkySceneProps["data"]["stars"];
  system: OwnedSystem | null;
  enabled: boolean;
  changeCamera(camera: GalaxyCamera): void;
  fitAll(): void;
  onPlanetSelect?: (candidateId: string | null) => void;
};
// Stars update on data/camera changes; the animation callback visits only the selected system.
export const GalaxyInteraction = forwardRef<InteractionControl, Props>(
  function GalaxyInteraction(props, ref) {
    const {
      canvas,
      camera,
      matrix,
      width,
      height,
      stars,
      data,
      store,
      system,
      enabled,
    } = props;
    const [mode, setMode] = useState<"rotate" | "pan">("rotate");
    const [questAttempt, setQuestAttempt] = useState(0);
    const [quest, setQuest] = useState<{
      version: string;
      value: TutorialMarkers | null;
      challengeTicId: string | null;
      error: boolean;
    } | null>(null);
    const retiredBadges = useRef(new Set<string>());
    const [selectedPlanet, setSelectedPlanet] = useState<string | null>(null);
    const selectedPlanetRef = useRef(selectedPlanet);
    selectedPlanetRef.current = selectedPlanet;
    const [selectionText, setSelectionText] = useState("");
    const layer = useRef<HTMLDivElement>(null),
      tooltip = useRef<HTMLDivElement>(null),
      activeOption = useRef<HTMLSpanElement>(null);
    const pool = useRef<HTMLButtonElement[]>([]);
    const active = useRef<HitTarget | null>(null),
      focusedId = useRef<string | null>(null);
    const pointer = useRef<{ x: number; y: number } | null>(null);
    const planets = useRef(new HitGrid([]));
    const tooltipId = useId(),
      optionId = useId(),
      helpId = useId();
    const index = useMemo(
      () =>
        new HitGrid(
          starTargets(
            stars,
            matrix,
            width,
            height,
            camera.zoom,
            data.selectedTicId,
            system,
            Math.min(devicePixelRatio || 1, 2),
          ),
        ),
      [stars, matrix, width, height, camera.zoom, data.selectedTicId, system],
    );
    const current = useRef({ ...props, mode, index });
    current.current = { ...props, mode, index };
    const tutorials =
      quest?.version === data.meta?.version && !data.needsRefresh
        ? (quest?.value ?? null)
        : null;
    const challengeTicId =
      quest?.version === data.meta?.version && !data.needsRefresh
        ? (quest?.challengeTicId ?? null)
        : null;
    useEffect(() => {
      const controller = new AbortController();
      const version = data.meta!.version;
      setQuest(null);
      if (data.needsRefresh) return;
      void api<unknown>("/v1/me/quests", { signal: controller.signal })
        .then((value) => {
          if (controller.signal.aborted) return;
          const state = readTutorialMarkers(value);
          for (const [id, item] of state) {
            if (item.completed) retiredBadges.current.add(id);
            if (retiredBadges.current.has(id)) item.visible = false;
          }
          setQuest({
            version,
            value: state,
            challengeTicId: readChallengeTicId(value),
            error: false,
          });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setQuest({
              version,
              value: null,
              challengeTicId: null,
              error: true,
            });
        });
      return () => controller.abort();
    }, [store, data.meta?.version, data.needsRefresh, questAttempt]);
    useEffect(() => {
      setSelectedPlanet(null);
      props.onPlanetSelect?.(null);
    }, [data.selectedTicId, data.meta?.version]);

    function show(target: HitTarget | null) {
      active.current = target;
      const tip = tooltip.current,
        node = canvas.current;
      if (!tip || !node) return;
      tip.hidden = !target;
      if (!target) {
        node.removeAttribute("aria-activedescendant");
        return;
      }
      if (tip.textContent !== target.label) tip.textContent = target.label;
      tip.dataset.targetId = target.id;
      tip.style.left = `${Math.max(8, Math.min(current.current.width - 300, target.x + 16))}px`;
      tip.style.top = `${Math.max(8, Math.min(current.current.height - 100, target.y + 18))}px`;
      if (activeOption.current) {
        activeOption.current.textContent = target.label;
        activeOption.current.setAttribute(
          "aria-selected",
          String(
            target.kind === "star"
              ? target.id === current.current.data.selectedTicId
              : target.id === selectedPlanetRef.current,
          ),
        );
      }
      node.setAttribute("aria-activedescendant", optionId);
    }
    function commitCamera(next: GalaxyCamera) {
      current.current.camera = next;
      current.current.changeCamera(next);
    }
    function activate(target: HitTarget | null) {
      const p = current.current;
      if (!p.enabled) return;
      if (target?.kind === "planet") {
        setSelectedPlanet(target.id);
        p.onPlanetSelect?.(target.id);
        setSelectionText(target.label);
      } else {
        setSelectedPlanet(null);
        p.onPlanetSelect?.(null);
        p.store.select(target?.id ?? null);
        setSelectionText(target?.label ?? "선택을 해제했습니다.");
      }
      show(target);
    }
    useImperativeHandle(ref, () => ({
      frame(targets) {
        const p = current.current;
        planets.current = new HitGrid(
          p.enabled && p.system
            ? targets.filter((t) => t.systemTicId === p.system!.ticId)
            : [],
        );
        const focus = focusedId.current;
        if (focus)
          show(
            planets.current.byId.get(focus) ??
              current.current.index.byId.get(focus) ??
              null,
          );
        else if (pointer.current && !drag.current) {
          const { x, y } = pointer.current;
          const planet = planets.current.hit(x, y);
          // A moving planet may enter/leave a stationary pointer. No all-star projection here.
          if (planet || active.current?.kind === "planet")
            show(planet ?? current.current.index.hit(x, y));
        }
      },
    }));
    const drag = useRef<{
      id: number;
      x: number;
      y: number;
      startX: number;
      startY: number;
      moved: boolean;
      pan: boolean;
    } | null>(null);
    useEffect(() => {
      const node = canvas.current;
      if (!node) return;
      node.setAttribute("aria-describedby", helpId);
      node.setAttribute("aria-owns", optionId);
      const point = (event: MouseEvent) => {
        const r = node.getBoundingClientRect();
        return { x: event.clientX - r.left, y: event.clientY - r.top };
      };
      const hit = (x: number, y: number) =>
        planets.current.hit(x, y) ?? current.current.index.hit(x, y);
      const down = (event: PointerEvent) => {
        if (
          !current.current.enabled ||
          (event.button !== 0 && event.button !== 2) ||
          !event.isPrimary
        )
          return;
        const p = point(event);
        node.focus({ preventScroll: true });
        node.setPointerCapture(event.pointerId);
        focusedId.current = null;
        drag.current = {
          id: event.pointerId,
          ...p,
          startX: p.x,
          startY: p.y,
          moved: false,
          pan:
            event.shiftKey ||
            event.button === 2 ||
            current.current.mode === "pan",
        };
      };
      const move = (event: PointerEvent) => {
        const p = current.current,
          pos = point(event);
        pointer.current = pos;
        if (!p.enabled) return;
        const d = drag.current;
        if (d && d.id === event.pointerId) {
          if (!d.moved && Math.hypot(pos.x - d.startX, pos.y - d.startY) < 5)
            return;
          d.moved = true;
          commitCamera(
            d.pan
              ? panCamera(p.camera, pos.x - d.x, pos.y - d.y, p.width, p.height)
              : rotateCamera(p.camera, pos.x - d.x, pos.y - d.y),
          );
          d.x = pos.x;
          d.y = pos.y;
          show(null);
        } else {
          focusedId.current = null;
          show(hit(pos.x, pos.y));
        }
      };
      const up = (event: PointerEvent) => {
        const d = drag.current;
        drag.current = null;
        if (node.hasPointerCapture(event.pointerId))
          node.releasePointerCapture(event.pointerId);
        if (d && !d.moved && event.button === 0 && current.current.enabled) {
          const p = point(event);
          activate(hit(p.x, p.y));
        }
      };
      const cancel = () => {
        drag.current = null;
        pointer.current = null;
        show(null);
      };
      const leave = (event: PointerEvent) => {
        pointer.current = null;
        if (!drag.current) {
          const next =
            event.relatedTarget instanceof HTMLElement
              ? event.relatedTarget.closest<HTMLElement>(".galaxy-marker")
              : null;
          show(
            next
              ? (current.current.index.byId.get(next.dataset.ticId ?? "") ??
                  null)
              : null,
          );
        }
      };
      const wheel = (event: WheelEvent) => {
        if (
          event.target !== node &&
          !(
            event.target instanceof Element &&
            event.target.closest(".galaxy-marker")
          )
        )
          return;
        if (!current.current.enabled) return;
        event.preventDefault();
        const p = current.current,
          pos = point(event),
          unit =
            event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? p.height : 1;
        commitCamera(
          zoomCamera(
            p.camera,
            Math.exp(
              -Math.max(-500, Math.min(500, event.deltaY * unit)) * 0.0015,
            ),
            pos.x,
            pos.y,
            p.width,
            p.height,
          ),
        );
        focusedId.current = null;
        show(null);
      };
      const key = (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const p = current.current;
        if (!p.enabled) return;
        const k = event.key;
        if (
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "+",
            "=",
            "-",
            "Home",
            "[",
            "]",
            "Enter",
            " ",
            "Escape",
          ].includes(k)
        )
          return;
        event.preventDefault();
        if (k === "Escape") {
          focusedId.current = null;
          activate(null);
        } else if (k === "Home") p.fitAll();
        else if (k === "Enter" || k === " ") activate(active.current);
        else if (k === "[" || k === "]") {
          const all = [...p.index.targets, ...planets.current.targets];
          if (!all.length) return;
          const i = all.findIndex((t) => t.id === focusedId.current);
          const target =
            all[(i + (k === "]" ? 1 : -1) + all.length) % all.length];
          focusedId.current = target.id;
          pointer.current = null;
          show(target);
        } else {
          show(null);
          focusedId.current = null;
          if (["+", "=", "-"].includes(k))
            commitCamera(
              zoomCamera(
                p.camera,
                k === "-" ? 1 / 1.25 : 1.25,
                p.width / 2,
                p.height * 0.46,
                p.width,
                p.height,
              ),
            );
          else {
            const dx = k === "ArrowLeft" ? 35 : k === "ArrowRight" ? -35 : 0,
              dy = k === "ArrowUp" ? 35 : k === "ArrowDown" ? -35 : 0;
            commitCamera(
              event.shiftKey
                ? rotateCamera(p.camera, -dx, -dy)
                : panCamera(p.camera, dx, dy, p.width, p.height),
            );
          }
        }
      };
      const menu = (event: Event) => event.preventDefault();
      node.addEventListener("pointerdown", down);
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", cancel);
      node.addEventListener("lostpointercapture", cancel);
      node.addEventListener("pointerleave", leave);
      const surface = node.parentElement!;
      surface.addEventListener("wheel", wheel, { passive: false });
      node.addEventListener("keydown", key);
      node.addEventListener("contextmenu", menu);
      window.addEventListener("blur", cancel);
      return () => {
        node.removeAttribute("aria-describedby");
        node.removeAttribute("aria-owns");
        node.removeEventListener("lostpointercapture", cancel);
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", cancel);
        node.removeEventListener("pointerleave", leave);
        surface.removeEventListener("wheel", wheel);
        node.removeEventListener("keydown", key);
        node.removeEventListener("contextmenu", menu);
        window.removeEventListener("blur", cancel);
      };
    }, [canvas, optionId, helpId]);
    useEffect(() => {
      const host = layer.current;
      if (!host) return;
      const candidates = enabled
        ? index.targets.flatMap((t) => {
            const label = markerLabel(t.star!, tutorials, challengeTicId);
            return label ? [{ target: t, label }] : [];
          })
        : [];
      const available = new Map(candidates.map((c) => [c.target.id, c]));
      // Keep existing nodes for persistent IDs, then recycle retired slots before allocating.
      for (const button of pool.current) {
        if (!available.has(button.dataset.ticId!)) {
          if (document.activeElement === button)
            canvas.current?.focus({ preventScroll: true });
          button.hidden = true;
          button.tabIndex = -1;
          delete button.dataset.ticId;
        }
      }
      for (const { target, label } of candidates) {
        let button =
          pool.current.find((b) => b.dataset.ticId === target.id) ??
          pool.current.find((b) => b.hidden);
        if (!button) {
          button = document.createElement("button");
          button.className = "galaxy-marker";
          pool.current.push(button);
          host.append(button);
          const b = button;
          b.onclick = () =>
            activate(
              current.current.index.byId.get(b.dataset.ticId ?? "") ?? null,
            );
          b.onfocus = () => {
            focusedId.current = b.dataset.ticId ?? null;
            pointer.current = null;
            show(
              current.current.index.byId.get(focusedId.current ?? "") ?? null,
            );
          };
          b.onblur = () => {
            focusedId.current = null;
            show(null);
          };
          b.onmouseenter = () =>
            show(current.current.index.byId.get(b.dataset.ticId ?? "") ?? null);
          b.onmouseleave = (event) => {
            if (document.activeElement === b) return;
            if (event.relatedTarget === canvas.current) {
              const rect = canvas.current!.getBoundingClientRect();
              const x = event.clientX - rect.left,
                y = event.clientY - rect.top;
              pointer.current = { x, y };
              show(
                planets.current.hit(x, y) ?? current.current.index.hit(x, y),
              );
            } else show(null);
          };
        }
        button.hidden = false;
        button.tabIndex = 0;
        button.dataset.ticId = target.id;
        button.dataset.marker = label;
        button.textContent = label;
        button.setAttribute(
          "aria-label",
          `${label === "!" ? "챌린지" : "튜토리얼 " + label} · ${target.label}`,
        );
        button.style.left = `${target.x}px`;
        button.style.top = `${target.y}px`;
      }
      host.dataset.poolSize = String(pool.current.length);
      if (!enabled) {
        planets.current = new HitGrid([]);
        show(null);
      } else if (pointer.current && !drag.current && !focusedId.current) {
        const { x, y } = pointer.current;
        show(planets.current.hit(x, y) ?? index.hit(x, y));
      } else if (active.current?.kind === "star")
        show(index.byId.get(active.current?.id ?? "") ?? null);
    }, [index, tutorials, challengeTicId, enabled, canvas]);
    useEffect(() => {
      const host = layer.current;
      return () => {
        host?.replaceChildren();
        pool.current = [];
      };
    }, []);
    return (
      <>
        <div
          className="galaxy-input-toolbar"
          role="group"
          aria-label="지도 조작"
        >
          <button
            aria-pressed={mode === "rotate"}
            onClick={() => setMode("rotate")}
          >
            회전 모드
          </button>
          <button aria-pressed={mode === "pan"} onClick={() => setMode("pan")}>
            이동 모드
          </button>
          <button
            disabled={!enabled}
            aria-label="지도 확대"
            onClick={() =>
              props.changeCamera(
                zoomCamera(
                  camera,
                  1.4,
                  width / 2,
                  height * 0.46,
                  width,
                  height,
                ),
              )
            }
          >
            ＋
          </button>
          <button
            disabled={!enabled}
            aria-label="지도 축소"
            onClick={() =>
              props.changeCamera(
                zoomCamera(
                  camera,
                  1 / 1.4,
                  width / 2,
                  height * 0.46,
                  width,
                  height,
                ),
              )
            }
          >
            −
          </button>
          <button disabled={!enabled} onClick={props.fitAll}>
            은하 전체 보기
          </button>
          {data.selectedTicId && (
            <button onClick={() => activate(null)}>선택 해제</button>
          )}
        </div>
        <div ref={layer} className="galaxy-markers" data-testid="marker-pool" />
        <div
          ref={tooltip}
          id={tooltipId}
          role="tooltip"
          className="galaxy-tooltip"
          hidden
        />
        <span
          ref={activeOption}
          id={optionId}
          role="option"
          className="sr-only"
        />
        <span className="sr-only" id={helpId}>
          드래그 회전, Shift 또는 이동 모드 드래그 이동, 휠 확대와 축소. 방향키
          이동, Shift 방향키 회전, 더하기 빼기 배율, Home 전체 보기. 대괄호 키로
          화면의 별과 내 행성을 탐색하고 Enter로 선택, Escape로 해제합니다.
        </span>
        <p className="sr-only" role="status">
          {selectionText}
        </p>
        {data.selectedTicId && (
          <div className="galaxy-selection" data-testid="selection-summary">
            선택한 별 TIC {data.selectedTicId}
            {selectedPlanet && <span> · 행성 {selectedPlanet}</span>}
          </div>
        )}
        {quest?.error && (
          <div className="galaxy-marker-warning" role="status">
            튜토리얼 번호를 확인하지 못했습니다.{" "}
            <button onClick={() => setQuestAttempt((n) => n + 1)}>
              번호 다시 확인
            </button>
          </div>
        )}
      </>
    );
  },
);
