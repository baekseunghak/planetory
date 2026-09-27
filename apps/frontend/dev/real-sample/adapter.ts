// Real TESS sample -> the analysis HTTP bodies the cinema fixture serves.
//
// Same routes, shapes and checks as dev/periodogram-fixtures.ts (the synthetic
// TIC 259377024), so the frontend decoders read both the same way; see
// tests/unit/cinema-real-sample.test.ts. What changes is the data and the
// matching:
//
// - Matching keeps today's two rules. (1) A peak picks the signal it belongs
//   to (synthetic: grid index -> SIGNALS; real: `candidate.peaks`, within the
//   fine-tune half-width). A direct period matches within the same fine-tune
//   tolerance, harmonics included. (2) The window must cover the dip: centre
//   +- half the duration in phase (synthetic: `coversDip` at phase 0; real:
//   where this candidate's observed transits fold at the chosen period).
// - Residual steps: the curve with removed candidates divided out (the
//   kernel's box-divide-v0, see `residualFlux`); the matching periodogram if
//   the data tool precomputed it (tools/real-sample computes every removal
//   subset for stars with up to four candidates), otherwise the nearest one
//   with the removed signals' peaks damped.
import { periodAt } from "../../src/features/analysis/periodogram-data.ts";
import { withMatched } from "../analysis-fixtures.ts";
import type { OutcomeSignal } from "../submission-outcome-fixtures.ts";
import type {
  RealAnalysisRules,
  RealCandidate,
  RealPeak,
  RealPeriodogram,
  RealSample,
  RealSampleStar,
} from "./types.ts";

export const REAL_SAMPLE_BUNDLE = "9007199254742001";
export const REAL_SAMPLE_VERSIONS = {
  // Shown in the analysis header ("데이터 …"): product words, not a dev tag.
  bundle: "SPOC 2분",
  residualModel: "rm-real-sample-v1",
  periodogramConfig: "pg-real-sample-v1",
  selectionRules: "selection-real-sample-v1",
  peakRule: "peaks-real-sample-v1",
  rule: "rule-real-sample-v1",
} as const;

export const DEFAULT_REAL_RULES: RealAnalysisRules = {
  minWindowDays: 20 / 1440,
  phaseWidthMax: 0.25,
  maxDurationMultipleOfSuggested: 3,
  halfWidthCells: 3,
  periodTolerance: null,
  harmonics: [2, 0.5, 3, 1 / 3],
};

/** The member's progress on one real star, kept by the fixture plugin. */
export type RealStarState = {
  stage: "unexplored" | "in_progress" | "completed";
  /** Candidates this member matched (grows with submissions). */
  matchedCandidateIds: string[];
  /** Tutorial: skip offered (after viewing a detail on a miss). */
  tutorialSkipAvailable?: boolean;
};
export const FRESH_REAL_STATE: RealStarState = {
  stage: "unexplored",
  matchedCandidateIds: [],
};

type Reply = { status: number; body: unknown; currentBundleId: string };

export const rulesOf = (star: RealSampleStar): RealAnalysisRules => ({
  ...DEFAULT_REAL_RULES,
  ...star.rules,
});

export function realStarIndex(
  sample: RealSample | null,
): Map<string, RealSampleStar> {
  return new Map((sample?.stars ?? []).map((star) => [star.ticId, star]));
}

/**
 * Galaxy ordinal -> real star. Tutorials at `tutorialSeq - 1` (the blue
 * markers 1..5), explore stars at 5 (the challenge marker), then 8, 9, 10 ...
 * (6 and 7 keep the synthetic in-progress examples). Ordinals past
 * `starCount` are dropped: a small galaxy shows fewer real stars.
 */
export function defaultRealPlacement(
  sample: RealSample | null,
  starCount: number,
): Map<number, RealSampleStar> {
  const placed = new Map<number, RealSampleStar>();
  if (!sample) return placed;
  for (const star of sample.stars)
    if (star.role === "tutorial" && star.tutorialSeq)
      placed.set(star.tutorialSeq - 1, star);
  let next = 5;
  for (const star of sample.stars) {
    if (star.role !== "explore") continue;
    while (placed.has(next) || next === 6 || next === 7) next++;
    placed.set(next, star);
    next++;
  }
  for (const ordinal of [...placed.keys()])
    if (ordinal >= starCount) placed.delete(ordinal);
  return placed;
}

