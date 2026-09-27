// Real TESS sample for the cinema review server (`npm run dev:cinema`).
//
// Frozen shape shared by the data tool (tools/real-sample, writes JSON), the
// loader (./index.ts) and the fixture adapter (./adapter.ts). Add optional
// fields only. Never production data and never committed: the files live in
// the gitignored `apps/frontend/.real-sample/` folder.
//
// Layout on disk (REAL_SAMPLE_DIR):
//   manifest.json        RealSampleManifest
//   stars/<ticId>.json   RealSampleStar, one per manifest entry
//
// Units: time BTJD (BJD - 2457000), periods days, durations hours, depths ppm,
// flux normalized to a median of 1.

export const REAL_SAMPLE_FORMAT = "planetory-real-sample-v1";

/**
 * `confirmed`  known planet (NASA Exoplanet Archive / TOI CP, KP)
 * `candidate`  planet candidate (TOI PC, APC)            -> UNCONFIRMED
 * `fp`         false positive (TOI FP, FA, EB)           -> FP
 */
export type RealCandidateKind = "confirmed" | "candidate" | "fp";

export type RealCandidate = {
  /** Decimal string (like server bigint ids), unique across the sample. */
  candidateId: string;
  kind: RealCandidateKind;
  /** Refined on these segments (catalog periods drift over years). */
  periodDays: number;
  /** Mid-transit time, BTJD, inside (or next to) the observed segments. */
  epochBtjd: number;
  durationHours: number;
  depthPpm: number;
  /** Catalog id shown with the result, e.g. "TOI-270.01". */
  externalLabel?: string;
  /** Catalog of `externalLabel`. Default "TOI". */
  externalSource?: string;
  /** Catalog disposition text as published ("CP", "KP", "PC", "FP"). */
  externalDisposition?: string;
  /** Confirmed planets: published name, e.g. "TOI-270 b". */
  planetName?: string;
  radiusEarth?: number | null;
  discoveryYear?: number | null;
  /** AI triage, only when a real model score exists. Omit otherwise. */
  ai?: { score: number; verdict: string; modelVersion: string };
  /**
   * Peaks of `periodograms[0]` this signal produces. `multiplier` maps the
   * peak period to `periodDays` (1 fundamental, 2 when the peak sits at P/2,
   * 0.5 at 2P). Filled by the data tool; matching by peak uses it first.
   */
  peaks?: { gridIndex: number; multiplier: number }[];
  /** Kernel removal order (122 `removal_step`); residual periodograms follow it. */
  removalStep?: number;
  /** Kernel SNR of the accepted peak (diagnostic only, never shown as AI). */
  snr?: number | null;
  /** Where the external label comes from in the repo, and the matching rule used. */
  labelEvidence?: string;
};

/** One sector (or contiguous run) on a regular time grid. */
export type RealSegment = {
  sector: number;
  startBtjd: number;
  binMinutes: number;
  /** Bin i covers startBtjd + i * binMinutes. `null` = no data. */
  flux: (number | null)[];
  /** Typical per-bin scatter of `flux` (robust std). */
  fluxScatter: number;
};

export type RealPeak = {
  /** 1 = strongest. Unique per periodogram. */
  rank: number;
  /** Index into the log period grid; periodDays is derived from it. */
  gridIndex: number;
  suggestedDurationHours: number | null;
  /** Dip phase at this period relative to foldReferenceTimeBtjd, [0, 1). */
  suggestedPhaseCenter: number | null;
};

export type RealPeriodogram = {
  /** Candidates removed from the curve first (sorted). [] = original curve. */
  removedCandidateIds: string[];
  /** Log grid, same rule as the service: P_i = min * (max/min)^(i/(n-1)). */
  periodMinDays: number;
  periodMaxDays: number;
  nPeriods: number;
  /** Length nPeriods. Any positive scale (BLS power or SDE). */
  power: number[];
  peaks: RealPeak[];
};

/** Service rules the analysis fixtures need. Defaults in ./adapter.ts. */
export type RealAnalysisRules = {
  minWindowDays: number;
  phaseWidthMax: number;
  maxDurationMultipleOfSuggested: number;
  /** Fine-tune range around a peak, in grid cells each side. */
  halfWidthCells: number;
  /**
   * Relative period tolerance for a directly chosen period (no source peak).
   * `null` = the fine-tune half-width, (max/min)^(halfWidthCells/(n-1)) - 1.
   */
  periodTolerance: number | null;
  /** Harmonic multipliers tried after 1 for a direct period. */
  harmonics: number[];
};

export type RealSampleStar = {
  /** Real TIC id, decimal string. */
  ticId: string;
  role: "tutorial" | "explore";
  /** Tutorial stars: 1..5, galaxy ordinal seq - 1. */
  tutorialSeq?: number;
  /** Host name for labels, e.g. "TOI-270". */
  displayName?: string;
  tmag?: number | null;
  teffK?: number | null;
  radiusRsun?: number | null;
  /** Sectors in `segments`, ascending, unique. */
  sectors: number[];
  /** Phase 0 of every fold. */
  foldReferenceTimeBtjd: number;
  segments: RealSegment[];
  /** Must contain the original (`removedCandidateIds: []`). Same grid for all. */
  periodograms: RealPeriodogram[];
  candidates: RealCandidate[];
  rules?: Partial<RealAnalysisRules>;
  /** Source products, checksums and kernel versions (tools/real-sample). */
  provenance?: Record<string, unknown>;
};

export type RealSampleManifest = {
  format: typeof REAL_SAMPLE_FORMAT;
  generatedAt: string;
  /** Provenance in one line (archive, pipeline, catalog versions). */
  source: string;
  /** Star files in galaxy order: tutorials by seq, then explore stars. */
  stars: {
    ticId: string;
    role: RealSampleStar["role"];
    tutorialSeq?: number;
    displayName?: string;
  }[];
};

export type RealSample = {
  format: typeof REAL_SAMPLE_FORMAT;
  generatedAt: string;
  source: string;
  stars: RealSampleStar[];
};
