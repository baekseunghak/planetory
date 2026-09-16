import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient } from "../../src/api/client.ts";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data.ts";
import { loadPeriodogram } from "../../src/features/analysis/load-periodogram.ts";
import { PeriodogramContextChanged } from "../../src/features/analysis/periodogram-data.ts";
import {
  periodContextFixture,
  periodCurveFixture,
  periodogramFixtureResponse,
  PERIODOGRAM_FIXTURE_TICS as tics,
} from "../../dev/periodogram-fixtures.ts";

function setup(
  tic: string = tics.normal,
  transform?: (reply: Response, path: string) => Response | Promise<Response>,
) {
  const expected = decodeAnalysisContext(periodContextFixture(tic), tic);
  const curve = decodeCurve(periodCurveFixture(tic), expected);
  const paths: string[] = [];
  const client = createApiClient({
    baseUrl: "",
    fetch: async (input) => {
      const path = String(input);
      paths.push(path);
      const value = periodogramFixtureResponse(new URL(path, "http://test"));
      assert.ok(value);
      const reply = Response.json(value.body, {
        status: value.status,
        headers: { "X-Current-Bundle": value.currentBundleId! },
      });
      return transform ? transform(reply, path) : reply;
    },
  });
  return {
    expected,
    curve,
    paths,
    request: client.request,
    signal: new AbortController().signal,
  };
}
test("selection becomes available only after both responses validate against the displayed curve", async () => {
  const env = setup();
  const result = await loadPeriodogram(
    env.request,
    env.expected,
    env.curve,
    env.signal,
  );
  assert.equal(result.kind, "ready");
  assert.equal(result.selectionEnabled, true);
  assert.equal(env.paths.length, 2);
  assert.ok(env.paths[0].includes("/periodogram?"));
  assert.ok(env.paths[1].includes("/candidate-peaks?"));
});
test("missing curve or rules locks selection without requesting or fabricating periodogram data", async () => {
  const env = setup();
  assert.deepEqual(
    await loadPeriodogram(
      env.request,
      env.expected,
      { kind: "not-ready", status: null, jobId: null },
      env.signal,
    ),
    { kind: "unavailable", selectionEnabled: false, reason: "curve-not-ready" },
  );
  assert.equal(
    (
      await loadPeriodogram(
        env.request,
        { ...env.expected, periodSelectionRules: undefined },
        env.curve,
        env.signal,
      )
    ).selectionEnabled,
    false,
  );
  if (env.curve.kind !== "ready") throw new Error("ready expected");
  assert.equal(
    (
      await loadPeriodogram(
        env.request,
        env.expected,
        { ...env.curve, segments: [] },
        env.signal,
      )
    ).selectionEnabled,
    false,
  );
  assert.equal(env.paths.length, 0);
});
test("pending periodogram stops before peak GET and empty peaks remain a distinct unavailable state", async () => {
  for (const tic of [tics.pending, tics.empty]) {
    const env = setup(tic),
      result = await loadPeriodogram(
        env.request,
        env.expected,
        env.curve,
        env.signal,
      );
    assert.equal(result.selectionEnabled, false);
    assert.equal(result.kind, "unavailable");
    if (result.kind !== "unavailable") throw new Error("unavailable expected");
    assert.equal(
      result.reason,
      tic === tics.pending ? "periodogram-not-ready" : "empty-peaks",
    );
    assert.equal(env.paths.length, tic === tics.pending ? 1 : 2);
    if (tic === tics.pending)
      assert.deepEqual(result.pending, { status: null, jobId: null });
  }
});
test("invalid grid stops before peaks; wrong peak context rejects instead of returning half-ready data", async () => {
  for (const tic of [tics.malformed, tics.mismatch]) {
    const env = setup(tic);
    await assert.rejects(
      loadPeriodogram(env.request, env.expected, env.curve, env.signal),
      tic === tics.mismatch ? PeriodogramContextChanged : /power.length/,
    );
    assert.equal(env.paths.length, tic === tics.malformed ? 1 : 2);
  }
});
test("header or 409 Bundle changes require context+curve reload and do not retry old-context peaks", async () => {
  for (const phase of ["periodogram", "candidate-peaks"]) {
    for (const failure of ["header", "409", "unreadable"]) {
      const env = setup(tics.normal, (reply, path) =>
        path.includes(`/${phase}?`)
          ? failure === "409"
            ? Response.json(
                { code: "BUNDLE_CHANGED", message: "changed" },
                { status: 409 },
              )
            : failure === "unreadable"
              ? new Response("not JSON", {
                  headers: { "X-Current-Bundle": "new" },
                })
              : new Response(reply.body, {
                  headers: { "X-Current-Bundle": "new" },
                })
          : reply,
      );
      await assert.rejects(
        loadPeriodogram(env.request, env.expected, env.curve, env.signal),
        PeriodogramContextChanged,
      );
      assert.equal(env.paths.length, phase === "periodogram" ? 1 : 2);
    }
  }
});
test("access/service errors retain their meaning even with a changed header; explicit retry can recover", async () => {
  for (const status of [403, 404, 409, 503]) {
    let failing = true;
    const env = setup(tics.normal, (reply) =>
      failing
        ? Response.json(
            { code: "EXAMPLE_FAILURE", message: "failed" },
            { status, headers: { "X-Current-Bundle": "other" } },
          )
        : reply,
    );
    await assert.rejects(
      loadPeriodogram(env.request, env.expected, env.curve, env.signal),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === status &&
        error.code === "EXAMPLE_FAILURE",
    );
    failing = false;
    assert.equal(
      (await loadPeriodogram(env.request, env.expected, env.curve, env.signal))
        .selectionEnabled,
      true,
    );
  }
});
test("abort before or during the second GET cannot return selectable data even if fetch ignores abort", async () => {
  const early = setup(),
    aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    loadPeriodogram(early.request, early.expected, early.curve, aborted.signal),
    /abort/i,
  );
  assert.equal(early.paths.length, 0);
  const controller = new AbortController();
  const late = setup(tics.normal, (reply, path) => {
    if (path.includes("candidate-peaks")) controller.abort();
    return reply;
  });
  await assert.rejects(
    loadPeriodogram(late.request, late.expected, late.curve, controller.signal),
    /abort/i,
  );
});