// ---------------------------------------------------------------- geometry

const frac = (value: number) => value - Math.floor(value);
const sortedKey = (ids: readonly string[]) => [...ids].sort().join(",");

function segmentEnd(segment: RealSampleStar["segments"][number]) {
  return segment.startBtjd + (segment.flux.length * segment.binMinutes) / 1440;
}
export function observationBounds(star: RealSampleStar): [number, number] {
  return [
    Math.min(...star.segments.map((s) => s.startBtjd)),
    Math.max(...star.segments.map(segmentEnd)),
  ];
}
function gridRatio(periodogram: RealPeriodogram) {
  return (
    (periodogram.periodMaxDays / periodogram.periodMinDays) **
    (1 / (periodogram.nPeriods - 1))
  );
}
const originalPeriodogram = (star: RealSampleStar) =>
  star.periodograms.find((p) => p.removedCandidateIds.length === 0)!;

/** Relative period tolerance for a direct period (see RealAnalysisRules). */
export function periodTolerance(star: RealSampleStar): number {
  const rules = rulesOf(star);
  if (rules.periodTolerance !== null) return rules.periodTolerance;
  return gridRatio(originalPeriodogram(star)) ** rules.halfWidthCells - 1;
}

/**
 * Where this candidate's dip sits when the star is folded at `periodDays`:
 * the circular mean phase of its transits inside the observed segments.
 * More than one phase when the fold period is a multiple of the true one.
 */
export function dipPhases(
  star: RealSampleStar,
  candidate: RealCandidate,
  periodDays: number,
): number[] {
  const reference = star.foldReferenceTimeBtjd;
  const groups =
    candidate.periodDays >= periodDays * 0.999
      ? 1
      : Math.min(6, Math.max(1, Math.round(periodDays / candidate.periodDays)));
  const sums = Array.from({ length: groups }, () => ({ s: 0, c: 0, n: 0 }));
  const [start, end] = observationBounds(star);
  const first = Math.ceil((start - candidate.epochBtjd) / candidate.periodDays);
  const last = Math.floor((end - candidate.epochBtjd) / candidate.periodDays);
  for (let n = first; n <= last && n - first < 20000; n++) {
    const t = candidate.epochBtjd + n * candidate.periodDays;
    if (!star.segments.some((s) => t >= s.startBtjd && t <= segmentEnd(s)))
      continue;
    const angle = 2 * Math.PI * frac((t - reference) / periodDays);
    const sum = sums[((n % groups) + groups) % groups];
    sum.s += Math.sin(angle);
    sum.c += Math.cos(angle);
    sum.n += 1;
  }
  const phases = sums
    .filter((sum) => sum.n > 0)
    .map((sum) => frac(Math.atan2(sum.s, sum.c) / (2 * Math.PI)));
  if (phases.length) return phases;
  // No transit inside the data (should not happen): fall back to the epoch.
  return Array.from({ length: groups }, (_, k) =>
    frac(
      (candidate.epochBtjd - reference + k * candidate.periodDays) / periodDays,
    ),
  );
}

export type RealSelection = {
  periodDays: number;
  sourcePeakGridIndex: number | null;
  phaseStart: number;
  phaseEnd: number;
};

/** Today's window rule (`coversDip`) with the dip where the data puts it. */
export function coversTransit(
  star: RealSampleStar,
  candidate: RealCandidate,
  selection: RealSelection,
): boolean {
  const { phaseStart: s, phaseEnd: e, periodDays: p } = selection;
  if (![s, e, p].every((v) => Number.isFinite(v)) || p <= 0) return true;
  const half = candidate.durationHours / 48 / p;
  return dipPhases(star, candidate, p).some((phase) =>
    [-1, 0, 1, 2].some((k) => s <= phase + k + half && e >= phase + k - half),
  );
}

