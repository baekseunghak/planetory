import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { outcomeFromReceipt } from "../../src/cinema/analysis/bridge";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data";
import {
  decodeCandidatePeaks,
  decodePeriodogram,
  periodAt,
} from "../../src/features/analysis/periodogram-data";
import { decodeSubmissionReceipt } from "../../src/features/analysis/submission-data";
import { decodeDetailView } from "../../src/features/analysis/submission-result";
import { readSkyTiles } from "../../src/features/sky-data/contracts";
import { galaxyFixturePlugin } from "../../dev/galaxy-fixture-plugin";
import {
  SUBMISSION_FIXTURE_CSRF,
  submissionFixtureResponse,
} from "../../dev/submission-fixtures";
import {
  REAL_SAMPLE_DIR,
  REAL_SAMPLE_FORMAT,
  loadRealSample,
  validateRealSample,
  type RealCandidate,
  type RealSample,
  type RealSampleStar,
} from "../../dev/real-sample";
import {
  REAL_SAMPLE_BUNDLE,
  defaultRealPlacement,
  matchRealSelection,
  realAnalysisResponse,
  realDetailSignal,
  realMatchSignal,
  residualFlux,
  type RealStarState,
} from "../../dev/real-sample/adapter";

// The real-sample contract: whatever the data tool writes goes through the
// same frontend decoders as the synthetic fixtures. The star below is made up
// in the test (two box transits on a flat curve), not real data.
const GRID = { periodMinDays: 0.5, periodMaxDays: 40, nPeriods: 5000 };
const cell = (period: number) =>
  Math.round(
    (Math.log(period / GRID.periodMinDays) /
      Math.log(GRID.periodMaxDays / GRID.periodMinDays)) *
      (GRID.nPeriods - 1),
  );
const A: RealCandidate = {
  candidateId: "9007199254800001",
  kind: "confirmed",
  periodDays: 3.3,
  epochBtjd: 1326.5,
  durationHours: 2,
  depthPpm: 2000,
  externalLabel: "TOI-9999.01",
  planetName: "TOI-9999 b",
  peaks: [
    { gridIndex: cell(3.3), multiplier: 1 },
    { gridIndex: cell(1.65), multiplier: 2 },
  ],
};
const B: RealCandidate = {
  candidateId: "9007199254800002",
  kind: "candidate",
  periodDays: 7.9,
  epochBtjd: 1328.1,
  durationHours: 3,
  depthPpm: 900,
  externalLabel: "TOI-9999.02",
  peaks: [{ gridIndex: cell(7.9), multiplier: 1 }],
};
const REFERENCE = 1330;
const phaseOf = (c: RealCandidate, period = c.periodDays) =>
  ((((c.epochBtjd - REFERENCE) / period) % 1) + 1) % 1;

