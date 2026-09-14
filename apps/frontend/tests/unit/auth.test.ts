import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callbackProblem,
  loginDestination,
  nicknameProblem,
  normalizedNickname,
  oauthDestination,
} from "../../src/auth/flow";

test("login returns only to a permitted app route, retaining its string context", () => {
  assert.equal(
    loginDestination(
      "?returnTo=%2Fanalysis%2F259377017%3FhistoryId%3D000123",
      "/me",
    ),
    "/analysis/259377017?historyId=000123",
  );
  assert.equal(loginDestination("?returnTo=https://evil.test", "/me"), "/sky");
  assert.equal(loginDestination("", "/community?q=abc"), "/community?q=abc");
  assert.equal(loginDestination("?returnTo=%2Flogin", null), "/sky");
});
test("OAuth accepts configured HTTPS or local HTTP endpoints only", () => {
  for (const url of [
    "",
    "javascript:alert(1)",
    "//evil.test",
    "https://user:pass@auth.test",
    "https://auth.test/#token",
    "http://auth.test",
    "/\\evil.test",
  ])
    assert.equal(oauthDestination(url, "https://app.test"), null, url);
  assert.equal(
    oauthDestination("/oauth2/authorization/google", "https://app.test"),
    "https://app.test/oauth2/authorization/google",
  );
  assert.equal(
    oauthDestination("http://127.0.0.1:58268/api/test", "https://app.test"),
    "http://127.0.0.1:58268/api/test",
  );
});
test("callback cancellation, failure and clean server landing differ; codes never grant access", () => {
  assert.equal(callbackProblem("?error=access_denied"), "cancelled");
  for (const query of [
    "?error=bad",
    "?code=abc",
    "?access_token=abc",
    "?id_token=abc",
  ])
    assert.equal(callbackProblem(query), "failed");
  assert.equal(callbackProblem(""), null);
});
test("nickname validation follows NFC, Unicode length, characters and minimum reserved names", () => {
  assert.equal(normalizedNickname("  하서진  "), "하서진");
  for (const name of ["하서진", "ab_12", "가".repeat(20), "  하서진  "])
    assert.equal(nicknameProblem(name), null);
  for (const name of [
    "가",
    "가".repeat(21),
    "하 서진",
    "별🌠",
    "ㄱㄴ",
    "Admin",
    "SYSTEM",
    "관리자",
    "운영자",
  ])
    assert.ok(nicknameProblem(name));
});
