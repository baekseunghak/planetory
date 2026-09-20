import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const rows = [];
const diagnostics = [];
for (const folder of (
  await readdir("performance-results", { withFileTypes: true })
).filter((x) => x.isDirectory())) {
  const gpuPath = `performance-results/${folder.name}/gpu.json`;
  try {
    const data = await readFile(gpuPath);
    const diagnostic = JSON.parse(data);
    diagnostics.push({
      folder: folder.name,
      sha256: createHash("sha256").update(data).digest("hex"),
      date: diagnostic.date,
      browser: diagnostic.channel,
      browserVersion: diagnostic.browserVersion,
      failure: diagnostic.failure ?? null,
      scenarios: diagnostic.scenarios.map((s) => ({
        name: s.name,
        supported: s.supported,
        disjoint: s.disjoint,
        samples: s.ms.length,
        p95: s.p95,
        worst: s.worst,
        camera: s.after.camera,
        canvas: s.after.canvas,
        dpr: s.after.dpr,
        pending: s.after.pending,
        visibility: s.after.visibility,
        metrics: s.after.metrics,
      })),
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let text;
  try {
    text = await readFile(
      `performance-results/${folder.name}/summary.json`,
      "utf8",
    );
  } catch {
    continue;
  }
  const r = JSON.parse(text);
  const raw = await readFile(`performance-results/${folder.name}/raw.json`);
  const gpu = [...(r.gpu?.ms ?? [])].sort((a, b) => a - b);
  rows.push({
    folder: folder.name,
    date: r.date,
    revision: r.revision,
    dirty: r.dirty,
    bundleSha256: r.bundleSha256 ?? null,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    summarySha256: createHash("sha256").update(text).digest("hex"),
    dataset: r.dataset,
    browser: r.channel,
    browserVersion: r.browserVersion,
    width: r.width,
    requestedDpr: r.dpr,
    actualDpr: r.initial?.dpr,
    canvas: r.initial?.canvas,
    gpuRenderer: r.initial?.gpu,
    firstStarMs: r.initial?.firstStarFromNavigationMs,
    fullLoadMs: r.initial?.fullLoadFromNavigationMs,
    peakHeapMB: r.peakHeapMB,
    heapPass: r.peakHeapMB === null ? null : r.peakHeapMB <= 300,
    firstStarGoalPass:
      r.initial?.firstStarFromNavigationMs != null
        ? r.initial.firstStarFromNavigationMs <= 2000
        : null,
    errors: r.errors,
    failure: r.failure ?? null,
    gpuTiming: {
      supported: r.gpu?.supported ?? null,
      disjoint: r.gpu?.disjoint ?? null,
      samples: gpu.length,
      p95: gpu[Math.ceil(gpu.length * 0.95) - 1] ?? null,
      max: gpu.at(-1) ?? null,
    },
    scenarios: r.scenarios.map((s) => ({
      name: s.name,
      frames: s.frames,
      p95: s.p95,
      worst: s.worst,
      eligible: s.eligible,
      framePass: s.framePass,
      pendingFrames: s.pendingFrames,
      invalid: s.invalid,
      loaded: s.after.loaded,
      rendered: s.after.metrics?.stars,
      planets: s.after.metrics?.planets,
      drawCalls: s.after.metrics?.drawCalls,
      gpuBuffers: s.after.metrics?.gpuBuffers,
      backgroundCacheAvailable:
        s.after.metrics?.backgroundCacheAvailable ?? null,
      backgroundBytes: s.after.metrics?.backgroundBytes ?? null,
      backgroundBlits: s.after.metrics?.backgroundBlits ?? null,
      bodyDrawCallsDelta:
        s.after.metrics?.bodyDrawCallsTotal != null
          ? s.after.metrics.bodyDrawCallsTotal -
            s.before.metrics.bodyDrawCallsTotal
          : null,
      uploadBytesDelta:
        s.after.metrics?.uploadBytes - s.before.metrics?.uploadBytes,
      packedNodesDelta:
        s.after.metrics?.packedNodes - s.before.metrics?.packedNodes,
      dom: s.after.dom,
      zoom: s.after.camera?.zoom ?? null,
      cpu: {
        drawP95: s.cpu["draw-submit"].p95,
        packP95: s.cpu["pack-scene"].p95,
        packMax: s.cpu["pack-scene"].max,
        hitP95: s.cpu.hit.p95,
        hitMaxCandidates: s.cpu.hit.maxCandidates,
      },
      tileResourceCount: s.after.resources?.length,
      tileEncodedBytes: s.after.resources?.reduce((n, v) => n + v.bytes, 0),
    })),
  });
}
await writeFile(
  "docs/performance-215-evidence.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Windows local synthetic HTTP / production App. Not real C05 or Safari/deployment acceptance. baseline/optimized-v1/final-a are historical iterations; maximum zoom of final-a was not validated. Only final-b and later camera.zoom=0.001 prove maximum zoom out. Dirty runs are identified by compiled bundle hash when available.",
      runs: rows,
      diagnostics,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${rows.length} runs summarized`);
