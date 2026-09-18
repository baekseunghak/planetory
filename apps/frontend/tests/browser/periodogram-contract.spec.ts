import { expect, test } from "@playwright/test";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data.ts";
import {
  decodeCandidatePeaks,
  decodePeriodogram,
  periodogramPath,
} from "../../src/features/analysis/periodogram-data.ts";
import { PERIODOGRAM_FIXTURE_TICS as tics } from "../../dev/periodogram-fixtures.ts";

test("browser client loads one matching context, curve, full periodogram and public peaks through HTTP", async ({
  page,
}) => {
  await page.goto(`/analysis/${tics.normal}`);
  const result = await page.evaluate(async (tic) => {
    const paths = [
      "/src/api/client.ts",
      "/src/features/analysis/load-analysis.ts",
      "/src/features/analysis/load-periodogram.ts",
    ];
    const [{ createApiClient }, { loadAnalysis }, { loadPeriodogram }] =
      await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: "/api",
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        return fetch(input, init);
      },
    });
    const signal = new AbortController().signal;
    const analysis = await loadAnalysis(client.request, tic, signal, () => {});
    const data = await loadPeriodogram(
      client.request,
      analysis.context,
      analysis.curve,
      signal,
    );
    return {
      kind: data.kind,
      enabled: data.selectionEnabled,
      points: data.periodogram?.power.length,
      sources: data.candidates?.peaks.map(
        (peak: { gridIndex: number }) => peak.gridIndex,
      ),
      calls,
    };
  }, tics.normal);
  expect(result.kind).toBe("ready");
  expect(result.enabled).toBe(true);
  expect(result.points).toBe(5000);
  expect(result.sources).toEqual([3600, 2500, 1600]);
  expect(result.calls).toHaveLength(4);
  expect(result.calls[2]).toContain("/periodogram?");
  expect(result.calls[3]).toContain("/candidate-peaks?");
});

test("HTTP public fixtures have full grid identity and no undisclosed candidate catalog", async ({
  request,
}) => {
  const raw = await (
    await request.get(`/api/v1/stars/${tics.normal}/analysis-context`)
  ).json();
  const context = decodeAnalysisContext(raw, tics.normal);
  const pgResponse = await request.get(
    `/api${periodogramPath(context, "periodogram")}`,
  );
  expect(pgResponse.status()).toBe(200);
  expect(pgResponse.headers()["x-current-bundle"]).toBe(
    context.curveContext.bundleId,
  );
  const pg = decodePeriodogram(await pgResponse.json(), context);
  const peakResponse = await request.get(
    `/api${periodogramPath(context, "candidate-peaks")}`,
  );
  const body = await peakResponse.json();
  expect(Object.keys(body).sort()).toEqual([
    "curveContext",
    "matchedCandidates",
    "peakRuleVersion",
    "peaks",
  ]);
  for (const peak of body.peaks)
    expect(Object.keys(peak).sort()).toEqual([
      "fineTune",
      "gridIndex",
      "periodDays",
      "power",
      "rank",
      "suggestedDurationHours",
      "suggestedPhaseCenter",
    ]);
  expect(decodeCandidatePeaks(body, context, pg).peaks).toHaveLength(3);
  const curve = await (
    await request.get(
      `/api/v1/stars/${tics.normal}/curves?bundleId=${context.curveContext.bundleId}&curveStep=0`,
    )
  ).json();
  expect(decodeCurve(curve, context, 200).kind).toBe("ready");
});

test("HTTP contracts distinguish access denial, invalid queries, missing data and residual pending", async ({
  request,
}) => {
  for (const resource of ["periodogram", "candidate-peaks"]) {
    expect(
      (await request.get(`/api/v1/stars/259377018/${resource}`)).status(),
    ).toBe(403);
    expect(
      (await request.get(`/api/v1/stars/259377019/${resource}`)).status(),
    ).toBe(404);
    expect(
      (await request.get(`/api/v1/stars/not-registered/${resource}`)).status(),
    ).toBe(404);
    expect(
      (
        await request.get(
          `/api/v1/stars/${tics.normal}/${resource}?bundleId=old&curveStep=0`,
        )
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.get(
          `/api/v1/stars/${tics.normal}/${resource}?bundleId=9007199254741093&curveStep=2`,
        )
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.get(
          `/api/v1/stars/${tics.unavailable}/${resource}?bundleId=9007199254741093&curveStep=0`,
        )
      ).status(),
    ).toBe(503);
  }
  const pending = await request.get(
    `/api/v1/stars/${tics.pending}/periodogram?bundleId=9007199254741093&curveStep=1&removed=9007199254741094`,
  );
  expect(pending.status()).toBe(202);
  expect((await pending.json()).residual).toEqual({
    status: null,
    jobId: null,
  });
  expect(
    (await request.post(`/api/v1/stars/${tics.normal}/periodogram`)).status(),
  ).toBe(405);
});
