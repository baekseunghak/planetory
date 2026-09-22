import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../../src/api/client";
import { loadAnalysis } from "../../src/features/analysis/load-analysis";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures";
import { checkedAnalysisReturn } from "../../src/features/analysis/analysis-return";

const tic = "259377017",
  id = "sub-9007199254740993";
function draft(context = analysisContextFixture(tic)) {
  return {
    sourceSubmissionId: id,
    retryOfSubmissionId: id,
    bundleId: context.bundle.bundleId,
    isPreviousBundle: true,
    curveContext: context.currentCurveContext,
    restored: { step: true, notice: null },
    draft: {
      periodDays: 4,
      phaseStart: 0.95,
      phaseEnd: 1.05,
      viewState: null,
      userJudgment: null,
      evidenceChecks: [],
      memo: null,
    },
    residualForStep: { status: "COMPLETED", jobId: null },
  };
}
test("retry loader verifies the owner/TIC and preserves server-rebased phases without a submit", async () => {
  const calls: string[] = [],
    context = analysisContextFixture(tic),
    source = draft(context);
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: () => ({ "X-Test-CSRF": "fixture" }),
    fetch: async (input, init) => {
      const path = String(input);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return Response.json(
        path.endsWith("analysis-context")
          ? context
          : path.endsWith("retry-draft")
            ? source
            : path.endsWith(id)
              ? { submissionId: id, ticId: tic }
              : analysisCurveFixture(tic),
      );
    },
  });
  const result = await loadAnalysis(
    client.request,
    tic,
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    { retryOfSubmissionId: id },
  );
  assert.deepEqual(result.retryDraft?.draft, source.draft);
  assert.equal(result.curve.kind, "ready");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((path) => path.startsWith("GET ")));
});
test("a retry/context Bundle race is bounded to two snapshots", async () => {
  let drafts = 0;
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: () => ({ "X-Test-CSRF": "fixture" }),
    fetch: async (input) => {
      const path = String(input);
      if (path.endsWith("analysis-context"))
        return Response.json(analysisContextFixture(tic));
      if (path.endsWith(id))
        return Response.json({ submissionId: id, ticId: tic });
      drafts++;
      const value = draft();
      value.bundleId = value.curveContext.bundleId = "another";
      return Response.json(value);
    },
  });
  await assert.rejects(
    loadAnalysis(
      client.request,
      tic,
      new AbortController().signal,
      () => {},
      undefined,
      undefined,
      { retryOfSubmissionId: id },
    ),
    /계속 바뀌어/,
  );
  assert.equal(drafts, 2);
});
for (const status of [403, 404, 409, 503])
  test(`retry ${status} remains a read failure and never becomes a submission`, async () => {
    let calls = 0;
    const client = createApiClient({
      baseUrl: "/api",
      csrfHeaders: () => ({ "X-Test-CSRF": "fixture" }),
      fetch: async (input) => {
        calls++;
        return String(input).endsWith("analysis-context")
          ? Response.json(analysisContextFixture(tic))
          : Response.json(
              { code: "UNAVAILABLE", message: "접근할 수 없습니다." },
              { status },
            );
      },
    });
    await assert.rejects(
      loadAnalysis(
        client.request,
        tic,
        new AbortController().signal,
        () => {},
        undefined,
        undefined,
        { retryOfSubmissionId: id },
      ),
      /접근/,
    );
    assert.equal(calls, 2);
  });
test("post return validates current TIC and preserves safe query context", async () => {
  const paths: string[] = [];
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: () => ({ "X-Test-CSRF": "fixture" }),
    fetch: async (input) => {
      paths.push(String(input));
      return Response.json({ postId: "p-1", ticId: tic });
    },
  });
  const signal = new AbortController().signal;
  assert.equal(
    await checkedAnalysisReturn(
      client.request,
      tic,
      "/posts/p-1?returnTo=%2Fsky",
      signal,
    ),
    "/posts/p-1?returnTo=%2Fsky",
  );
  await assert.rejects(
    checkedAnalysisReturn(client.request, "other", "/posts/p-1", signal),
    /항성/,
  );
  assert.equal(
    await checkedAnalysisReturn(
      client.request,
      tic,
      "https://example.org",
      signal,
    ),
    "/sky",
  );
  assert.equal(paths.length, 2);
});

test("missing retry residual uses the restored target and refetches only that curve", async () => {
  const context = analysisContextFixture(tic);
  const target = {
    ...context.currentCurveContext,
    curveStep: 1,
    removedCandidateIds: ["9007199254740994"],
  };
  const value = {
    ...draft(context),
    curveContext: target,
    residualForStep: { status: null, jobId: null },
  };
  let curveReads = 0,
    posts = 0;
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: () => ({ "X-Test-CSRF": "fixture" }),
    fetch: async (input, init) => {
      const path = String(input);
      if (path.endsWith("analysis-context")) return Response.json(context);
      if (path.endsWith(id))
        return Response.json({ submissionId: id, ticId: tic });
      if (path.endsWith("retry-draft")) return Response.json(value);
      if (path.endsWith("residual-jobs")) {
        posts++;
        assert.deepEqual(
          JSON.parse(String(init?.body)).target.removedCandidateIds,
          target.removedCandidateIds,
        );
        return Response.json({ resultCurveContext: target });
      }
      assert.ok(path.includes("removed=9007199254740994"));
      const curve = { ...analysisCurveFixture(tic), curveContext: target };
      return ++curveReads === 1
        ? Response.json(
            {
              ...curve,
              segments: null,
              residual: { status: null, jobId: null },
            },
            { status: 202 },
          )
        : Response.json(curve);
    },
  });
  const result = await loadAnalysis(
    client.request,
    tic,
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    { retryOfSubmissionId: id },
  );
  assert.equal(result.curve.kind, "ready");
  assert.equal(curveReads, 2);
  assert.equal(posts, 1);
  assert.deepEqual(result.context.curveContext, target);
});
