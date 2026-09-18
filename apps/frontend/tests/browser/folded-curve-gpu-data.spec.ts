import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

for (const tic of ["259377017", "307210830", "199574208"]) {
  test(`GPU coordinates preserve local observation bins for TIC ${tic}`, async ({
    page,
  }, info) => {
    let bytes: Buffer;
    try {
      bytes = await readFile(`dev/observations/${tic}.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      test.skip(
        true,
        "Local observation exports required; run data:prepare first.",
      );
      return;
    }
    const manifest = JSON.parse(
      await readFile("dev/observations/manifest.json", "utf8"),
    );
    const entry = manifest.targets.find(
      (item: { ticId: string }) => item.ticId === tic,
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    const raw = JSON.parse(bytes.toString("utf8"));
    await page.goto("/analysis/259377024");
    const report = await page.evaluate(
      async ({ raw, tic }) => {
        const gpuPath = "/dev/fold-webgl-renderer.ts",
          mathPath = "/src/features/analysis/fold-data.ts",
          decodePath = "/src/features/analysis/analysis-data.ts",
          curvePath = "/src/features/analysis/folded-curve.ts";
        const { FoldWebglRenderer } = await import(gpuPath);
        const { buildFoldData, foldTimes } = await import(mathPath);
        const { decodeAnalysisContext, decodeCurve } = await import(decodePath);
        const { foldFluxDomain } = await import(curvePath);
        const context = decodeAnalysisContext(raw.context, tic);
        const curve = decodeCurve(raw.curve, context);
        const data = buildFoldData(context, curve);
        const domain = foldFluxDomain(data.points);
        const original = JSON.stringify(data.points);
        const flux = Float32Array.from(
          data.points,
          (p: { flux: number }) =>
            (p.flux - domain[0]) / (domain[1] - domain[0]),
        );
        let checked = 0,
          maxPhaseErrorPx = 0;
        for (const dpr of [1, 2]) {
          const canvas = document.createElement("canvas");
          document.body.append(canvas);
          const gpu = new FoldWebglRenderer(canvas, flux, dpr);
          try {
            gpu.resize(641, 280, dpr);
            // Deliberately test periods, not a claim about any star's true orbital period.
            for (const period of [3.125, 3.126]) {
              const phases: Float64Array = foldTimes(
                data.times,
                data.reference,
                period,
              );
              const preserved = Array.from(phases);
              for (const view of [
                { zoom: 1, center: 0.5 },
                { zoom: 32, center: 0 },
                { zoom: 32, center: 1 },
              ]) {
                gpu.draw(phases, view);
                const gl: WebGL2RenderingContext = gpu.gl;
                const pixels = new Uint8Array(canvas.width * canvas.height * 4);
                gl.readPixels(
                  0,
                  0,
                  canvas.width,
                  canvas.height,
                  gl.RGBA,
                  gl.UNSIGNED_BYTE,
                  pixels,
                );
                const low = view.center - 1 / view.zoom,
                  high = view.center + 1 / view.zoom;
                for (let i = 0; i < phases.length; i++) {
                  maxPhaseErrorPx = Math.max(
                    maxPhaseErrorPx,
                    (Math.abs(Math.fround(phases[i]) - phases[i]) *
                      641 *
                      view.zoom) /
                      2,
                  );
                  for (const repeat of [-1, 0, 1]) {
                    const phase = phases[i] + repeat;
                    if (phase < low || phase >= high) continue;
                    const x = Math.min(
                      canvas.width - 1,
                      Math.floor(((phase - low) / (high - low)) * canvas.width),
                    );
                    // Expected coordinates from CPU doubles, independently of uploaded float32 flux.
                    const normalized =
                      (data.points[i].flux - domain[0]) /
                      (domain[1] - domain[0]);
                    const y = Math.min(
                      canvas.height - 1,
                      Math.floor(normalized * canvas.height),
                    );
                    const index = (y * canvas.width + x) * 4;
                    if (
                      pixels[index + 1] - pixels[index] < 15 ||
                      pixels[index + 3] === 0
                    )
                      throw Error(`Missing point ${i} at ${x},${y}`);
                    checked++;
                  }
                }
                if (gl.getError() !== gl.NO_ERROR) throw Error("GPU error");
              }
              if (phases.some((p, i) => p !== preserved[i]))
                throw Error("Scientific phase mutated");
            }
          } finally {
            gpu.dispose();
            canvas.remove();
          }
        }
        if (JSON.stringify(data.points) !== original)
          throw Error("Scientific points mutated");
        return {
          tic,
          points: data.points.length,
          sectors: [
            ...new Set(data.points.map((p: { sector: number }) => p.sector)),
          ],
          checked,
          maxPhaseErrorPx,
        };
      },
      { raw, tic },
    );
    expect(report.points).toBe(entry.valid);
    expect(report.sectors).toEqual(entry.sectors);
    expect(report.checked).toBeGreaterThan(entry.valid * 8);
    expect(report.maxPhaseErrorPx).toBeLessThan(0.001);
    console.log("GPU_OBSERVATION", JSON.stringify(report));
    await info.attach(`coordinates-${tic}.json`, {
      body: JSON.stringify(report),
      contentType: "application/json",
    });
  });
}
