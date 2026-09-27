import { useEffect, useRef } from "react";

export type CurveSample = { t: number; flux: number };

/**
 * Live light curve drawn from samples pushed while a scene effect runs
 * (TransitRequest.onFlux). Baseline 1 at the top; the dip scales to the
 * deeper of the expected depth and what was actually reported.
 */
export function LightCurve({
  subscribe,
  getSamples,
  depth,
  label,
  className = "cinema-lightcurve",
}: {
  subscribe(listener: () => void): () => void;
  getSamples(): readonly CurveSample[];
  /** Expected fractional depth, used only to size the axis. */
  depth: number;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    const colour = (name: string, fallback: string) =>
      getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
    const draw = () => {
      frame = 0;
      const { width, height } = canvas.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const w = Math.round(width * ratio),
        h = Math.round(height * ratio);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const samples = getSamples();
      let low = 1 - Math.max(0, depth);
      for (const sample of samples) low = Math.min(low, sample.flux);
      const span = Math.max(1e-4, (1 - low) * 1.3);
      const top = 12,
        bottom = height - 10;
      const y = (flux: number) =>
        top + Math.max(0, Math.min(1.2, (1 - flux) / span)) * (bottom - top);
      context.strokeStyle = colour("--pc-line-strong", "rgba(150,180,225,.3)");
      context.lineWidth = 1;
      context.setLineDash([3, 5]);
      context.beginPath();
      context.moveTo(0, y(1));
      context.lineTo(width, y(1));
      context.stroke();
      context.setLineDash([]);
      if (!samples.length) return;
      context.beginPath();
      samples.forEach((sample, index) => {
        const x = sample.t * width,
          point = y(sample.flux);
        if (index) context.lineTo(x, point);
        else context.moveTo(x, point);
      });
      context.strokeStyle = colour("--pc-accent", "#ffd369");
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.stroke();
      const last = samples[samples.length - 1];
      context.fillStyle = colour("--pc-ink", "#e8eef8");
      context.beginPath();
      context.arc(last.t * width, y(last.flux), 3, 0, Math.PI * 2);
      context.fill();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    const off = subscribe(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      off();
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [subscribe, getSamples, depth]);
  return (
    <canvas ref={ref} className={className} role="img" aria-label={label} />
  );
}