export type RealMatch = {
  candidate: RealCandidate;
  /** candidate.periodDays ~ selection.periodDays * multiplier. */
  multiplier: number;
  via: "peak" | "period";
  windowCovered: boolean;
};

/**
 * The candidate a selection matches, or null. Candidates already removed
 * from the curve cannot be matched again.
 */
export function matchRealSelection(
  star: RealSampleStar,
  selection: RealSelection,
  options: { removedCandidateIds?: readonly string[] } = {},
): RealMatch | null {
  const removed = new Set(options.removedCandidateIds ?? []);
  const live = star.candidates.filter((c) => !removed.has(c.candidateId));
  const rules = rulesOf(star);
  let best: {
    candidate: RealCandidate;
    multiplier: number;
    via: RealMatch["via"];
    score: number;
  } | null = null;
  const source = selection.sourcePeakGridIndex;
  if (source !== null)
    for (const candidate of live)
      for (const link of candidate.peaks ?? []) {
        const distance = Math.abs(link.gridIndex - source);
        if (distance > rules.halfWidthCells) continue;
        const score = distance + (link.multiplier === 1 ? 0 : 0.5);
        if (!best || score < best.score)
          best = { candidate, multiplier: link.multiplier, via: "peak", score };
      }
  if (!best && selection.periodDays > 0) {
    const tolerance = periodTolerance(star);
    for (const candidate of live)
      for (const multiplier of [1, ...rules.harmonics]) {
        const error =
          Math.abs(selection.periodDays * multiplier - candidate.periodDays) /
          candidate.periodDays;
        if (error > tolerance) continue;
        const score = error + (multiplier === 1 ? 0 : tolerance / 2);
        if (!best || score < best.score)
          best = { candidate, multiplier, via: "period", score };
      }
  }
  if (!best) return null;
  return {
    candidate: best.candidate,
    multiplier: best.multiplier,
    via: best.via,
    windowCovered: coversTransit(star, best.candidate, selection),
  };
}

const DISPOSITION = {
  confirmed: "CONFIRMED",
  candidate: "UNCONFIRMED",
  fp: "FP",
} as const;
const CATALOG_DISPOSITION = { confirmed: "CP", candidate: "PC", fp: "FP" };

/** A real candidate in the shape the submission fixture puts in a result. */
export function realOutcomeSignal(
  candidate: RealCandidate,
  multiplier = 1,
): OutcomeSignal {
  return {
    candidateId: candidate.candidateId,
    disposition: DISPOSITION[candidate.kind],
    harmonicMultiplier: multiplier === 1 ? null : multiplier,
    // No invented scores: a real sample without a model run says so.
    ai: candidate.ai
      ? {
          status: "completed",
          score: candidate.ai.score,
          verdict: candidate.ai.verdict,
          modelVersion: candidate.ai.modelVersion,
        }
      : { status: "not_evaluated", modelVersion: null },
    external: candidate.externalLabel
      ? [
          {
            source: candidate.externalSource ?? "TOI",
            externalId: candidate.externalLabel,
            disposition:
              candidate.externalDisposition ??
              CATALOG_DISPOSITION[candidate.kind],
          },
        ]
      : [],
    bls: {
      periodDays: candidate.periodDays,
      epochBtjd: candidate.epochBtjd,
      durationHours: candidate.durationHours,
      depthPpm: candidate.depthPpm,
    },
  };
}

/**
 * Hook for `submissionFixtureResponse({ matchSignal })`: the matched signal,
 * or null for a miss (no candidate, or the window misses the dip while
 * `windowRule` is on).
 */
export function realMatchSignal(
  star: RealSampleStar,
  selection: Record<string, unknown>,
  options: {
    windowRule?: boolean;
    removedCandidateIds?: readonly string[];
  } = {},
): OutcomeSignal | null {
  const match = matchRealSelection(
    star,
    {
      periodDays: Number(selection.periodDays),
      sourcePeakGridIndex:
        typeof selection.sourcePeakGridIndex === "number"
          ? selection.sourcePeakGridIndex
          : null,
      phaseStart: Number(selection.phaseStart),
      phaseEnd: Number(selection.phaseEnd),
    },
    options,
  );
  if (!match) return null;
  if ((options.windowRule ?? true) && !match.windowCovered) return null;
  return realOutcomeSignal(match.candidate, match.multiplier);
}

