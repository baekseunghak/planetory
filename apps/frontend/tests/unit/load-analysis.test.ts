import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient } from "../../src/api/client";
import { loadAnalysis } from "../../src/features/analysis/load-analysis";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures";

const oldId = "9007199254740993",
  newId = "9007199254740997",
  tic = "259377017";
function snapshot(bundleId: string, residual = false) {
  const context = analysisContextFixture(tic);
  context.bundle.bundleId = bundleId;
  context.bundle.bundleVersion = bundleId === oldId ? "v7" : "v8";
  context.currentCurveContext.bundleId = bundleId;
  if (residual) {
    context.currentCurveContext.curveStep = 1;
    context.currentCurveContext.removedCandidateIds = ["9007199254740994"];
  }
  const curve = analysisCurveFixture(tic);
  curve.bundleId = bundleId;
  curve.curveContext = context.currentCurveContext;
  return { context, curve };
}
const json = (body: unknown, bundleId?: string, status = 200) =>
  Response.json(body, {
    status,
    headers: bundleId ? { "X-Current-Bundle": bundleId } : {},
  });

for (const failure of ["header", "409", "unreadable"] as const)
  test(`recovers a ${failure} Bundle race once and preserves server residual context`, async () => {
    const before = snapshot(oldId, true),
      after = snapshot(newId, true);
    let latest = false,
      notices = 0;
    const paths: string[] = [];
    const client = createApiClient({
      baseUrl: "/api",
      fetch: async (input) => {
        const path = String(input);
        paths.push(path);
        if (path.endsWith("analysis-context"))
          return json((latest ? after : before).context);
        if (!latest) {
          latest = true;
          return failure === "409"
            ? json(
                { code: "BUNDLE_CHANGED", currentBundleId: newId },
                undefined,
                409,
              )
            : failure === "unreadable"
              ? new Response("invalid JSON", {
                  headers: { "X-Current-Bundle": newId },
                })
              : json(before.curve, newId);
        }
        return json(after.curve, newId);
      },
    });
    const result = await loadAnalysis(
      client.request,
      tic,
      new AbortController().signal,
      () => notices++,
    );
    assert.equal(result.context.curveContext.bundleId, newId);
    assert.equal(result.curve.kind, "ready");
    assert.equal(result.bundleChanged, true);
    assert.equal(notices, 1);
    assert.equal(paths.length, 4);
    const query = new URL(paths[3], "http://test").searchParams;
    assert.equal(query.get("curveStep"), "1");
    assert.equal(query.get("removed"), "9007199254740994");
  });

test("a repeated race stops after two pairs; no unbounded retry", async () => {
  let calls = 0;
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (input) => {
      calls++;
      return String(input).endsWith("analysis-context")
        ? json(snapshot(oldId).context)
        : json({}, newId);
    },
  });
  await assert.rejects(
    loadAnalysis(client.request, tic, new AbortController().signal, () => {}),
    /계속 바뀌어/,
  );
  assert.equal(calls, 4);
});

test("a context/header mismatch reloads before issuing any old curve request", async () => {
  const paths: string[] = [];
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (input) => {
      paths.push(String(input));
      if (paths.length === 1) return json(snapshot(oldId).context, newId);
      return json(
        paths.length === 2 ? snapshot(newId).context : snapshot(newId).curve,
        newId,
      );
    },
  });
  const result = await loadAnalysis(
    client.request,
    tic,
    new AbortController().signal,
    () => {},
  );
  assert.equal(result.context.bundleVersion, "v8");
  assert.equal(paths.length, 3);
  assert.ok(paths[1].endsWith("analysis-context"));
});

test("403/404/503 and unrelated 409 retain their error even with a different header", async () => {
  for (const status of [403, 404, 503, 409]) {
    let calls = 0;
    const client = createApiClient({
      baseUrl: "/api",
      fetch: async () => {
        calls++;
        return calls === 1
          ? json(snapshot(oldId).context)
          : json({ code: "OTHER_ERROR" }, newId, status);
      },
    });
    await assert.rejects(
      loadAnalysis(client.request, tic, new AbortController().signal, () => {}),
      (error) =>
        error instanceof ApiError &&
        error.status === status &&
        error.code === "OTHER_ERROR",
    );
    assert.equal(calls, 2);
  }
});

test("late response after cancellation cannot decode or launch another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async () => {
      calls++;
      controller.abort();
      return json(snapshot(oldId).context, newId);
    },
  });
  await assert.rejects(
    loadAnalysis(client.request, tic, controller.signal, () => assert.fail()),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("headerless valid reads work; a manual refresh notices changed Bundle and restoration notice", async () => {
  const next = snapshot(newId, true);
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (input) =>
      json(
        String(input).endsWith("analysis-context")
          ? {
              ...next.context,
              // 서버는 notice를 currentCurveContext 안에 둔다 (탐사 API 5.1).
              currentCurveContext: {
                ...next.context.currentCurveContext,
                notice: "STEP_NOT_RESTORABLE",
              },
            }
          : next.curve,
      ),
  });
  const result = await loadAnalysis(
    client.request,
    tic,
    new AbortController().signal,
    () => {},
    oldId,
  );
  assert.equal(result.bundleChanged, true);
  assert.equal(result.context.notice, "STEP_NOT_RESTORABLE");
  assert.equal(result.context.curveContext.curveStep, 1);
});
