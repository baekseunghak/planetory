import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  materialError,
  changedMaterials,
  sameMaterials,
  readSource,
  readMaterials,
} from "../../src/features/community/materialContracts";
import {
  changedPostFields,
  toDraft,
  patchIsVisible,
} from "../../src/features/community/postContracts";
import {
  readHistoryGraph,
  isGraphPending,
  SharedHistoryGraph,
  HistoryGraphRenderer,
  type HistoryGraphDto,
} from "../../src/features/history/HistoryGraph";
const graph = () => ({
  historyId: "h-1",
  reproduction: {
    submittedBundleId: "b-1",
    currentBundleId: "b-2",
    residualReproducible: true,
    fallbackReason: null,
  },
  selection: {
    userPeriodDays: 3,
    correctedPeriodDays: 3,
    harmonicMultiplier: 1,
    epochBtjd: 100,
    durationHours: 1,
  },
  curve: {
    ticId: "123",
    bundleId: "b-2",
    curveContext: { bundleId: "b-2", curveStep: 0 },
    segments: null,
    residual: { status: null, jobId: null },
  },
  snapshot: null,
});
test("materials enforce independent maximum three, duplicate identities and selected TIC", () => {
  assert.equal(
    materialError(
      {
        historyIds: ["a", "b", "c"],
        sourceLinks: [
          { type: "PUBLIC_ANALYSIS", id: "a" },
          { type: "SIGNAL_THREAD", id: "a" },
        ],
      },
      "123",
    ),
    "",
  );
  for (const values of [
    { historyIds: ["a", "a"] },
    { historyIds: ["a", "b", "c", "d"] },
    {
      sourceLinks: Array(4).fill({ type: "PUBLIC_ANALYSIS" as const, id: "a" }),
    },
  ])
    assert.notEqual(materialError(values, "123"), "");
  assert.notEqual(materialError({ historyIds: ["a"] }, null), "");
  assert.deepEqual(
    readMaterials({
      attachments: [],
      sourceLinks: [{ type: "PUBLIC_ANALYSIS", available: false }],
    }),
    {
      historyIds: [],
      sourceLinks: [],
      unavailableSources: ["PUBLIC_ANALYSIS"],
    },
  );
});
test("source permission, identity and TIC checked before attaching", () => {
  const expected = { type: "PUBLIC_ANALYSIS" as const, id: "p1" };
  for (const raw of [
    { ...expected, available: false },
    { ...expected, available: true, ticId: "456" },
    { type: "SIGNAL_THREAD", id: "p1", available: true, ticId: "123" },
  ])
    assert.throws(() => readSource(raw, expected, "123"));
});
test("changing TIC can atomically detach materials and uncertain PATCH compares arrays", () => {
  const original = {
    title: "old",
    body: "body",
    purposeTag: "GENERAL",
    ticId: "123",
    historyIds: ["h1"],
    sourceLinks: [],
  };
  const patch = changedPostFields(original, {
    ...toDraft(original),
    board: "FREE",
    historyIds: [],
    sourceLinks: [],
  });
  assert.deepEqual(patch, { ticId: null, historyIds: [] });
  assert.equal(patchIsVisible({ ...original, ...patch }, patch), true);
});
test("graph keeps exploration envelope; modes, bundle identity and snapshot sizes cannot be mixed", () => {
  const g = graph();
  assert.equal(readHistoryGraph(g, "h-1", "123", "CURRENT"), g);
  assert.equal(isGraphPending(g as HistoryGraphDto), false);
  assert.throws(() => readHistoryGraph(g, "h-2", "123", "CURRENT"));
  assert.throws(() => readHistoryGraph(g, "h-1", "123", "SUBMITTED"));
  g.curve.bundleId = "old";
  assert.throws(() => readHistoryGraph(g, "h-1", "123", "CURRENT"));
  const submitted = {
    ...graph(),
    curve: null,
    snapshot: { bins: 150, foldedFlux: [1], foldedError: [0.1] },
  };
  assert.throws(() => readHistoryGraph(submitted, "h-1", "123", "SUBMITTED"));
});
test("null and failed residuals do not poll, only existing in-progress job does", () => {
  const g = graph();
  for (const status of [null, "FAILED", "COMPLETED"]) {
    g.curve.residual = {
      status: status as null,
      jobId: status ? "job" : (null as any),
    };
    assert.equal(isGraphPending(g as HistoryGraphDto), false);
  }
  g.curve.residual = { status: "QUEUED" as any, jobId: "job" as any };
  assert.equal(isGraphPending(g as HistoryGraphDto), true);
});
test("A08 renderer receives exact unchanged DTO, mode and readonly boundary", () => {
  const g = graph() as HistoryGraphDto;
  let called = false;
  const Renderer = (props: any) => {
    assert.equal(props.graph, g);
    assert.equal(props.readOnly, true);
    assert.equal(props.mode, "CURRENT");
    assert.equal("requestResidual" in props, false);
    called = true;
    return createElement("p", null, "shared renderer");
  };
  assert.match(
    renderToStaticMarkup(
      createElement(
        HistoryGraphRenderer.Provider,
        { value: Renderer },
        createElement(SharedHistoryGraph, {
          graph: g,
          mode: "CURRENT",
          readOnly: true,
        }),
      ),
    ),
    /shared renderer/,
  );
  assert.equal(called, true);
});

