import { createScrollPositions } from "./scrollPositions";
import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

// Only numeric scroll positions, bounded in memory; no response bodies or IDs.
const positions = createScrollPositions();
export function usePageScroll(ready: boolean) {
  const { key } = useLocation();
  const navigation = useNavigationType();
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready) return;
    if (restored.current !== key) {
      window.scrollTo({
        top: navigation === "POP" ? (positions.get(key) ?? 0) : 0,
        behavior: "instant",
      });
      restored.current = key;
    }
    const record = () => {
      positions.set(key, window.scrollY);
    };
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, [ready, key, navigation]);
}
