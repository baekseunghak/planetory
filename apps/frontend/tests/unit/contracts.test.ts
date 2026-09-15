import assert from "node:assert/strict";
import { test } from "node:test";
import { pagePath, safeReturnTo } from "../../src/app/paths";
import { readMember } from "../../src/auth/member";

const member = {
  memberId: "90071992547409931234",
  nickname: "별찾기",
  onboardingDone: true,
  tutorialCompleted: false,
};
test("flat /me keeps string IDs and independent onboarding/tutorial states", () => {
  assert.deepEqual(readMember(member), member);
  for (const value of [
    { member },
    { ...member, memberId: 123 },
    { ...member, onboardingDone: undefined },
    { ...member, tutorialCompleted: undefined },
    null,
  ])
    assert.throws(() => readMember(value));
});
test("TIC, History and original post/filter return context survive URL encoding", () => {
  const origin = "/community?q=밝기&board=STAR";
  const analysis = pagePath(
    "analysis",
    { ticId: "000259377017" },
    { returnTo: origin, historyId: "h-123", postId: "p-987" },
  );
  const url = new URL(analysis, "https://planetory.invalid");
  assert.equal(url.pathname, "/analysis/000259377017");
  assert.equal(
    new URL(
      url.searchParams.get("returnTo")!,
      "https://planetory.invalid",
    ).searchParams.get("q"),
    "밝기",
  );
  assert.equal(
    new URL(
      url.searchParams.get("returnTo")!,
      "https://planetory.invalid",
    ).searchParams.get("board"),
    "STAR",
  );
  assert.equal(url.searchParams.get("historyId"), "h-123");
  assert.equal(url.searchParams.get("postId"), "p-987");
  assert.throws(() => pagePath("analysis", { ticId: 123 } as never));
  assert.throws(() => pagePath("historyDetail"));
});
test("return destinations stay within app routes, including normalized path traversal", () => {
  for (const value of [
    "https://outside.test",
    "//outside.test",
    "/\\outside.test",
    "/login",
    "/oauth/callback",
    "/sky/../../login",
    "/sky\n",
    "javascript:alert(1)",
    null,
  ])
    assert.equal(safeReturnTo(value), "/sky");
  assert.equal(
    safeReturnTo("/history/h-3?ticId=123"),
    "/history/h-3?ticId=123",
  );
});
