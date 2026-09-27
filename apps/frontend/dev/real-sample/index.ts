// Loader for the real TESS sample (see ./types.ts for the file layout).
// Dev only: read once by scripts/cinema-server.mjs at start. No folder, no
// sample: every fixture keeps its synthetic data.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REAL_SAMPLE_FORMAT,
  type RealSample,
  type RealSampleManifest,
  type RealSampleStar,
} from "./types.ts";

export * from "./types.ts";

/** `apps/frontend/.real-sample` (gitignored). */
export const REAL_SAMPLE_DIR = fileURLToPath(
  new URL("../../.real-sample/", import.meta.url),
);

const DECIMAL = /^[1-9]\d{0,18}$/;
/** The synthetic galaxy uses 900000001 + ordinal (up to 20000 stars plus discoveries). */
const SYNTHETIC_TICS = [900000001, 900100000] as const;
/** Fold worker limit (Gold: at most 20000 ten-minute bins per star). */
const MAX_BINS = 20000;
const KINDS = new Set(["confirmed", "candidate", "fp"]);

function fail(where: string, what: string): never {
  throw new Error(`real sample ${where}: ${what}`);
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number =>
  finite(value) && value > 0;

/**
 * Throws on the first problem with a path to it. Checks what the adapter and
 * the frontend decoders rely on; the data tool should check astrophysics.
 */
export function validateRealSample(sample: RealSample): RealSample {
  if (sample.format !== REAL_SAMPLE_FORMAT)
    fail("manifest", `format must be ${REAL_SAMPLE_FORMAT}`);
  if (!Array.isArray(sample.stars) || sample.stars.length === 0)
    fail("manifest", "no stars");
  const tics = new Set<string>();
  const candidates = new Set<string>();
  const seqs = new Set<number>();
  for (const star of sample.stars) {
    const at = `star ${star?.ticId}`;
    if (typeof star.ticId !== "string" || !DECIMAL.test(star.ticId))
      fail(at, "ticId must be a decimal string");
    if (tics.has(star.ticId)) fail(at, "duplicate ticId");
    const numeric = Number(star.ticId);
    if (numeric >= SYNTHETIC_TICS[0] && numeric < SYNTHETIC_TICS[1])
      fail(at, "ticId collides with the synthetic galaxy TICs 900000001..");
    tics.add(star.ticId);
    if (star.role !== "tutorial" && star.role !== "explore")
      fail(at, "role must be tutorial or explore");
    if (star.role === "tutorial") {
      const seq = star.tutorialSeq;
      if (!Number.isInteger(seq) || seq! < 1 || seq! > 5 || seqs.has(seq!))
        fail(at, "tutorialSeq must be a unique integer 1..5");
      seqs.add(seq!);
    }
    if (!finite(star.foldReferenceTimeBtjd)) fail(at, "foldReferenceTimeBtjd");
    if (
      !Array.isArray(star.sectors) ||
      !star.sectors.length ||
      star.sectors.some((s) => !Number.isInteger(s) || s < 1) ||
      new Set(star.sectors).size !== star.sectors.length
    )
      fail(at, "sectors must be unique positive integers");
    if (!Array.isArray(star.segments) || !star.segments.length)
      fail(at, "no segments");
    star.segments.forEach((segment, index) => {
      const where = `${at} segment ${index}`;
      const previous = star.segments[index - 1];
      if (
        previous &&
        (previous.sector > segment.sector ||
          previous.startBtjd >= segment.startBtjd)
      )
        fail(where, "segments must be in sector and time order");
      if (!star.sectors.includes(segment.sector))
        fail(where, "sector not in sectors");
      if (!finite(segment.startBtjd) || !positive(segment.binMinutes))
        fail(where, "startBtjd/binMinutes");
      if (!Array.isArray(segment.flux) || !segment.flux.length)
        fail(where, "empty flux");
      if (segment.flux.some((v) => v !== null && !finite(v)))
        fail(where, "flux values must be numbers or null");
      if (!finite(segment.fluxScatter) || segment.fluxScatter < 0)
        fail(where, "fluxScatter");
    });
    if (!Array.isArray(star.candidates)) fail(at, "candidates");
    for (const candidate of star.candidates) {
      const where = `${at} candidate ${candidate?.candidateId}`;
      if (!DECIMAL.test(String(candidate.candidateId)))
        fail(where, "candidateId must be a decimal string");
      if (candidates.has(candidate.candidateId))
        fail(where, "candidateId must be unique across the sample");
      candidates.add(candidate.candidateId);
      if (!KINDS.has(candidate.kind)) fail(where, "kind");
      if (
        !positive(candidate.periodDays) ||
        !finite(candidate.epochBtjd) ||
        !positive(candidate.durationHours) ||
        !positive(candidate.depthPpm)
      )
        fail(where, "period/epoch/duration/depth");
    }
    const original = star.periodograms?.find(
      (item) => item.removedCandidateIds.length === 0,
    );
    if (!original) fail(at, "periodograms must include the original curve");
    const bins = star.segments.reduce((sum, s) => sum + s.flux.length, 0);
    if (bins > MAX_BINS)
      fail(at, `${bins} bins; the fold worker takes ${MAX_BINS}`);
    for (const candidate of star.candidates)
      for (const link of candidate.peaks ?? [])
        if (
          !Number.isInteger(link.gridIndex) ||
          link.gridIndex < 0 ||
          link.gridIndex >= original.nPeriods ||
          !positive(link.multiplier)
        )
          fail(
            `${at} candidate ${candidate.candidateId}`,
            `peak link ${link.gridIndex} x${link.multiplier}`,
          );
    for (const periodogram of star.periodograms) {
      const where = `${at} periodogram [${periodogram.removedCandidateIds}]`;
      if (
        periodogram.periodMinDays !== original.periodMinDays ||
        periodogram.periodMaxDays !== original.periodMaxDays ||
        periodogram.nPeriods !== original.nPeriods
      )
        fail(where, "every periodogram of a star shares one grid");
      if (
        !positive(periodogram.periodMinDays) ||
        !(periodogram.periodMaxDays > periodogram.periodMinDays) ||
        !Number.isInteger(periodogram.nPeriods) ||
        periodogram.nPeriods < 2
      )
        fail(where, "grid");
      if (
        !Array.isArray(periodogram.power) ||
        periodogram.power.length !== periodogram.nPeriods ||
        periodogram.power.some((v) => !finite(v))
      )
        fail(where, "power length/values");
      if (
        periodogram.removedCandidateIds.some(
          (id) => !star.candidates.some((c) => c.candidateId === id),
        )
      )
        fail(where, "removes an unknown candidate");
      const ranks = new Set<number>(),
        cells = new Set<number>();
      for (const peak of periodogram.peaks) {
        if (
          !Number.isInteger(peak.gridIndex) ||
          peak.gridIndex < 0 ||
          peak.gridIndex >= periodogram.nPeriods ||
          !Number.isInteger(peak.rank) ||
          peak.rank < 1 ||
          ranks.has(peak.rank) ||
          cells.has(peak.gridIndex)
        )
          fail(where, `peak rank ${peak.rank} / gridIndex ${peak.gridIndex}`);
        if (
          peak.suggestedPhaseCenter !== null &&
          !(peak.suggestedPhaseCenter >= 0 && peak.suggestedPhaseCenter < 1)
        )
          fail(where, "suggestedPhaseCenter must be in [0, 1)");
        ranks.add(peak.rank);
        cells.add(peak.gridIndex);
      }
    }
  }
  return sample;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`real sample: cannot read ${path}: ${String(error)}`);
  }
}

/**
 * The sample in `dir`, or null when there is no `manifest.json` there.
 * Throws when files exist but do not match ./types.ts.
 */
export function loadRealSample(
  dir: string = REAL_SAMPLE_DIR,
): RealSample | null {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson<RealSampleManifest>(manifestPath);
  const stars = (manifest.stars ?? []).map((entry) =>
    readJson<RealSampleStar>(join(dir, "stars", `${entry.ticId}.json`)),
  );
  return validateRealSample({
    format: manifest.format,
    generatedAt: manifest.generatedAt,
    source: manifest.source,
    stars,
  });
}
