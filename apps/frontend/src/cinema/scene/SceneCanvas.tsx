// The one persistent canvas. Mount once at layout level inside SceneProvider.
// Registers a stable controller at once; the three.js engine loads in its own
// chunk and takes over when ready (see ./proxy.ts). WebGL failure sets
// `state.failed` and fires onError({recoverable:false}) so the shell can
// switch to the DiscoveredStars list.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useRegisterScene } from "./contract";
import { POWER_SLOW_MESSAGE, startingPower } from "./power";
import { createSceneProxy, type SceneEngineLike } from "./proxy";

export type SceneCanvasProps = {
  className?: string;
  /** Merged over the default full-window, behind-everything placement. */
  style?: CSSProperties;
};

const placement: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 0,
  overflow: "hidden",
  background: "#000",
};

export function SceneCanvas({
  className = "scene-canvas",
  style,
}: SceneCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const [proxy] = useState(createSceneProxy);
  useRegisterScene(proxy.controller);
  const state = useSyncExternalStore(
    proxy.controller.subscribe,
    proxy.controller.getState,
    proxy.controller.getState,
  );

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let engine: SceneEngineLike | null = null;
    // Too slow earlier in this tab (or pinned with ?power=list): the list,
    // without loading three.js at all.
    if (startingPower(window.location.search).level === "list") {
      proxy.fail(POWER_SLOW_MESSAGE);
      return () => proxy.detach();
    }
    import("./engine").then(
      ({ createSceneEngine }) => {
        if (cancelled) return;
        try {
          engine = createSceneEngine(element);
          proxy.attach(engine);
        } catch (error) {
          console.error("[scene] WebGL unavailable", error);
          proxy.fail(
            "이 브라우저에서는 은하를 그릴 수 없어 목록으로 보여 드립니다.",
          );
        }
      },
      (error) => {
        if (cancelled) return;
        console.error("[scene] engine chunk failed", error);
        proxy.fail("은하 화면을 불러오지 못해 목록으로 보여 드립니다.");
      },
    );
    return () => {
      cancelled = true;
      proxy.detach();
      engine?.dispose();
      engine = null;
    };
  }, [proxy]);

  return (
    <div
      ref={host}
      className={className}
      style={{ ...placement, ...style }}
      aria-hidden="true"
      data-scene={state.failed ? "failed" : state.ready ? "ready" : "loading"}
      data-scene-mode={state.mode}
      data-scene-busy={state.busy ? "true" : "false"}
      data-scene-power={state.power ?? "full"}
    />
  );
}
