/** No member/TIC/coordinates are included. Enable after the service endpoint exists. */
export class MapTelemetry {
  constructor(
    private enabled = import.meta.env?.VITE_MAP_TELEMETRY === "true",
    private send: (payload: object) => void = (payload) => {
      void fetch((import.meta.env.VITE_API_BASE || "/api") + "/telemetry/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    },
  ) {
    if (this.enabled)
      document.addEventListener("visibilitychange", this.resetWindow);
  }
  private resetWindow = () => {
    this.last = 0;
    this.started = 0;
    this.intervals = [];
  };
  dispose() {
    if (this.enabled)
      document.removeEventListener("visibilitychange", this.resetWindow);
    this.resetWindow();
  }
  private intervals: number[] = [];
  private last = 0;
  private started = 0;
  sample(time: number, visibleCount: number) {
    if (!this.enabled) return;
    if (document.hidden) {
      this.resetWindow();
      return;
    }
    if (!this.started) this.started = time;
    if (this.last) this.intervals.push(time - this.last);
    this.last = time;
    if (time - this.started < 60000) return;
    const frames = this.intervals.sort((a, b) => a - b);
    const payload = {
      schema: 1,
      p95: frames[Math.floor(frames.length * 0.95)] || 0,
      worst: frames.at(-1) || 0,
      visibleCount,
      widthBucket: innerWidth >= 1440 ? "1440+" : "1024-1439",
      samples: frames.length,
    };
    this.send(payload);
    this.intervals = [];
    this.started = time;
  }
}
