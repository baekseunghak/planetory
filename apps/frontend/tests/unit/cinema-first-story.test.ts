import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  STORY_BUTTON_MS,
  STORY_FADE_MS,
  STORY_KEY,
  STORY_LEAD_MS,
  STORY_LINES,
  STORY_LINE_MS,
  STORY_SKIP,
  STORY_START,
  markStorySeen,
  resetStoryHere,
  storyChanges,
  storyFrame,
  storySeen,
  storyWanted,
} from "../../src/cinema/shell/first-story";
import {
  resetFirstVisitHere,
  takeFirstVisitFlight,
} from "../../src/cinema/shell/tutorial-guide";

// The first-login story: newcomers only, once per member on this browser.

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}
const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

const newcomer = { firstVisit: true, memberId: "u-209", onGalaxy: true };

test("the story copy is the product owner's, word for word", () => {
  assert.deepEqual(STORY_LINES, [
    "NASA의 TESS 망원경은 지금도 수십만 개 별의 밝기를 기록하고 있습니다.",
    "행성이 별 앞을 지나가면, 별빛이 아주 잠깐 어두워집니다.",
    "그 작은 흔들림을 찾아내는 것이 이곳에서 할 일입니다.",
    "먼저 튜토리얼 별 다섯 개로 시작해 볼까요?",
  ]);
  assert.equal(STORY_START, "시작하기");
  assert.equal(STORY_SKIP, "건너뛰기");
});

test("only a newcomer on the galaxy gets the story, and only until they start", () => {
  resetStoryHere();
  resetFirstVisitHere();
  const storage = memoryStorage();
  assert.equal(storyWanted(storage, newcomer), true);
  // Returning members (onboarding done) never see it.
  assert.equal(storyWanted(storage, { ...newcomer, firstVisit: false }), false);
  // Not on another screen, and not without a member.
  assert.equal(storyWanted(storage, { ...newcomer, onGalaxy: false }), false);
  assert.equal(storyWanted(storage, { ...newcomer, memberId: "" }), false);
  // 시작하기 (or 건너뛰기): never again for this member, reload included.
  markStorySeen(storage, "u-209");
  assert.equal(storyWanted(storage, newcomer), false);
  resetStoryHere();
  assert.equal(storySeen(storage, "u-209"), true);
  assert.equal(storyWanted(storage, newcomer), false);
  // Another member on this browser still gets theirs; both are kept.
  assert.equal(storyWanted(storage, { ...newcomer, memberId: "u-300" }), true);
  markStorySeen(storage, "u-300");
  assert.deepEqual(JSON.parse(storage.data.get(STORY_KEY)!), [
    "u-209",
    "u-300",
  ]);
  markStorySeen(storage, "u-300");
  assert.deepEqual(JSON.parse(storage.data.get(STORY_KEY)!), [
    "u-209",
    "u-300",
  ]);
  resetStoryHere();
});

test("someone who already flew to tutorial 1 here is not a newcomer to the story", () => {
  resetStoryHere();
  resetFirstVisitHere();
  const storage = memoryStorage();
  assert.equal(takeFirstVisitFlight(storage, "u-209"), true);
  assert.equal(storyWanted(storage, newcomer), false);
  resetFirstVisitHere();
});

test("a blocked or broken store still shows the story only once in the page", () => {
  resetStoryHere();
  resetFirstVisitHere();
  assert.equal(storyWanted(throwing, newcomer), true);
  assert.doesNotThrow(() => markStorySeen(throwing, "u-209"));
  assert.equal(storyWanted(throwing, newcomer), false);
  assert.equal(storyWanted(null, newcomer), false);
  resetStoryHere();
  const storage = memoryStorage();
  storage.data.set(STORY_KEY, '{"u-209":true}');
  assert.equal(storySeen(storage, "u-209"), false);
  markStorySeen(storage, "u-209");
  assert.deepEqual(JSON.parse(storage.data.get(STORY_KEY)!), ["u-209"]);
  markStorySeen(storage, "");
  assert.deepEqual(JSON.parse(storage.data.get(STORY_KEY)!), ["u-209"]);
  resetStoryHere();
});

test("lines take ~2.5 s turns with a fade, the last stays and the button follows", () => {
  assert.ok(STORY_LINE_MS >= 2200 && STORY_LINE_MS <= 2800);
  assert.deepEqual(storyFrame(0, false), {
    line: -1,
    shown: false,
    button: false,
  });
  for (let i = 0; i < STORY_LINES.length - 1; i++) {
    const start = STORY_LEAD_MS + i * STORY_LINE_MS;
    assert.deepEqual(storyFrame(start, false), {
      line: i,
      shown: true,
      button: false,
    });
    // Fading out at the end of its turn, before the next one comes in.
    assert.deepEqual(storyFrame(start + STORY_LINE_MS - STORY_FADE_MS, false), {
      line: i,
      shown: false,
      button: false,
    });
  }
  const last = STORY_LINES.length - 1;
  const lastStart = STORY_LEAD_MS + last * STORY_LINE_MS;
  assert.deepEqual(storyFrame(lastStart, false), {
    line: last,
    shown: true,
    button: false,
  });
  assert.deepEqual(storyFrame(lastStart + STORY_BUTTON_MS, false), {
    line: last,
    shown: true,
    button: true,
  });
  assert.deepEqual(storyFrame(60_000, false), {
    line: last,
    shown: true,
    button: true,
  });
  // The timers fire exactly where the frame changes, in order.
  const changes = storyChanges(false);
  assert.deepEqual(
    changes,
    [...changes].sort((a, b) => a - b),
  );
  assert.equal(changes.at(-1), lastStart + STORY_BUTTON_MS);
  let previous = storyFrame(0, false);
  for (const at of changes) {
    const next = storyFrame(at, false);
    assert.notDeepEqual(next, previous, `a change at ${at}`);
    assert.deepEqual(storyFrame(at - 1, false), previous, `none before ${at}`);
    previous = next;
  }
});

test("reduced motion shows every line and the button at once", () => {
  assert.deepEqual(storyFrame(0, true), {
    line: STORY_LINES.length - 1,
    shown: true,
    button: true,
  });
  assert.deepEqual(storyChanges(true), []);
});

test("the dev session switch forgets the story too, so a newcomer demo repeats", () => {
  const plugin = readFileSync(
    new URL("../../dev/cinema-fixture-plugin.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    plugin.includes(`localStorage.removeItem("${STORY_KEY}")`),
    "switchPage removes the story key",
  );
});
