import { useEffect, useRef } from "react";
import type { Star } from "../features/sky-data/contracts";
import {
  cameraMatrix,
  INITIAL_CAMERA,
  screenPoint,
  starStyle,
} from "../features/sky-renderer/model";

const noStars: readonly Star[] = [];
/** One-frame illustration. Synthetic points are allowed only on the login artwork. */
export function GalaxyArtwork({
  stars = noStars,
  decorative = false,
}: {
  stars?: readonly Star[];
  decorative?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!,
      context = canvas.getContext("2d");
    if (!context) return;
    const matrix = cameraMatrix(INITIAL_CAMERA, 1440, 900);
    const points = decorative
      ? Array.from({ length: 8000 }, (_, i) => {
          const u = ((Math.imul(i + 7, 16807) >>> 0) % 10007) / 10007;
          const core = i % 11 < 2;
          const r = core ? Math.sqrt(u) * 170 : 85 + Math.pow(u, 0.72) * 1140;
          const a =
            core || i % 7 === 0
              ? i * 2.39996
              : ((i % 4) * Math.PI) / 2 +
                Math.pow(r / 1200, 0.7) * 5.6 +
                Math.sin(i * 19.7) * 0.19;
          return {
            x: Math.cos(a) * r,
            y: Math.sin(a) * r,
            depthZ: (Math.sin(i * 3.1) * (core ? 25 : 12)) / 256,
            size: 3.2 + (i % 7) / 2,
            warmth: Math.max(0, 1 - r / 420),
          };
        })
      : stars.map((s) => ({
          ...s,
          size: starStyle(s).baseSize,
          warmth: Math.max(0, 1 - Math.hypot(s.x, s.y) / 420),
        }));
    const projected = points.map((p) => ({
      ...screenPoint(matrix, 1440, 900, p.x, p.y, p.depthZ),
      size: p.size,
      warmth: p.warmth,
    }));
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity;
    for (const p of projected) {
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
    const draw = () => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, w, h);
      const scale = Math.min(
        (w - 28) / Math.max(20, right - left),
        (h - 28) / Math.max(20, bottom - top),
      );
      context.globalAlpha = Math.min(
        0.85,
        Math.max(0.13, Math.sqrt(1600 / Math.max(1, projected.length))),
      );
      for (const p of projected) {
        context.fillStyle = p.warmth > 0.4 ? "#f5bf89" : "#a1c4f0";
        context.beginPath();
        context.arc(
          w / 2 + (p.x - (left + right) / 2) * scale,
          h / 2 + (p.y - (top + bottom) / 2) * scale,
          Math.max(0.45, Math.min(1.25, p.size * 0.16)),
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      context.globalAlpha = 1;
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [stars, decorative]);
  return <canvas ref={ref} className="galaxy-artwork" aria-hidden="true" />;
}
