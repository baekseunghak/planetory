import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { StarTarget } from './types';
import './star-map.css';

interface StarMapProps {
  targets: StarTarget[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  dimmed?: boolean;
  showGrid?: boolean;
  motion?: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  resetKey?: number;
}

interface Point { x: number; y: number }

// A deterministic illustrative sky. Target positions are visual layout coordinates,
// not a projection of the catalogue RA/Dec values.
function randomSequence(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

const random = randomSequence(20814);
const stars = Array.from({ length: 1020 }, () => ({
  x: random() * 2 - 0.5,
  y: random() * 2 - 0.5,
  radius: random() < 0.027 ? 1.7 + random() * 0.7 : 0.35 + random() * 0.85,
  opacity: 0.18 + random() * 0.59,
  tone: random(),
  phase: random() * Math.PI * 2,
}));

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function StarMap({ targets, selectedId, onSelect, dimmed = false, showGrid = true, motion = true, zoom, onZoomChange, resetKey = 0 }: StarMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const atmosphereCache = useRef<{ canvas: HTMLCanvasElement; width: number; height: number; ratio: number } | null>(null);
  const [size, setSize] = useState({ width: 1440, height: 900 });
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(true);
  const drag = useRef<{ start: Point; pan: Point; moved: boolean; pointerId: number } | null>(null);
  const liveProps = useRef({ zoom, onZoomChange, dimmed });
  liveProps.current = { zoom, onZoomChange, dimmed };

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const setPreference = () => setReducedMotion(preference.matches);
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    setPreference();
    onVisibility();
    preference.addEventListener('change', setPreference);
    document.addEventListener('visibilitychange', onVisibility);
    const onWheel = (event: WheelEvent) => {
      if (liveProps.current.dimmed) return;
      event.preventDefault();
      const next = clamp(liveProps.current.zoom - event.deltaY * 0.0012, 1, 3);
      liveProps.current.onZoomChange(Math.round(next * 100) / 100);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      preference.removeEventListener('change', setPreference);
      document.removeEventListener('visibilitychange', onVisibility);
      node.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [resetKey]);

  useEffect(() => {
    if (!dimmed) return;
    if (drag.current && containerRef.current?.hasPointerCapture(drag.current.pointerId)) {
      containerRef.current.releasePointerCapture(drag.current.pointerId);
    }
    drag.current = null;
    setDragging(false);
  }, [dimmed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const { width, height } = size;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Cache the diffuse layer so we only redraw small stars and guides each frame.
    const cached = atmosphereCache.current;
    const cacheMatches = cached?.width === width && cached.height === height && cached.ratio === ratio;
    const atmosphere = cacheMatches ? cached.canvas : document.createElement('canvas');
    if (!cacheMatches) {
      atmosphere.width = canvas.width;
      atmosphere.height = canvas.height;
      const sky = atmosphere.getContext('2d');
      if (!sky) return;
      sky.setTransform(ratio, 0, 0, ratio, 0, 0);
      const base = sky.createLinearGradient(0, 0, width, height);
      base.addColorStop(0, '#030b15');
      base.addColorStop(0.48, '#071320');
      base.addColorStop(1, '#020912');
      sky.fillStyle = base;
      sky.fillRect(0, 0, width, height);
      const clouds = [
        [0.4, 0.38, 0.34, '22,69,87', 0.20],
        [0.29, 0.58, 0.25, '30,54,104', 0.17],
        [0.57, 0.23, 0.29, '24,84,98', 0.11],
        [0.67, 0.65, 0.33, '21,36,75', 0.13],
      ] as const;
      for (const [x, y, r, rgb, opacity] of clouds) {
        sky.save();
        sky.translate(width * x, height * y);
        sky.rotate(-0.5);
        sky.scale(1, 0.48);
        const cloud = sky.createRadialGradient(0, 0, 0, 0, 0, width * r);
        cloud.addColorStop(0, `rgba(${rgb},${opacity})`);
        cloud.addColorStop(0.5, `rgba(${rgb},${opacity * 0.46})`);
        cloud.addColorStop(1, `rgba(${rgb},0)`);
        sky.fillStyle = cloud;
        sky.fillRect(-width * r, -width * r, width * r * 2, width * r * 2);
        sky.restore();
      }
      const grain = randomSequence(48);
      for (let i = 0; i < Math.min(width * height / 75, 26000); i++) {
        sky.fillStyle = `rgba(166,202,214,${grain() * 0.028})`;
        sky.fillRect(grain() * width, grain() * height, 1, 1);
      }
      atmosphereCache.current = { canvas: atmosphere, width, height, ratio };
    }

    const selected = targets.find(target => target.id === selectedId);
    let frame = 0;
    let lastTime = -100;
    const animate = motion && !reducedMotion && visible && !dimmed;
    const draw = (time: number) => {
      if (animate) frame = window.requestAnimationFrame(draw);
      if (time - lastTime < 80) return;
      lastTime = time;
      context.clearRect(0, 0, width, height);
      context.drawImage(atmosphere, 0, 0, width, height);
      context.save();
      context.translate(width * 0.5 + pan.x, height * 0.46 + pan.y);
      context.scale(zoom, zoom);
      context.translate(-width * 0.5, -height * 0.46);

      if (showGrid) {
        context.save();
        context.strokeStyle = 'rgba(108,172,190,0.055)';
        context.lineWidth = 0.7 / zoom;
        const centerX = width * 0.43;
        const centerY = height * 0.45;
        for (let index = -3; index <= 3; index++) {
          const x = centerX + index * width * 0.155;
          context.beginPath();
          context.moveTo(x - index * width * 0.024, -height * 0.25);
          context.bezierCurveTo(x + index * width * 0.025, height * 0.22, x + index * width * 0.025, height * 0.72, x - index * width * 0.024, height * 1.25);
          context.stroke();
          const y = centerY + index * height * 0.18;
          context.beginPath();
          context.moveTo(-width * 0.2, y + height * 0.06);
          context.quadraticCurveTo(centerX, y - height * 0.045, width * 1.2, y + height * 0.06);
          context.stroke();
        }
        // The ground-plane arc is decorative, not a coordinate scale.
        context.strokeStyle = 'rgba(111,195,203,0.065)';
        context.beginPath();
        context.ellipse(centerX, height * 0.76, width * 0.56, height * 0.135, -0.17, Math.PI * 0.91, Math.PI * 1.98);
        context.stroke();
        context.restore();
      }

      for (const star of stars) {
        const x = star.x * width;
        const y = star.y * height;
        const flicker = animate ? 0.91 + Math.sin(time * 0.00038 + star.phase) * 0.09 : 1;
        context.fillStyle = star.tone > 0.9 ? `rgba(219,192,160,${star.opacity * flicker})` : `rgba(177,212,230,${star.opacity * flicker})`;
        context.beginPath();
        context.arc(x, y, star.radius / Math.sqrt(zoom), 0, Math.PI * 2);
        context.fill();
        if (star.radius > 1.7) {
          const halo = context.createRadialGradient(x, y, 0, x, y, 9);
          halo.addColorStop(0, `rgba(125,197,232,${star.opacity * 0.13})`);
          halo.addColorStop(1, 'rgba(125,197,232,0)');
          context.fillStyle = halo;
          context.fillRect(x - 9, y - 9, 18, 18);
        }
      }
      context.restore();

      if (selected && !dimmed) {
        const x = (selected.x - 0.5) * width * zoom + width * 0.5 + pan.x;
        const y = (selected.y - 0.46) * height * zoom + height * 0.46 + pan.y;
        const endX = width * 0.775;
        const endY = height * 0.37;
        if (x < endX - 120 && x > 0 && y > 0 && y < height) {
          const line = context.createLinearGradient(x, y, endX, endY);
          line.addColorStop(0, 'rgba(117,227,229,0.29)');
          line.addColorStop(1, 'rgba(117,227,229,0.04)');
          context.strokeStyle = line;
          context.lineWidth = 0.8;
          context.beginPath();
          context.moveTo(x + 35, y + 34);
          context.lineTo(x + 85, y + 84);
          context.lineTo(endX - 65, y + 84);
          context.lineTo(endX, endY);
          context.stroke();
          context.fillStyle = 'rgba(143,231,226,0.45)';
          context.fillRect(x + 83, y + 82, 3, 3);
        }
      }
    };
    draw(0);
    return () => window.cancelAnimationFrame(frame);
  }, [size, pan, zoom, showGrid, motion, reducedMotion, visible, dimmed, targets, selectedId]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dimmed || drag.current || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    drag.current = { start: { x: event.clientX, y: event.clientY }, pan, moved: false, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || dimmed) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (Math.hypot(dx, dy) > 5) {
      current.moved = true;
      setDragging(true);
    }
    if (current.moved) setPan({
      x: clamp(current.pan.x + dx, -size.width * 0.55 * zoom, size.width * 0.55 * zoom),
      y: clamp(current.pan.y + dy, -size.height * 0.55 * zoom, size.height * 0.55 * zoom),
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag.current;
    if (!current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDragging(false);
    if (!current.moved && !cancelled && !dimmed) onSelect(null);
  };

  return <div
    ref={containerRef}
    className={`star-map${dragging ? ' is-dragging' : ''}${dimmed ? ' is-dimmed' : ''}${!motion || reducedMotion ? ' no-motion' : ''}`}
    aria-label="관측 대상 별 지도"
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={event => finishDrag(event)}
    onPointerCancel={event => finishDrag(event, true)}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
  >
    <canvas ref={canvasRef} aria-hidden="true" />
    <div className="star-map-vignette" aria-hidden="true" />
    <div className="star-map-targets">
      {targets.map((target, index) => {
        const x = (target.x - 0.5) * size.width * zoom + size.width * 0.5 + pan.x;
        const y = (target.y - 0.46) * size.height * zoom + size.height * 0.46 + pan.y;
        const selected = target.id === selectedId;
        return <button
          key={target.id}
          type="button"
          className={`sky-target${selected ? ' is-selected' : ''}${x > size.width * 0.56 ? ' label-left' : ''}`}
          style={{ left: x, top: y }}
          aria-label={`${target.name}, TIC ${target.tic} 선택`}
          aria-pressed={selected}
          disabled={dimmed}
          tabIndex={dimmed ? -1 : 0}
          onClick={event => { event.stopPropagation(); onSelect(selected ? null : target.id); }}
        >
          <span className="sky-target-glow" aria-hidden="true" />
          <span className="sky-target-point" aria-hidden="true" />
          <span className="sky-target-orbit" aria-hidden="true" />
          <span className="sky-target-brackets" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="sky-target-label">
            <span className="sky-target-index">{selected ? 'TARGET LOCKED' : `OBJECT 0${index + 1}`}</span>
            <strong>{target.name}</strong>
            <span className="sky-target-tic">TIC {target.tic}</span>
          </span>
        </button>;
      })}
    </div>
  </div>;
}
