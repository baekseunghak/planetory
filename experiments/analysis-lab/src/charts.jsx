import React, {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MAX_SELECTION_WIDTH,
  MIN_SELECTION_WIDTH,
  chartDomain,
  clamp,
  moveBoundary,
  normalizeView,
  panBy,
  phaseAt,
  pointerMode,
  repeatedRangeShifts,
  selectionFromDrag,
  stepZoom,
  visibleDomain,
  zoomAt,
} from "./graph-math.mjs";
export { estimateDip, findPeaks, phaseAt } from "./graph-math.mjs";

const ink = {
  grid: "rgba(135,207,220,.10)",
  label: "#87a3ad",
  cyan: "#94e5ec",
  amber: "#edbe85",
};

export default function ChartCanvas({
  kind,
  data,
  period,
  center = 0.5,
  range,
  selected,
  view,
  onViewChange,
  onRange,
  ariaLabel,
}) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const bufferRef = useRef(null);
  const dragRef = useRef(null);
  const liveRef = useRef(null);
  const instructionsId = useId();
  const [localView, setLocalView] = useState(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });
  const domain = useMemo(
    () =>
      data
        ? chartDomain(kind, data, center)
        : { min: 0, max: 1, bounded: true },
    [kind, data, center],
  );
  const currentView = normalizeView(view ?? localView, domain);
  const [xMin, xMax] = visibleDomain(currentView, domain);
  const geometry = useMemo(() => {
    const { width, height } = size;
    const left = Math.min(kind === "period" ? 36 : 47, width * 0.25);
    const right = Math.min(15, width * 0.1);
    const top = Math.min(kind === "period" ? 8 : 18, height * 0.2);
    const bottom = Math.min(kind === "period" ? 22 : 29, height * 0.3);
    return {
      left,
      top,
      w: Math.max(1, width - left - right),
      h: Math.max(1, height - top - bottom),
    };
  }, [size.width, size.height, kind]);

  // Expensive point preparation and vertical bounds do not depend on panning.
  const yBounds = useMemo(() => {
    if (!data) return [0, 1];
    if (kind === "period")
      return [0, Math.max(...data.periodogram.powers) * 1.08 || 1];
    const sorted = [...data.flux].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.005)];
    const high = sorted[Math.floor(sorted.length * 0.995)];
    const span = Math.max(high - low, 0.000001);
    return [low - span * 0.18, high + span * 0.08];
  }, [kind, data]);
  const folded = useMemo(() => {
    if (!data || kind !== "phase" || !(period > 0)) return null;
    const phases = data.time.map((time) =>
      phaseAt(time, data.referenceTime, period),
    );
    const bins = Array.from({ length: 140 }, () => []);
    phases.forEach((phase, i) =>
      bins[Math.min(139, Math.floor(phase * 140))].push(data.flux[i]),
    );
    const medians = bins
      .map((bin, i) => {
        if (bin.length < 3) return null;
        bin.sort((a, b) => a - b);
        return {
          phase: (i + 0.5) / bins.length,
          flux: bin[Math.floor(bin.length / 2)],
        };
      })
      .filter(Boolean);
    return { phases, medians };
  }, [data, period, kind]);

  const commitView = (next) => {
    const normalized = normalizeView(next, domain);
    setLocalView(normalized);
    onViewChange?.(normalized);
  };
  liveRef.current = {
    currentView,
    domain,
    geometry,
    commitView,
    cancelDrag,
    data,
  };

  function cancelDrag() {
    const drag = dragRef.current;
    const wrapper = wrapperRef.current;
    // Clear the snapshot before releasing capture: lostpointercapture can fire
    // immediately, and no subsequent pointermove may resume the old view.
    dragRef.current = null;
    if (!wrapper) return;
    delete wrapper.dataset.dragging;
    delete wrapper.dataset.dragMode;
    if (drag && wrapper.hasPointerCapture(drag.pointerId)) {
      wrapper.releasePointerCapture(drag.pointerId);
    }
  }

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    let media;
    function measure() {
      const next = {
        width: wrapper.clientWidth,
        height: wrapper.clientHeight,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      };
      setSize((previous) =>
        previous.width === next.width &&
        previous.height === next.height &&
        previous.dpr === next.dpr
          ? previous
          : next,
      );
    }
    function trackDpr() {
      media?.removeEventListener("change", trackDpr);
      media = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      media.addEventListener("change", trackDpr);
      measure();
    }
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    window.addEventListener("resize", measure);
    trackDpr();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      media?.removeEventListener("change", trackDpr);
    };
  }, []);

  const pointerFraction = (clientX) => {
    const wrapper = wrapperRef.current;
    const bounds = wrapper.getBoundingClientRect();
    // Match the perspective presentation using local horizontal coordinates.
    const localX =
      ((clientX - bounds.left) / Math.max(1, bounds.width)) *
      wrapper.clientWidth;
    return (
      (localX - liveRef.current.geometry.left) / liveRef.current.geometry.w
    );
  };
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    function wheel(event) {
      const latest = liveRef.current;
      if (!latest.data) return;
      event.preventDefault();
      latest.cancelDrag();
      const [min, max] = visibleDomain(latest.currentView, latest.domain);
      const fraction = clamp(pointerFraction(event.clientX), 0, 1);
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? wrapper.clientHeight
            : 1);
      const zoom =
        latest.currentView.zoom * Math.exp(-clamp(delta, -500, 500) * 0.002);
      latest.commitView(
        zoomAt(
          latest.currentView,
          latest.domain,
          zoom,
          min + fraction * (max - min),
        ),
      );
    }
    wrapper.addEventListener("wheel", wheel, { passive: false });
    return () => wrapper.removeEventListener("wheel", wheel);
  }, []);

  useLayoutEffect(() => {
    if (!data || !size.width || !size.height) return;
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const buffer =
        bufferRef.current ??
        (bufferRef.current = document.createElement("canvas"));
      const pixelWidth = Math.max(1, Math.round(size.width * size.dpr));
      const pixelHeight = Math.max(1, Math.round(size.height * size.dpr));
      if (buffer.width !== pixelWidth) buffer.width = pixelWidth;
      if (buffer.height !== pixelHeight) buffer.height = pixelHeight;
      const ctx = buffer.getContext("2d");
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      const { left, top, w, h } = geometry;
      const [yMin, yMax] = yBounds;
      const xMap = (x) => left + ((x - xMin) / (xMax - xMin)) * w;
      const yMap = (y) => top + h - ((y - yMin) / (yMax - yMin)) * h;
      ctx.font = "10px Consolas, monospace";
      ctx.lineWidth = 1;
      const yTickCount = h < 45 ? 2 : 4;
      for (let i = 0; i <= yTickCount; i++) {
        const y = top + (h / yTickCount) * i;
        ctx.strokeStyle = ink.grid;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + w, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillStyle = ink.label;
        const value = yMax - ((yMax - yMin) * i) / yTickCount;
        ctx.fillText(
          kind === "period" ? (value * 1000).toFixed(1) : value.toFixed(3),
          left - 8,
          y + 3,
        );
      }
      for (let i = 0; i <= 4; i++) {
        const x = left + (w * i) / 4;
        const value = xMin + ((xMax - xMin) * i) / 4;
        ctx.strokeStyle = ink.grid;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + h);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.fillStyle = ink.label;
        ctx.fillText(
          kind === "period"
            ? (10 ** value).toFixed(1)
            : kind === "phase"
              ? value.toFixed(2)
              : value.toFixed(1),
          x,
          size.height - 9,
        );
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, w, h);
      ctx.clip();
      if (kind === "phase" && range) {
        for (const shift of repeatedRangeShifts(range, xMin, xMax)) {
          const a = xMap(range[0] + shift),
            b = xMap(range[1] + shift);
          ctx.fillStyle = selected
            ? "rgba(237,190,133,.095)"
            : "rgba(148,229,236,.04)";
          ctx.fillRect(a, top, b - a, h);
          ctx.strokeStyle = selected ? ink.amber : "#729faa";
          ctx.setLineDash([3, 4]);
          for (const x of [a, b]) {
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + h);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }
      if (kind === "period") {
        ctx.beginPath();
        data.periodogram.periods.forEach((value, i) => {
          const x = xMap(Math.log10(value)),
            y = yMap(data.periodogram.powers[i]);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.strokeStyle = "#81c5d0";
        ctx.stroke();
        if (period > 0) {
          const x = xMap(Math.log10(period));
          ctx.strokeStyle = ink.amber;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + h);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (kind === "phase" && folded) {
        ctx.fillStyle = "rgba(132,210,225,.22)";
        // Every observation is drawn at every visible integer-phase copy.
        folded.phases.forEach((phase, i) => {
          for (
            let shift = Math.ceil(xMin - phase);
            shift <= Math.floor(xMax - phase);
            shift++
          ) {
            ctx.fillRect(xMap(phase + shift), yMap(data.flux[i]), 1.2, 1.2);
          }
        });
        ctx.fillStyle = "#c2f2f2";
        for (const point of folded.medians) {
          for (
            let shift = Math.ceil(xMin - point.phase);
            shift <= Math.floor(xMax - point.phase);
            shift++
          ) {
            ctx.beginPath();
            ctx.arc(
              xMap(point.phase + shift),
              yMap(point.flux),
              2.1,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
        }
      } else {
        ctx.fillStyle = "rgba(132,210,225,.35)";
        data.time.forEach((time, i) => {
          if (time >= xMin && time <= xMax)
            ctx.fillRect(xMap(time), yMap(data.flux[i]), 1.2, 1.2);
        });
      }
      ctx.restore();
      // Retain the previous visible frame until the complete next frame exists.
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      const visible = canvas.getContext("2d");
      visible.setTransform(1, 0, 0, 1, 0, 0);
      visible.clearRect(0, 0, pixelWidth, pixelHeight);
      visible.drawImage(buffer, 0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    data,
    kind,
    period,
    range,
    selected,
    folded,
    yBounds,
    size,
    geometry,
    xMin,
    xMax,
  ]);

  function beginPointer(event, boundary = null, shift = 0) {
    if (!data || event.button !== 0) return;
    cancelDrag();
    const mode = pointerMode(kind, event.shiftKey, boundary, Boolean(onRange));
    if (mode === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (boundary === null) canvasRef.current.focus({ preventScroll: true });
    else event.currentTarget.focus({ preventScroll: true });
    const fraction = pointerFraction(event.clientX);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      fraction,
      view: { ...currentView },
      min: xMin,
      max: xMax,
      anchor: xMin + clamp(fraction, 0, 1) * (xMax - xMin),
      mode,
      boundary,
      shift,
      range: range ? [...range] : null,
      moved: false,
    };
    wrapperRef.current.setPointerCapture(event.pointerId);
    wrapperRef.current.dataset.dragging = "true";
    wrapperRef.current.dataset.dragMode = dragRef.current.mode;
  }
  function movePointer(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4
    )
      drag.moved = true;
    if (!drag.moved) return;
    const fraction = pointerFraction(event.clientX);
    if (drag.mode === "pan")
      commitView(panBy(drag.view, domain, fraction - drag.fraction));
    else {
      const value = drag.min + clamp(fraction, 0, 1) * (drag.max - drag.min);
      if (drag.mode === "boundary")
        onRange?.(
          moveBoundary(
            drag.range,
            drag.boundary,
            drag.range[drag.boundary] + value - drag.anchor,
          ),
        );
      else if (Math.abs(value - drag.anchor) >= MIN_SELECTION_WIDTH)
        onRange?.(selectionFromDrag(drag.anchor, value));
    }
  }
  function endPointer(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cancelDrag();
  }
  function keyboard(event) {
    if (!data) return;
    const key = event.key;
    if (key === "+" || key === "=" || key === "-" || key === "_") {
      event.preventDefault();
      cancelDrag();
      commitView(
        zoomAt(
          currentView,
          domain,
          stepZoom(
            currentView.zoom,
            key === "+" || key === "=" ? 1 : -1,
            domain.maxZoom,
          ),
        ),
      );
    } else if (key === "0" || key === "Home") {
      event.preventDefault();
      cancelDrag();
      commitView(normalizeView(null, domain));
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      cancelDrag();
      commitView(panBy(currentView, domain, key === "ArrowLeft" ? 0.1 : -0.1));
    }
  }
  const shifts =
    kind === "phase" && range ? repeatedRangeShifts(range, xMin, xMax) : [];
  const representative = shifts.reduce((best, shift) => {
    const middle = (range[0] + range[1]) / 2;
    return best === null ||
      Math.abs(middle + shift - currentView.center) <
        Math.abs(middle + best - currentView.center)
      ? shift
      : best;
  }, null);

  return (
    <div
      ref={wrapperRef}
      className={`chart-surface chart-surface-${kind}${kind === "phase" ? " is-selecting" : ""}`}
      data-zoom={currentView.zoom}
      data-center={currentView.center}
      data-x-min={xMin}
      data-x-max={xMax}
      onPointerDown={beginPointer}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={endPointer}
      onDoubleClick={(event) => {
        if (!data || event.target.closest(".range-handle")) return;
        cancelDrag();
        event.preventDefault();
        commitView(normalizeView(null, domain));
      }}
    >
      <canvas
        ref={canvasRef}
        className={`plot plot-${kind}`}
        role="img"
        tabIndex={data ? 0 : -1}
        aria-label={ariaLabel}
        aria-describedby={instructionsId}
        aria-keyshortcuts="+ - 0 ArrowLeft ArrowRight"
        onKeyDown={keyboard}
      />
      <span id={instructionsId} className="chart-sr-only">
        {kind === "phase"
          ? "드래그로 가려짐 구간을 선택하고, Shift를 누른 채 드래그하면 가로 이동합니다. 휠로 포인터 위치를 기준으로 1배에서 20배까지 확대합니다. +와 - 키로 1, 2, 4, 8, 16, 20배를 선택합니다. 가려짐 경계 손잡이를 드래그하거나 좌우 방향키로 조절할 수 있습니다."
          : "드래그로 가로 이동하고, 휠로 포인터 위치를 기준으로 1배에서 8배까지 확대합니다. +와 - 키로 1, 2, 4, 8배를 선택합니다."}
        {" 0 키 또는 두 번 클릭으로 처음 보기로 돌아갑니다."}
      </span>
      {kind === "phase" &&
        onRange &&
        range &&
        representative !== null &&
        [0, 1].map((boundary) => {
          const value = range[boundary] + representative;
          if (value < xMin || value > xMax) return null;
          const min =
            boundary === 0
              ? range[1] - MAX_SELECTION_WIDTH
              : range[0] + MIN_SELECTION_WIDTH;
          const max =
            boundary === 0
              ? range[1] - MIN_SELECTION_WIDTH
              : range[0] + MAX_SELECTION_WIDTH;
          return (
            <button
              key={boundary}
              type="button"
              role="slider"
              className={`range-handle range-handle-${boundary === 0 ? "start" : "end"} ${selected ? "is-selected" : ""}`}
              aria-label={
                boundary === 0 ? "가려짐 시작 경계" : "가려짐 끝 경계"
              }
              aria-orientation="horizontal"
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={range[boundary]}
              aria-valuetext={`${range[boundary].toFixed(4)} 위상`}
              aria-describedby={instructionsId}
              style={{
                left:
                  geometry.left + ((value - xMin) / (xMax - xMin)) * geometry.w,
                top: geometry.top + geometry.h - 8,
              }}
              onPointerDown={(event) =>
                beginPointer(event, boundary, representative)
              }
              onKeyDown={(event) => {
                const direction =
                  event.key === "ArrowLeft" || event.key === "ArrowDown"
                    ? -1
                    : event.key === "ArrowRight" || event.key === "ArrowUp"
                      ? 1
                      : 0;
                if (!direction) return;
                event.preventDefault();
                event.stopPropagation();
                cancelDrag();
                onRange(
                  moveBoundary(
                    range,
                    boundary,
                    range[boundary] +
                      direction * (event.shiftKey ? 0.01 : 0.001),
                  ),
                );
              }}
            >
              <span aria-hidden="true">↔</span>
            </button>
          );
        })}
    </div>
  );
}