/**
 * Hook for `submissionFixtureResponse({ detailSignal })`: the matched
 * candidate, or for a miss the strongest candidate not matched yet (by the
 * rank of its peak in the original periodogram).
 */
export function realDetailSignal(
  star: RealSampleStar,
  matchedCandidateId: string | null,
  exclude: readonly string[] = [],
): OutcomeSignal | null {
  if (matchedCandidateId) {
    const found = star.candidates.find(
      (c) => c.candidateId === matchedCandidateId,
    );
    return found ? realOutcomeSignal(found) : null;
  }
  const original = originalPeriodogram(star);
  const rankOf = (candidate: RealCandidate) =>
    Math.min(
      ...(candidate.peaks ?? []).map(
        (link) =>
          original.peaks.find((peak) => peak.gridIndex === link.gridIndex)
            ?.rank ?? Infinity,
      ),
      Infinity,
    );
  const hint = star.candidates
    .filter((c) => !exclude.includes(c.candidateId))
    .sort((a, b) => rankOf(a) - rankOf(b) || b.depthPpm - a.depthPpm)[0];
  return hint ? realOutcomeSignal(hint) : null;
}

// ---------------------------------------------------------------- bodies

function curveContext(removed: readonly string[]) {
  const ids = [...removed].sort();
  return {
    bundleId: REAL_SAMPLE_BUNDLE,
    curveStep: ids.length,
    removedCandidateIds: ids,
    residualModelVersion: REAL_SAMPLE_VERSIONS.residualModel,
    periodogramConfigVersion: REAL_SAMPLE_VERSIONS.periodogramConfig,
  };
}

/** GET /v1/stars/:tic/analysis-context for a real star. */
export function realAnalysisContext(
  star: RealSampleStar,
  state: RealStarState = FRESH_REAL_STATE,
) {
  const rules = rulesOf(star);
  const bounds = observationBounds(star);
  const current = curveContext([]);
  const matched = state.matchedCandidateIds.filter((id) =>
    star.candidates.some((c) => c.candidateId === id),
  );
  const result = withMatched(
    {
      ticId: star.ticId,
      star: {
        sectorCount: star.sectors.length,
        sectors: [...star.sectors],
        tmag: star.tmag ?? null,
      },
      hasConfirmedCandidate: star.candidates.some(
        (c) => c.kind === "confirmed",
      ),
      bundle: {
        bundleId: REAL_SAMPLE_BUNDLE,
        bundleVersion: REAL_SAMPLE_VERSIONS.bundle,
        publishedAt: "2026-09-26T00:00:00Z",
        foldReferenceTimeBtjd: star.foldReferenceTimeBtjd,
        baseDays: bounds[1] - bounds[0],
        observationBounds: bounds,
        residualModelVersion: current.residualModelVersion,
        periodogramConfigVersion: current.periodogramConfigVersion,
        curveStepRule: "one_candidate_per_step",
      },
      selectionRules: {
        version: REAL_SAMPLE_VERSIONS.selectionRules,
        minWindowDays: rules.minWindowDays,
        phaseWidthMax: rules.phaseWidthMax,
        maxDurationMultipleOfSuggested: rules.maxDurationMultipleOfSuggested,
        allowEmptyPhaseSpan: false,
        fineTune: { halfWidthCells: rules.halfWidthCells },
      },
      progress: {
        stage: state.stage,
        currentCurveStep: 0,
        matchedCandidateIds: matched,
        completionReason: null,
        reopenPending: false,
        achievementCount: 0,
        grade: null,
      },
      currentCurveContext: current,
      residualForCurrentStep: { status: "COMPLETED", jobId: null },
      tutorial: {
        seq: star.role === "tutorial" ? (star.tutorialSeq ?? null) : null,
        skipAvailable:
          star.role === "tutorial" && state.tutorialSkipAvailable === true,
      },
      ruleVersion: REAL_SAMPLE_VERSIONS.rule,
    },
    matched,
  ) as ReturnType<typeof withMatched> & Record<string, unknown>;
  // Every residual step of a real star is served at once (precomputed or
  // derived below), so the next step is always ready: no residual job.
  if (result.nextCurveContext)
    result.residualForNextStep = { status: "COMPLETED", jobId: null };
  return result;
}