test("reordered attachments reconcile an uncertain write without hiding changed or duplicate IDs", () => {
  const original = {
    title: "a",
    body: "body",
    purposeTag: "DISCUSSION",
    ticId: "123",
    historyIds: ["h1", "h2"],
    sourceLinks: [
      { type: "PUBLIC_ANALYSIS" as const, id: "x" },
      { type: "SIGNAL_THREAD" as const, id: "y" },
    ],
  };
  const reordered = {
    ...original,
    historyIds: ["h2", "h1"],
    sourceLinks: [...original.sourceLinks].reverse(),
  };
  assert.equal(sameMaterials(original, reordered), true);
  assert.equal(
    patchIsVisible(reordered, {
      historyIds: original.historyIds,
      sourceLinks: original.sourceLinks,
    }),
    true,
  );
  assert.deepEqual(changedPostFields(original, toDraft(reordered)), {});
  assert.equal(patchIsVisible(reordered, { historyIds: ["h1", "h3"] }), false);
  assert.equal(patchIsVisible(reordered, { historyIds: ["h1", "h1"] }), false);
  assert.equal(
    patchIsVisible(reordered, {
      sourceLinks: [
        { type: "SIGNAL_THREAD", id: "x" },
        { type: "SIGNAL_THREAD", id: "y" },
      ],
    }),
    false,
  );
  assert.equal(patchIsVisible(reordered, { title: "changed" }), false);
  assert.equal(patchIsVisible(reordered, { historyIds: [] }), false);
  assert.equal(
    patchIsVisible({ ...reordered, historyIds: [] }, { historyIds: [] }),
    true,
  );
  assert.deepEqual(original.historyIds, ["h1", "h2"]);
});

test("unavailable sources preserve only type and never enter editable selections", () => {
  const materials = readMaterials({
    sourceLinks: [
      {
        type: "PUBLIC_ANALYSIS",
        available: false,
        id: "secret",
        author: "hidden",
      },
    ],
  });
  assert.deepEqual(materials, {
    historyIds: [],
    sourceLinks: [],
    unavailableSources: ["PUBLIC_ANALYSIS"],
  });
  const original = {
    ...materials,
    title: "title",
    body: "before",
    purposeTag: "GENERAL",
    ticId: "123",
  };
  assert.deepEqual(
    changedPostFields(original, { ...toDraft(original), body: "after" }),
    { body: "after" },
  );
  assert.deepEqual(
    changedMaterials(materials, { ...materials, historyIds: ["h-1"] }),
    { historyIds: ["h-1"] },
  );
  assert.deepEqual(
    changedMaterials(materials, {
      ...materials,
      unavailableSources: [],
      sourceLinks: [],
    }),
    { sourceLinks: [] },
  );
  assert.throws(() => readMaterials({ sourceLinks: [{ available: false }] }));
});

test("uncertain removal must verify both visible and unavailable sources", () => {
  const fields = {
    title: "title",
    body: "after",
    purposeTag: "GENERAL",
    ticId: "123",
  };
  const retained = {
    ...fields,
    ...readMaterials({
      sourceLinks: [{ type: "PUBLIC_ANALYSIS", available: false }],
    }),
  };
  assert.equal(patchIsVisible(retained, { sourceLinks: [] }), false);
  assert.equal(
    patchIsVisible(
      { ...fields, ...readMaterials({ sourceLinks: [] }) },
      { sourceLinks: [] },
    ),
    true,
  );
  assert.equal(patchIsVisible(retained, { body: "after" }), true);
});