function segment(sector: number, startBtjd: number) {
  const binMinutes = 10,
    n = 27 * 144;
  const flux = Array.from({ length: n }, (_, i): number | null => {
    if (i >= 1800 && i < 1872) return null; // data downlink gap
    const t = startBtjd + (i * binMinutes) / 1440;
    let value = 1 + ((((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 2e-4;
    for (const c of [A, B]) {
      const d = Math.abs(
        t -
          c.epochBtjd -
          Math.round((t - c.epochBtjd) / c.periodDays) * c.periodDays,
      );
      if (d <= c.durationHours / 48) value -= c.depthPpm / 1e6;
    }
    return value;
  });
  return { sector, startBtjd, binMinutes, flux, fluxScatter: 1e-4 };
}
const power = Array.from({ length: GRID.nPeriods }, (_, i) =>
  [
    [cell(3.3), 1],
    [cell(7.9), 0.6],
    [cell(1.65), 0.45],
  ].reduce(
    (sum, [center, height]) =>
      sum + height * Math.exp(-(((i - center) / 6) ** 2)),
    0.02,
  ),
);
const STAR: RealSampleStar = {
  ticId: "261136679",
  role: "explore",
  displayName: "TOI-9999",
  tmag: 9.1,
  sectors: [1, 2],
  foldReferenceTimeBtjd: REFERENCE,
  segments: [segment(1, 1325.3), segment(2, 1353.2)],
  periodograms: [
    {
      removedCandidateIds: [],
      ...GRID,
      power,
      peaks: [
        {
          rank: 1,
          gridIndex: cell(3.3),
          suggestedDurationHours: 2,
          suggestedPhaseCenter: phaseOf(A),
        },
        {
          rank: 2,
          gridIndex: cell(7.9),
          suggestedDurationHours: 3,
          suggestedPhaseCenter: phaseOf(B),
        },
        {
          rank: 3,
          gridIndex: cell(1.65),
          suggestedDurationHours: 2,
          suggestedPhaseCenter: null,
        },
      ],
    },
  ],
  candidates: [A, B],
};
const TUTORIAL: RealSampleStar = {
  ...STAR,
  ticId: "150428135",
  role: "tutorial",
  tutorialSeq: 2,
  candidates: [
    { ...A, candidateId: "9007199254800011" },
    { ...B, candidateId: "9007199254800012" },
  ],
};
const SAMPLE: RealSample = {
  format: REAL_SAMPLE_FORMAT,
  generatedAt: "2026-09-26T00:00:00Z",
  source: "unit test",
  stars: [TUTORIAL, STAR],
};
const url = (resource: string, removed: string[] = []) => {
  const query = new URLSearchParams({
    bundleId: REAL_SAMPLE_BUNDLE,
    curveStep: String(removed.length),
  });
  if (removed.length) query.set("removed", removed.join(","));
  return new URL(
    `http://fixture.invalid/v1/stars/${STAR.ticId}/${resource}?${query}`,
  );
};
const read = (
  resource: string,
  state?: RealStarState,
  removed: string[] = [],
) => {
  const reply = realAnalysisResponse(STAR, url(resource, removed), state);
  assert.ok(reply, resource);
  assert.equal(reply.status, 200, JSON.stringify(reply.body).slice(0, 300));
  return reply.body;
};

test("no folder means no sample; a bad sample is refused with a path", () => {
  assert.equal(
    loadRealSample(join(tmpdir(), `no-sample-${randomUUID()}`)),
    null,
  );
  assert.equal(validateRealSample(SAMPLE), SAMPLE);
  assert.throws(
    () =>
      validateRealSample({
        ...SAMPLE,
        stars: [STAR, { ...STAR, ticId: "261136680" }],
      }),
    /candidateId must be unique/,
  );
});

test("context, curves, periodogram and peaks decode like the service", () => {
  const context = decodeAnalysisContext(read("analysis-context"), STAR.ticId);
  assert.deepEqual(context.sectors, [1, 2]);
  assert.equal(context.hasConfirmedCandidate, true);
  assert.equal(context.curveContext.bundleId, REAL_SAMPLE_BUNDLE);
  const curve = decodeCurve(read("curves"), context, 200);
  assert.equal(curve.kind, "ready");
  if (curve.kind === "ready") {
    assert.equal(curve.segments.length, 2);
    assert.deepEqual(curve.segments[0].gaps, [[1800, 1871]]);
  }
  const grid = decodePeriodogram(read("periodogram"), context);
  const peaks = decodeCandidatePeaks(read("candidate-peaks"), context, grid);
  assert.deepEqual(
    peaks.peaks.map((peak) => peak.gridIndex),
    [cell(3.3), cell(7.9), cell(1.65)],
  );
  assert.equal(peaks.peaks[0].periodDays, periodAt(grid, cell(3.3)));
});

test("a wrong bundle or an unknown removal is refused, not guessed", () => {
  const stale = new URL(url("curves"));
  stale.searchParams.set("bundleId", "1");
  assert.equal(realAnalysisResponse(STAR, stale)?.status, 409);
  assert.equal(realAnalysisResponse(STAR, url("curves", ["123"]))?.status, 400);
});

test("the next step removes the matched signal from curve and periodogram", () => {
  const state: RealStarState = {
    stage: "in_progress",
    matchedCandidateIds: [A.candidateId],
  };
  const entry = decodeAnalysisContext(
    read("analysis-context", state),
    STAR.ticId,
  );
  assert.deepEqual(entry.nextCurveContext?.removedCandidateIds, [
    A.candidateId,
  ]);
  assert.equal(entry.nextResidual?.status, "COMPLETED");
  const next = { ...entry, curveContext: entry.nextCurveContext! };
  const curve = decodeCurve(read("curves", state, [A.candidateId]), next, 200);
  assert.equal(curve.kind, "ready");
  if (curve.kind !== "ready") return;
  const flux = curve.segments[0].flux;
  const inTransit = Math.round(((A.epochBtjd - 1325.3) * 1440) / 10);
  assert.ok(Math.abs((flux[inTransit] as number) - 1) < 5e-4, "A boxed out");
  const grid = decodePeriodogram(
    read("periodogram", state, [A.candidateId]),
    next,
  );
  const peaks = decodeCandidatePeaks(
    read("candidate-peaks", state, [A.candidateId]),
    next,
    grid,
  );
  assert.deepEqual(
    peaks.peaks.map((peak) => [peak.rank, peak.gridIndex]),
    [[1, cell(7.9)]],
  );
  assert.ok(grid.power[cell(3.3)] < power[cell(3.3)] / 3);
});

test("matching keeps today's rules: the peak, the fine-tune tolerance, the dip window", () => {
  const dip = phaseOf(A);
  const over = { phaseStart: dip - 0.01, phaseEnd: dip + 0.01 };
  const away = { phaseStart: dip + 0.4, phaseEnd: dip + 0.42 };
  const peak = periodAt(GRID, cell(3.3));
  const byPeak = matchRealSelection(STAR, {
    periodDays: peak,
    sourcePeakGridIndex: cell(3.3),
    ...over,
  });
  assert.equal(byPeak?.candidate.candidateId, A.candidateId);
  assert.equal(byPeak?.via, "peak");
  assert.equal(byPeak?.windowCovered, true);
  assert.equal(
    matchRealSelection(STAR, {
      periodDays: peak,
      sourcePeakGridIndex: cell(3.3),
      ...away,
    })?.windowCovered,
    false,
  );
  assert.equal(
    realMatchSignal(STAR, {
      periodDays: peak,
      sourcePeakGridIndex: cell(3.3),
      ...away,
    }),
    null,
  );
  // A direct period inside the fine-tune half-width still matches.
  const direct = matchRealSelection(STAR, {
    periodDays: 3.3 * 1.001,
    sourcePeakGridIndex: null,
    ...over,
  });
  assert.equal(direct?.via, "period");
  assert.equal(direct?.multiplier, 1);
  assert.equal(
    matchRealSelection(STAR, {
      periodDays: 3.3 * 1.02,
      sourcePeakGridIndex: null,
      ...over,
    }),
    null,
  );
  // Half the period folds every transit to one phase: a harmonic match.
  const half = matchRealSelection(STAR, {
    periodDays: 1.65,
    sourcePeakGridIndex: null,
    phaseStart: phaseOf(A, 1.65) - 0.02,
    phaseEnd: phaseOf(A, 1.65) + 0.02,
  });
  assert.equal(half?.multiplier, 2);
  assert.equal(half?.windowCovered, true);
  // A removed candidate cannot be matched again.
  assert.equal(
    matchRealSelection(
      STAR,
      { periodDays: peak, sourcePeakGridIndex: cell(3.3), ...over },
      { removedCandidateIds: [A.candidateId] },
    ),
    null,
  );
});

function submit(
  selection: Record<string, unknown>,
  userJudgment: "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE",
) {
  const requestId = randomUUID();
  const context = realAnalysisResponse(STAR, url("analysis-context"))!;
  const reply = submissionFixtureResponse({
    method: "POST",
    url: new URL(`http://fixture.invalid/v1/stars/${STAR.ticId}/submissions`),
    csrf: SUBMISSION_FIXTURE_CSRF,
    scenario: null,
    outcome: null,
    body: {
      requestId,
      submissionKind: "candidate",
      curveContext: (context.body as { currentCurveContext: unknown })
        .currentCurveContext,
      selection,
      userJudgment,
      evidenceChecks: [],
      memo: "",
    },
    contextFor: (tic) =>
      tic === STAR.ticId
        ? realAnalysisResponse(STAR, url("analysis-context"))
        : null,
    matchSignal: (tic, chosen) =>
      tic === STAR.ticId ? realMatchSignal(STAR, chosen) : undefined,
    detailSignal: (tic, matched) =>
      tic === STAR.ticId ? realDetailSignal(STAR, matched) : undefined,
  });
  assert.ok(reply && reply.kind === "json");
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return {
    receipt: decodeSubmissionReceipt(
      reply.body,
      { ticId: STAR.ticId, requestId },
      201,
    ),
    body: reply.body as Record<string, any>,
  };
}

test("a real match goes through the submission fixture and the bridge", () => {
  const dip = phaseOf(A);
  const { receipt, body } = submit(
    {
      periodDays: periodAt(GRID, cell(3.3)),
      sourcePeakGridIndex: cell(3.3),
      phaseStart: dip - 0.01,
      phaseEnd: dip + 0.01,
    },
    "LIKELY_PLANET",
  );
  assert.equal(receipt.matchStatus, "matched");
  assert.equal(body.signal.bls.periodDays, A.periodDays);
  assert.equal(body.signal.ai.status, "not_evaluated");
  assert.equal(body.signal.ai.modelVersion, null);
  assert.deepEqual(body.signal.external[0].externalId, "TOI-9999.01");
  const outcome = outcomeFromReceipt(receipt, {
    firstView: true,
    userJudgment: "LIKELY_PLANET",
  });
  assert.equal(outcome.kind, "matched");
  assert.equal(outcome.revealsPlanet, true);

  const harmonic = submit(
    {
      periodDays: periodAt(GRID, cell(1.65)),
      sourcePeakGridIndex: cell(1.65),
      phaseStart: phaseOf(A, periodAt(GRID, cell(1.65))) - 0.02,
      phaseEnd: phaseOf(A, periodAt(GRID, cell(1.65))) + 0.02,
    },
    "UNSURE",
  );
  assert.equal(harmonic.receipt.matchStatus, "matched_harmonic");
  assert.equal(harmonic.body.match.harmonicMultiplier, 2);
  assert.equal(harmonic.body.match.correctionReason, "P/2 alias");

  const miss = submit(
    {
      periodDays: 5.5,
      sourcePeakGridIndex: null,
      phaseStart: 0.1,
      phaseEnd: 0.12,
    },
    "LIKELY_PLANET",
  );
  assert.equal(miss.receipt.matchStatus, "not_matched");
  const detail = submissionFixtureResponse({
    method: "POST",
    url: new URL(
      `http://fixture.invalid/v1/submissions/${miss.receipt.submissionId}/detail-view`,
    ),
    csrf: SUBMISSION_FIXTURE_CSRF,
    scenario: null,
    outcome: null,
    body: null,
    contextFor: () => null,
    detailSignal: (tic, matched) =>
      tic === STAR.ticId ? realDetailSignal(STAR, matched) : undefined,
  });
  assert.ok(detail && detail.kind === "json");
  const view = decodeDetailView(detail.body, {
    submissionId: miss.receipt.submissionId,
  });
  // The hint is the strongest real candidate, not the synthetic one.
  assert.equal(view.signal.candidateId, A.candidateId);
});

test("real stars take the tutorial and explore ordinals of the galaxy", () => {
  const placed = defaultRealPlacement(SAMPLE, 1000);
  assert.equal(placed.get(1)?.ticId, TUTORIAL.ticId);
  assert.equal(placed.get(5)?.ticId, STAR.ticId);
  assert.equal(defaultRealPlacement(SAMPLE, 5).has(5), false);
  assert.equal(defaultRealPlacement(null, 1000).size, 0);
});

test("the galaxy fixture serves real TICs in TIC order at the same layout", () => {
  const plugin = galaxyFixturePlugin(false, 40, {
    ticFor: (index) => (index === 5 ? STAR.ticId : String(900000001 + index)),
    planetCountFor: (index, fallback) => (index === 5 ? 0 : fallback),
  });
  let handler: (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => void = () => undefined;
  (plugin.configureServer as unknown as (server: unknown) => void)({
    middlewares: { use: (_: string, h: typeof handler) => (handler = h) },
  });
  const call = (path: string) => {
    let body = "";
    handler(
      { method: "GET", url: path, headers: {} } as IncomingMessage,
      {
        writeHead: () => undefined,
        setHeader: () => undefined,
        end: (chunk: string) => (body = chunk),
      } as unknown as ServerResponse,
      () => undefined,
    );
    return JSON.parse(body);
  };
  const meta = call("/v1/me/sky");
  const tiles = readSkyTiles(
    call(
      `/v1/me/sky/tiles?level=0&x=-2048&y=-2048&w=4096&h=4096&version=${encodeURIComponent(meta.version)}`,
    ),
  );
  const real = tiles.stars.find((star) => star.ticId === STAR.ticId);
  assert.equal(real?.layoutOrdinal, 5);
  assert.equal(real?.planetCount, 0);
  assert.equal(call(`/v1/me/sky/locate?ticId=${STAR.ticId}`).layoutOrdinal, 5);
});

test("residual steps divide the removed boxes out like astro-kernel", () => {
  // libs/astro-kernel/examples/removal_case.json is the kernel's contract
  // example (two overlapping box models, three empty bins). Its times are the
  // evaluation times, so the segment starts half a bin earlier (bin centres).
  const example = JSON.parse(
    readFileSync(
      new URL(
        "../../../../libs/astro-kernel/examples/removal_case.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const binMinutes = example.segment.bin_minutes as number;
  const segment = {
    sector: 3,
    startBtjd: example.time_btjd[0] - binMinutes / 2880,
    binMinutes,
    flux: example.flux_observed as (number | null)[],
    fluxScatter: 0,
  };
  const removed = (example.models as any[]).map(
    (model, index): RealCandidate => ({
      candidateId: String(9007199254900001 + index),
      kind: "candidate",
      periodDays: model.parameters.period_days,
      epochBtjd: model.parameters.epoch_btjd,
      durationHours: model.parameters.duration_hours,
      depthPpm: model.parameters.depth_ppm,
    }),
  );
  const expected = example.expected.remove_all.flux_residual as (
    number | null
  )[];
  const actual = residualFlux(segment, removed);
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    const want = expected[index];
    if (want === null) return assert.equal(value, null, `bin ${index}`);
    assert.ok(Math.abs((value as number) - want) < 1e-12, `bin ${index}`);
  });
  assert.equal(residualFlux(segment, []), segment.flux);
});

// The local sample built by tools/real-sample (gitignored). Skipped when it
// has not been built on this machine.
const LOCAL = existsSync(join(REAL_SAMPLE_DIR, "manifest.json"))
  ? loadRealSample()
  : null;

test(
  "local real sample: decodes, and each candidate is found by its recommended peak",
  { skip: LOCAL ? false : "no apps/frontend/.real-sample (tools/real-sample)" },
  () => {
    for (const star of LOCAL!.stars) {
      const removed: string[] = [];
      const reads = (resource: string) => {
        const query = new URLSearchParams({
          bundleId: REAL_SAMPLE_BUNDLE,
          curveStep: String(removed.length),
        });
        if (removed.length) query.set("removed", removed.join(","));
        const reply = realAnalysisResponse(
          star,
          new URL(
            `http://fixture.invalid/v1/stars/${star.ticId}/${resource}?${query}`,
          ),
          { stage: "in_progress", matchedCandidateIds: [...removed] },
        );
        assert.equal(reply?.status, 200, `${star.ticId} ${resource}`);
        return reply!.body;
      };
      const entry = decodeAnalysisContext(
        reads("analysis-context"),
        star.ticId,
      );
      const order = [...star.candidates].sort(
        (a, b) => (a.removalStep ?? 0) - (b.removalStep ?? 0),
      );
      for (const target of order) {
        const context = {
          ...entry,
          curveContext: {
            ...entry.curveContext,
            curveStep: removed.length,
            removedCandidateIds: [...removed].sort(),
          },
        };
        const curve = decodeCurve(reads("curves"), context, 200);
        assert.equal(curve.kind, "ready", star.ticId);
        const grid = decodePeriodogram(reads("periodogram"), context);
        const body = reads("candidate-peaks") as { peaks: RealPeakBody[] };
        decodeCandidatePeaks(body, context, grid);
        // The first listed peak the service rules would match, selected with
        // the window the peak suggests.
        const hit = body.peaks
          .map((peak) => {
            const period = periodAt(grid, peak.gridIndex);
            const centre = peak.suggestedPhaseCenter ?? 0;
            const half = Math.min(
              0.1,
              ((peak.suggestedDurationHours ?? 2) / 24 / period) * 0.75,
            );
            const selection = {
              periodDays: period,
              sourcePeakGridIndex: peak.gridIndex,
              phaseStart: centre - half,
              phaseEnd: centre + half,
            };
            return {
              selection,
              match: matchRealSelection(star, selection, {
                removedCandidateIds: removed,
              }),
            };
          })
          .find((item) => item.match);
        assert.ok(
          hit,
          `${star.ticId}: no listed peak matches at step ${removed.length}`,
        );
        assert.equal(
          hit.match!.candidate.candidateId,
          target.candidateId,
          `${star.ticId}: step ${removed.length} finds the kernel's next signal`,
        );
        assert.ok(
          realMatchSignal(star, hit.selection, {
            removedCandidateIds: removed,
          }),
          `${star.ticId}: the suggested window covers the dip`,
        );
        removed.push(target.candidateId);
      }
    }
    // Sanity against the catalog periods the repo already holds (references.csv).
    const toi270 = LOCAL!.stars.find((star) => star.ticId === "259377017");
    if (toi270)
      for (const [name, period] of [
        ["TOI-270 b", 3.35992],
        ["TOI-270 c", 5.66051],
        ["TOI-270 d", 11.38194],
      ] as const) {
        const found = toi270.candidates.find((c) => c.planetName === name);
        assert.ok(found, name);
        assert.ok(Math.abs(found.periodDays / period - 1) < 1e-3, name);
      }
  },
);

type RealPeakBody = {
  gridIndex: number;
  suggestedDurationHours: number | null;
  suggestedPhaseCenter: number | null;
};
