import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatJoinedDate,
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
  joinedAt: "2026-09-14T15:30:00Z",
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
test("own joinedAt is required UTC, preserves Instant precision and displays the Korean calendar date", () => {
  for (const value of [own.joinedAt, "2026-09-14T15:30:00.123456789Z"]) {
    const result = readProfile({ ...own, joinedAt: value }, "u-1", true);
    assert.equal(result.joinedAt, value);
    assert.equal(formatJoinedDate(result.joinedAt!), "2026년 9월 15일");
  }
  assert.equal(formatJoinedDate("2026-09-14T14:59:59Z"), "2026년 9월 14일");
  for (const bad of [
    undefined,
    null,
    "",
    0,
    "2026-09-14",
    "2026-09-14T15:30:00",
    "2026-09-15T00:30:00+09:00",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-09-14T24:00:00Z",
  ]) {
    assert.throws(() => readProfile({ ...own, joinedAt: bad }, "u-1", true), {
      name: "ApiError",
      code: "INVALID_RESPONSE",
    });
    assert.equal(
      readProfile({ ...own, joinedAt: bad }, "u-1", false).joinedAt,
      undefined,
    );
  }
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
