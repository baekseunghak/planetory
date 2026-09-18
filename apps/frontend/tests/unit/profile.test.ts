import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  readProfile,
  readNickname,
} from "../../src/features/profile/contracts.ts";
import {
  ProfileSection,
  ProfileSlots,
} from "../../src/features/profile/ProfileSlots.tsx";
const own = {
  memberId: "u-1",
  nickname: "가나",
  starListVisibility: "PRIVATE",
  joinedAt: "DO_NOT_LEAK",
  email: "PRIVATE",
  achievementSummary: {
    discoveredStarCount: 17,
    completedStarCount: 2,
    signalCount: 3,
    byType: { confirmed: 1, unconfirmed: 1, fp: 1 },
    starCountByGrade: { A: 1, S: 1, SS: 0, SSS: 0 },
  },
};
test("profile public projection drops private counts and extra fields", () => {
  const publicValue = readProfile(own, "u-1", false);
  assert.deepEqual(Object.keys(publicValue).sort(), [
    "achievementSummary",
    "memberId",
    "nickname",
    "starListVisibility",
  ]);
  assert.equal(publicValue.achievementSummary.discoveredStarCount, undefined);
  assert.equal(publicValue.achievementSummary.byType, undefined);
  assert.equal(
    readProfile(own, "u-1", true).achievementSummary.discoveredStarCount,
    17,
  );
});
test("profile rejects identity mismatch, absent/negative counts instead of inventing zeros", () => {
  assert.throws(() => readProfile(own, "u-2", true));
  for (const bad of [undefined, -1, NaN, 1.5, "3"])
    assert.throws(() =>
      readProfile(
        {
          ...own,
          achievementSummary: { ...own.achievementSummary, signalCount: bad },
        },
        "u-1",
        true,
      ),
    );
  assert.throws(() =>
    readNickname({ memberId: "u-2", nickname: "가나" }, "u-1"),
  );
});
test("profile slots supply identity and block private or other-member history rendering", () => {
  const draw = (section: "stars" | "history", isOwn: boolean) =>
    renderToStaticMarkup(
      createElement(
        ProfileSlots.Provider,
        {
          value: {
            stars: (p) => createElement("p", null, JSON.stringify(p)),
            history: () => createElement("p", null, "SECRET"),
          },
        },
        createElement(ProfileSection, {
          section,
          memberId: "u-1",
          isOwn,
          starListVisibility: "PRIVATE",
        }),
      ),
    );
  assert.match(draw("stars", false), /비공개/);
  assert.doesNotMatch(draw("stars", false), /u-1/);
  assert.equal(draw("history", false), "");
  assert.match(draw("history", true), /SECRET/);
  assert.match(draw("stars", true), /u-1/);
});
