import { useEffect, useRef, type RefObject } from "react";
import type { SceneControl } from "./GalaxyScene";
import {
  INITIAL_SYSTEM,
  type PersonalPlanet,
  type SystemView,
} from "./personal-system";

export function PersonalSceneControls({
  planets,
  view,
  onView,
  onClose,
  renderer,
  label = "나의 항성계",
}: {
  planets: PersonalPlanet[];
  view: SystemView;
  onView: (view: SystemView) => void;
  onClose: () => void;
  renderer: RefObject<SceneControl | null>;
  label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ view, onView, onClose });
  live.current = { view, onView, onClose };
  const drag = useRef<{
    x: number;
    y: number;
    view: SystemView;
    moved: boolean;
  } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const distance = useRef<number | null>(null);
  const zoom = (factor: number, exit: boolean) => {
    const current = live.current,
      next = current.view.zoom * factor;
    if (exit && next < 0.58) {
      if (current.view.body !== "system")
        current.onView({ ...current.view, body: "system", zoom: 1 });
      else current.onClose();
      return;
    }
    current.onView({
      ...current.view,
      zoom: Math.max(0.6, Math.min(3.5, next)),
    });
  };
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const pixels =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientHeight
            : 1);
      zoom(Math.exp(-Math.max(-300, Math.min(300, pixels)) * 0.0018), true);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const render = renderer.current;
      host.current
        ?.querySelectorAll<HTMLButtonElement>("[data-body-id]")
        .forEach((button) => {
          const p = render?.systemBodies.find(
            (b) => b.id === button.dataset.bodyId,
          );
          const shown =
            !!p &&
            render!.focusAmount > 0.9 &&
            live.current.view.body === "system" &&
            p.x > 15 &&
            p.x < (host.current?.clientWidth ?? 0) - 15 &&
            p.y > 60 &&
            p.y < (host.current?.clientHeight ?? 0) - 80;
          button.hidden = !shown;
          if (p) {
            const diameter = Math.max(44, Math.min(160, p.radius * 2));
            button.style.left = p.x + "px";
            button.style.top = p.y + "px";
            button.style.width = diameter + "px";
            button.style.height = diameter + "px";
          }
        });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [renderer, planets]);
  return (
    <>
      <div
        ref={host}
        className="personal-scene-interaction"
        tabIndex={0}
        aria-label={
          label + ". 드래그 회전, 휠 확대 축소. 행성을 누르면 가까이 봅니다."
        }
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest("button")) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            view: { ...view },
            moved: false,
          };
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            distance.current = Math.hypot(a.x - b.x, a.y - b.y);
          }
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()],
              next = Math.hypot(a.x - b.x, a.y - b.y);
            if (distance.current) zoom(next / distance.current, false);
            distance.current = next;
            return;
          }
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          d.moved ||= Math.hypot(dx, dy) > 4;
          if (d.moved)
            onView({
              ...d.view,
              yaw: d.view.yaw + dx * 0.006,
              tilt: Math.max(-1.3, Math.min(1.3, d.view.tilt + dy * 0.004)),
            });
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          distance.current = null;
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          pointers.current.clear();
          distance.current = null;
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const keys = [
            "+",
            "=",
            "-",
            "Home",
            "Escape",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
          ];
          if (!keys.includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "+" || e.key === "=") zoom(1.2, false);
          else if (e.key === "-") zoom(0.8, true);
          else if (e.key === "Home") onView({ ...INITIAL_SYSTEM });
          else if (e.key === "Escape") onClose();
          else
            onView({
              ...view,
              yaw:
                view.yaw +
                (e.key === "ArrowLeft"
                  ? -0.12
                  : e.key === "ArrowRight"
                    ? 0.12
                    : 0),
              tilt: Math.max(
                -1.3,
                Math.min(
                  1.3,
                  view.tilt +
                    (e.key === "ArrowUp"
                      ? -0.1
                      : e.key === "ArrowDown"
                        ? 0.1
                        : 0),
                ),
              ),
            });
        }}
      >
        {planets.map((p) => (
          <button
            key={p.id}
            data-body-id={p.id}
            hidden
            className={
              "personal-body-target " + (p.candidate ? "candidate" : "")
            }
            aria-label={p.label + " 가까이 보기"}
            onClick={() => onView({ ...view, body: p.id, zoom: 1 })}
          >
            <span>{p.label}</span>
          </button>
        ))}
      </div>
      <div className="personal-camera-controls">
        <button aria-label="천체 확대" onClick={() => zoom(1.25, false)}>
          +
        </button>
        <button aria-label="천체 축소" onClick={() => zoom(0.8, true)}>
          −
        </button>
        <button
          className="system-reset"
          onClick={() => onView({ ...INITIAL_SYSTEM })}
        >
          항성계 전체
        </button>
      </div>
      <p className="personal-gesture">
        드래그 회전 · 휠 확대 · 계속 축소하면 별지도로
      </p>
    </>
  );
}
