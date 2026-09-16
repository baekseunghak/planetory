import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../src/features/analysis/analysis-data.ts";

export const OBSERVATION_TARGETS = [
  { id: "toi270", label: "TOI-270", ticId: "259377017", sectors: [3, 4, 5] },
  { id: "l98-59", label: "L 98-59", ticId: "307210830", sectors: [2, 5, 8] },
  { id: "cm-dra", label: "CM Draconis", ticId: "199574208", sectors: [16] },
] as const;
export const CONVERSION_VERSION = "prototype-observation-10m-mean-v1";
export type ObservationInput = {
  id: string;
  tic_id: string;
  bundle_id: string;
  point_count: number;
  sectors: number[];
  time_btjd: number[];
  normalized_flux: number[];
  point_source_index: number[];
  fold_reference_time_btjd: number;
  observation_windows: {
    source_index: number;
    sector: number;
    start_btjd: number;
    end_btjd: number;
  }[];
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const localId = (value: string) =>
  BigInt(
    `0x${createHash("sha256").update(value).digest("hex").slice(0, 15)}`,
  ).toString();

// Development conversion of an existing export, not the Gold preprocessing pipeline.
export function convertObservation(
  input: ObservationInput,
  sourceSha256: string,
) {
  const target = OBSERVATION_TARGETS.find((item) => item.id === input.id);
  assert(
    target && input.tic_id === target.ticId,
    "Unexpected prototype target/TIC",
  );
  assert.deepEqual(input.sectors, [...target.sectors]);
  assert(
    input.point_count > 0 && Number.isFinite(input.fold_reference_time_btjd),
  );
  for (const values of [
    input.time_btjd,
    input.normalized_flux,
    input.point_source_index,
  ])
    assert.equal(
      values.length,
      input.point_count,
      "Source array length mismatch",
    );
  const bundleId = localId(`${sourceSha256}:${CONVERSION_VERSION}`);
  const binMinutes = 10,
    cadence = binMinutes / 1440;
  const groups = new Map(
    input.observation_windows.map((window) => [
      window.source_index,
      { window, times: [] as number[], flux: [] as number[] },
    ]),
  );
  assert.equal(groups.size, input.observation_windows.length);
  assert.deepEqual(
    input.observation_windows
      .map((window) => window.sector)
      .sort((a, b) => a - b),
    [...target.sectors],
  );
  for (let i = 0; i < input.point_count; i++) {
    const time = input.time_btjd[i],
      flux = input.normalized_flux[i],
      group = groups.get(input.point_source_index[i]);
    assert(
      group && Number.isFinite(time) && Number.isFinite(flux),
      "Invalid source point",
    );
    assert(
      i === 0 || time > input.time_btjd[i - 1],
      "Duplicate or unsorted time",
    );
    assert(
      time >= group.window.start_btjd && time <= group.window.end_btjd,
      "Point outside source window",
    );
    group.times.push(time);
    group.flux.push(flux);
  }
  const accounting: {
    sector: number;
    sourcePoints: number;
    counts: number[];
  }[] = [];
  const segments = [...groups.values()]
    .sort((a, b) => a.window.sector - b.window.sector)
    .map(({ window, times, flux }) => {
      assert(
        Number.isFinite(window.start_btjd) &&
          Number.isFinite(window.end_btjd) &&
          window.end_btjd >= window.start_btjd &&
          times.length > 0,
      );
      const nPoints =
        Math.floor((window.end_btjd - window.start_btjd) / cadence) + 1;
      assert(
        nPoints <= 20000,
        "Prototype segment exceeds the 10-minute fixture limit",
      );
      const sums = Array<number>(nPoints).fill(0),
        counts = Array<number>(nPoints).fill(0);
      times.forEach((time, i) => {
        const bin = Math.floor((time - window.start_btjd) / cadence);
        assert(bin >= 0 && bin < nPoints);
        sums[bin] += flux[i];
        counts[bin]++;
      });
      const binned = sums.map((sum, i) => (counts[i] ? sum / counts[i] : null));
      const gaps: [number, number][] = [];
      binned.forEach((value, i) => {
        if (value !== null) return;
        const last = gaps.at(-1);
        if (last && last[1] === i - 1) last[1] = i;
        else gaps.push([i, i]);
      });
      const center = median(flux);
      accounting.push({
        sector: window.sector,
        sourcePoints: times.length,
        counts,
      });
      return {
        segmentId: localId(`${bundleId}:${window.sector}`),
        sector: window.sector,
        binningRevision: 1,
        startBtjd: window.start_btjd,
        binMinutes,
        nPoints,
        flux: binned,
        fluxScatter:
          1.4826 * median(flux.map((value) => Math.abs(value - center))),
        gaps,
      };
    });
  const curveContext = {
    bundleId,
    curveStep: 0,
    removedCandidateIds: [],
    residualModelVersion: CONVERSION_VERSION,
    periodogramConfigVersion: "prototype-observation-no-periodogram",
  };
  const context = {
    ticId: target.ticId,
    star: { sectors: [...target.sectors], sectorCount: target.sectors.length },
    // Contract placeholder only: hidden as "미연결" in observation mode, not a catalog claim.
    hasConfirmedCandidate: false,
    bundle: {
      bundleId,
      bundleVersion: 1,
      foldReferenceTimeBtjd: input.fold_reference_time_btjd,
      residualModelVersion: curveContext.residualModelVersion,
      periodogramConfigVersion: curveContext.periodogramConfigVersion,
    },
    currentCurveContext: curveContext,
  };
  const curve = {
    ticId: target.ticId,
    bundleId,
    foldReferenceTimeBtjd: input.fold_reference_time_btjd,
    curveContext,
    residual: { status: "COMPLETED", jobId: null },
    fluxUnit: "normalized",
    segments,
  };
  decodeCurve(curve, decodeAnalysisContext(context, target.ticId));
  assert.equal(
    accounting.reduce(
      (sum, group) => sum + group.counts.reduce((a, b) => a + b, 0),
      0,
    ),
    input.point_count,
  );
  return {
    context,
    curve,
    provenance: {
      conversion: CONVERSION_VERSION,
      label: target.label,
      sourceSha256,
      sourceBundleId: input.bundle_id,
      sourcePoints: input.point_count,
      accounting,
    },
  };
}