/**
 * Flux with the removed candidates divided out, as astro-kernel
 * `remove_transit_models` (box-divide-v0) does for the Gold residual steps:
 * evaluated at bin centres (D06 decision 3), in transit when
 * |phase distance| < duration / 2 (strict), overlapping boxes multiply.
 * The data tool computed the residual periodograms from the same formula.
 */
export function residualFlux(
  segment: RealSampleStar["segments"][number],
  removed: readonly RealCandidate[],
): (number | null)[] {
  if (!removed.length) return segment.flux;
  const step = segment.binMinutes / 1440;
  return segment.flux.map((value, index) => {
    if (value === null) return null;
    const t = segment.startBtjd + (index + 0.5) * step;
    let model = 1;
    for (const candidate of removed) {
      const p = candidate.periodDays;
      const shifted = (t - candidate.epochBtjd + p / 2) % p;
      const distance = (shifted < 0 ? shifted + p : shifted) - p / 2;
      if (Math.abs(distance) < candidate.durationHours / 48)
        model *= 1 - candidate.depthPpm / 1e6;
    }
    return value / model;
  });
}

function nullRuns(flux: readonly (number | null)[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  flux.forEach((value, index) => {
    if (value === null && start < 0) start = index;
    if (value !== null && start >= 0) {
      runs.push([start, index - 1]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, flux.length - 1]);
  return runs;
}

/** Periodogram and peaks for a removed set (see file header). */
export function realPeriodogramFor(
  star: RealSampleStar,
  removedIds: readonly string[],
): { periodogram: RealPeriodogram; power: number[]; peaks: RealPeak[] } {
  const key = sortedKey(removedIds);
  const exact = star.periodograms.find(
    (p) => sortedKey(p.removedCandidateIds) === key,
  );
  if (exact)
    return { periodogram: exact, power: exact.power, peaks: exact.peaks };
  const base = star.periodograms
    .filter((p) => p.removedCandidateIds.every((id) => removedIds.includes(id)))
    .sort(
      (a, b) => b.removedCandidateIds.length - a.removedCandidateIds.length,
    )[0];
  const extra = star.candidates.filter(
    (c) =>
      removedIds.includes(c.candidateId) &&
      !base.removedCandidateIds.includes(c.candidateId),
  );
  const ratio = gridRatio(base);
  const cells = new Set<number>();
  for (const candidate of extra) {
    for (const link of candidate.peaks ?? []) cells.add(link.gridIndex);
    for (const multiple of [1, 0.5, 2]) {
      const period = candidate.periodDays * multiple;
      const index = Math.round(
        Math.log(period / base.periodMinDays) / Math.log(ratio),
      );
      if (index >= 0 && index < base.nPeriods) cells.add(index);
    }
  }
  const width = Math.max(12, rulesOf(star).halfWidthCells * 4);
  const floor = [...base.power].sort((a, b) => a - b)[
    Math.floor(base.power.length / 2)
  ];
  const power = base.power.map((value, index) => {
    let damp = 0;
    for (const cell of cells)
      damp = Math.max(damp, Math.exp(-(((index - cell) / (width / 2)) ** 2)));
    return floor + (value - floor) * (1 - 0.9 * damp);
  });
  const peaks = base.peaks
    .filter(
      (peak) => ![...cells].some((c) => Math.abs(c - peak.gridIndex) <= width),
    )
    .sort((a, b) => a.rank - b.rank)
    .map((peak, index) => ({ ...peak, rank: index + 1 }));
  return { periodogram: base, power, peaks };
}

/**
 * GET /v1/stars/:tic/{analysis-context|curves|periodogram|candidate-peaks}
 * for a real star, or null for another path. `state` is the member's
 * progress on this star.
 */
export function realAnalysisResponse(
  star: RealSampleStar,
  url: URL,
  state: RealStarState = FRESH_REAL_STATE,
): Reply | null {
  const match =
    /^\/v1\/stars\/([^/]+)\/(analysis-context|curves|periodogram|candidate-peaks)$/.exec(
      url.pathname,
    );
  if (!match || decodeURIComponent(match[1]) !== star.ticId) return null;
  const resource = match[2];
  const reply = (status: number, body: unknown): Reply => ({
    status,
    body,
    currentBundleId: REAL_SAMPLE_BUNDLE,
  });
  const context = realAnalysisContext(star, state);
  if (resource === "analysis-context") return reply(200, context);
  if (url.searchParams.get("bundleId") !== REAL_SAMPLE_BUNDLE)
    return reply(409, {
      code: "BUNDLE_CHANGED",
      message: "새 데이터 판을 다시 불러와 주세요.",
      currentBundleId: REAL_SAMPLE_BUNDLE,
    });
  const removedIds = (url.searchParams.get("removed") ?? "")
    .split(",")
    .filter(Boolean);
  const step = Number(url.searchParams.get("curveStep"));
  if (
    !Number.isInteger(step) ||
    step !== removedIds.length ||
    new Set(removedIds).size !== removedIds.length ||
    removedIds.some((id) => !star.candidates.some((c) => c.candidateId === id))
  )
    return reply(400, {
      code: "VALIDATION_FAILED",
      message: "곡선 문맥을 확인해 주세요.",
      fieldErrors: [],
    });
  const asked = curveContext(removedIds);
  const removed = star.candidates.filter((c) =>
    removedIds.includes(c.candidateId),
  );
  if (resource === "curves")
    return reply(200, {
      ticId: star.ticId,
      bundleId: REAL_SAMPLE_BUNDLE,
      foldReferenceTimeBtjd: star.foldReferenceTimeBtjd,
      curveContext: asked,
      residual: { status: "COMPLETED", jobId: null },
      fluxUnit: "normalized",
      segments: star.segments.map((segment, index) => {
        const flux = residualFlux(segment, removed);
        return {
          segmentId: String(BigInt(REAL_SAMPLE_BUNDLE) + BigInt(index + 1)),
          sector: segment.sector,
          binningRevision: `${segment.binMinutes}m-real-v1`,
          startBtjd: segment.startBtjd,
          binMinutes: segment.binMinutes,
          nPoints: flux.length,
          flux,
          fluxScatter: segment.fluxScatter,
          gaps: nullRuns(flux),
        };
      }),
    });
  const { periodogram, power, peaks } = realPeriodogramFor(star, removedIds);
  const grid = {
    periodMinDays: periodogram.periodMinDays,
    periodMaxDays: periodogram.periodMaxDays,
    nPeriods: periodogram.nPeriods,
  };
  const bounds = observationBounds(star);
  if (resource === "periodogram")
    return reply(200, {
      curveContext: asked,
      residual: { status: "COMPLETED", jobId: null },
      ...grid,
      gridRule: "log",
      baselineHalfDays: (bounds[1] - bounds[0]) / 2,
      power,
    });
  const ratio = gridRatio(periodogram);
  const half = rulesOf(star).halfWidthCells;
  return reply(200, {
    curveContext: asked,
    peaks: peaks.map((peak) => {
      const periodDays = periodAt(grid, peak.gridIndex);
      return {
        rank: peak.rank,
        gridIndex: peak.gridIndex,
        periodDays,
        power: power[peak.gridIndex],
        fineTune: {
          periodMinDays: periodDays * ratio ** -half,
          periodMaxDays: periodDays * ratio ** half,
          periodStepDays: periodDays * (ratio - 1),
        },
        suggestedDurationHours: peak.suggestedDurationHours,
        suggestedPhaseCenter: peak.suggestedPhaseCenter,
      };
    }),
    matchedCandidates: star.candidates
      .filter(
        (c) =>
          state.matchedCandidateIds.includes(c.candidateId) &&
          !removedIds.includes(c.candidateId),
      )
      .map((c) => ({ candidateId: c.candidateId, periodDays: c.periodDays })),
    peakRuleVersion: REAL_SAMPLE_VERSIONS.peakRule,
  });
}
