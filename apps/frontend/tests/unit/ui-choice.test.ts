import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UI_STORAGE_KEY,
  chooseUi,
  uiParam,
  withoutUiParam,
} from "../../src/ui-choice";

// The production image sets no VITE_CINEMA: develop's app unless the visitor
// opted in with ?ui=cinema. VITE_CINEMA="true"/"false" forces a side.

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

test("default (no build flag, no parameter, nothing stored) is legacy", () => {
  for (const build of [undefined, "", "auto", "yes"]) {
    const storage = memory();
    assert.equal(chooseUi(build, "", storage), "legacy");
    assert.equal(chooseUi(build, "?star=900000003", storage), "legacy");
    assert.equal(storage.data.size, 0);
  }
});

test("?ui=cinema opens cinema and remembers it; later visits stay cinema", () => {
  const storage = memory();
  assert.equal(chooseUi(undefined, "?ui=cinema", storage), "cinema");
  assert.equal(storage.data.get(UI_STORAGE_KEY), "cinema");
  assert.equal(chooseUi(undefined, "", storage), "cinema");
  assert.equal(chooseUi(undefined, "?star=1", storage), "cinema");
});

test("?ui=legacy forgets the choice and opens legacy", () => {
  const storage = memory({ [UI_STORAGE_KEY]: "cinema", other: "kept" });
  assert.equal(chooseUi(undefined, "?ui=legacy", storage), "legacy");
  assert.equal(storage.data.has(UI_STORAGE_KEY), false);
  assert.equal(storage.data.get("other"), "kept");
  assert.equal(chooseUi(undefined, "", storage), "legacy");
});

test("only the exact stored value opts in; unknown ?ui= values change nothing", () => {
  assert.equal(
    chooseUi(undefined, "", memory({ [UI_STORAGE_KEY]: "legacy" })),
    "legacy",
  );
  assert.equal(
    chooseUi(undefined, "", memory({ [UI_STORAGE_KEY]: "true" })),
    "legacy",
  );
  const stored = memory({ [UI_STORAGE_KEY]: "cinema" });
  assert.equal(chooseUi(undefined, "?ui=new", stored), "cinema");
  const empty = memory();
  assert.equal(chooseUi(undefined, "?ui=new", empty), "legacy");
  assert.equal(empty.data.size, 0);
  assert.equal(uiParam("?ui=%20Cinema%20"), "cinema");
  assert.equal(uiParam("?UI=cinema"), null);
});

test("build-time VITE_CINEMA overrides the parameter and storage", () => {
  const storage = memory({ [UI_STORAGE_KEY]: "cinema" });
  assert.equal(chooseUi("false", "?ui=cinema", storage), "legacy");
  assert.equal(chooseUi("true", "?ui=legacy", memory()), "cinema");
  assert.equal(chooseUi("true", "", null), "cinema");
  // A forced build does not rewrite the visitor's remembered choice.
  assert.equal(storage.data.get(UI_STORAGE_KEY), "cinema");
});

test("storage that throws or is missing: parameter still works for this load, default legacy", () => {
  assert.equal(chooseUi(undefined, "?ui=cinema", throwing), "cinema");
  assert.equal(chooseUi(undefined, "?ui=legacy", throwing), "legacy");
  assert.equal(chooseUi(undefined, "", throwing), "legacy");
  assert.equal(chooseUi(undefined, "?ui=cinema", null), "cinema");
  assert.equal(chooseUi(undefined, "", null), "legacy");
});

test("withoutUiParam drops only ui= and keeps the rest byte for byte", () => {
  assert.equal(withoutUiParam("https://p.example/sky"), null);
  assert.equal(withoutUiParam("https://p.example/sky?star=1"), null);
  assert.equal(withoutUiParam("https://p.example/?ui=cinema"), "/");
  assert.equal(
    withoutUiParam("https://p.example/sky?ui=cinema&star=900000003#x"),
    "/sky?star=900000003#x",
  );
  assert.equal(
    withoutUiParam(
      "https://p.example/login?returnTo=%2Fsky%3Fstar%3D1&ui=legacy&q=a+b",
    ),
    "/login?returnTo=%2Fsky%3Fstar%3D1&q=a+b",
  );
  assert.equal(withoutUiParam("https://p.example/a?ui&b=1"), "/a?b=1");
  assert.equal(withoutUiParam("https://p.example/a?uix=1"), null);
  assert.equal(withoutUiParam("not a url"), null);
});
