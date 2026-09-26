import test from "node:test";
import assert from "node:assert/strict";
import {
  DetailVersionChanged,
  readPlanetExplanations,
  type StarDetail,
} from "../../src/features/sky-renderer/detail.ts";

test("NASA response joins only the current TIC, version and owned candidate, with a fixed source link", () => {
  const detail = {
    system: {
      ticId: "123",
      version: "v1",
      items: [{ candidateId: "c-1", kind: "confirmed" }],
    },
  } as unknown as StarDetail;
  const value = {
    ticId: "123",
    version: "v1",
    items: [
      {
        candidateId: "c-1",
        kind: "confirmed",
        status: "ready",
        content: {
          name: "이름",
          orbitalPeriod: "주기",
          radius: "반지름",
          mass: "질량",
          discovery: "발견",
        },
        facts: {
          planetName: "TOI-700 b",
          orbitalPeriod: { value: "9.977219", limit: 0, unit: "days" },
          radius: null,
          mass: null,
          discoveryMethod: null,
          discoveryYear: null,
          controversial: null,
          sourceTable: "ps",
          sourceUrl: "https://exoplanetarchive.ipac.caltech.edu/",
        },
        sourceStatus: "ready",
        fetchedAt: "2026-09-25T05:20:00Z",
        refreshStatus: "ok",
        generatedAt: "2026-09-25T05:21:00Z",
        retryAt: null,
        failure: null,
      },
    ],
  };
  assert.equal(
    readPlanetExplanations(value, detail)[0].facts?.orbitalPeriod?.value,
    "9.977219",
  );
  assert.throws(
    () => readPlanetExplanations({ ...value, version: "v2" }, detail),
    DetailVersionChanged,
  );
  assert.throws(() =>
    readPlanetExplanations(
      { ...value, items: [{ ...value.items[0], candidateId: "c-2" }] },
      detail,
    ),
  );
  assert.throws(() =>
    readPlanetExplanations(
      {
        ...value,
        items: [
          {
            ...value.items[0],
            facts: {
              ...value.items[0].facts,
              sourceUrl: "https://other.example/",
            },
          },
        ],
      },
      detail,
    ),
  );
});
