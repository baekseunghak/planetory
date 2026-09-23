import test from "node:test";
import assert from "node:assert/strict";
import {
  readWithdrawalPolicy,
  readWithdrawalStatus,
} from "../../src/features/profile/withdrawal.ts";
test("withdrawal never invents missing retention or rejoining policy", () => {
  assert.deepEqual(
    readWithdrawalPolicy({
      available: false,
      reason: "아직 제공하지 않습니다",
    }),
    { available: false, reason: "아직 제공하지 않습니다" },
  );
  assert.throws(() =>
    readWithdrawalPolicy({
      available: true,
      version: "1",
      retention: [],
      rejoining: [],
      effects: ["종료"],
    }),
  );
});
test("withdrawal status requires the exact receipt and known final status", () => {
  assert.throws(() =>
    readWithdrawalStatus(
      { requestId: "other", status: "COMPLETED", message: "완료" },
      "mine",
    ),
  );
  assert.throws(() =>
    readWithdrawalStatus({
      requestId: "mine",
      status: "probably-done",
      message: "완료",
    }),
  );
});

test("withdrawal rejects status coercion and incomplete policy text", () => {
  for (const status of [
    ["COMPLETED"],
    { toString: () => "COMPLETED" },
    null,
    true,
    1,
  ]) {
    assert.throws(() =>
      readWithdrawalStatus(
        { requestId: "mine", status, message: "test", effectiveAt: null },
        "mine",
      ),
    );
  }
  assert.throws(() => readWithdrawalStatus({ requestId: "mine", status: "READY", message: "test" }));
  for (const status of [
    "READY",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
  ] as const) {
    assert.equal(
      readWithdrawalStatus(
        { requestId: "mine", status, message: "test", effectiveAt: null },
        "mine",
      ).status,
      status,
    );
  }
  const policy = {
    available: true,
    version: "test",
    effects: ["test"],
    retention: ["test"],
    rejoining: ["test"],
  };
  for (const field of ["effects", "retention", "rejoining"] as const) {
    for (const value of [[], [" "], [null], "not-an-array"]) {
      assert.throws(() => readWithdrawalPolicy({ ...policy, [field]: value }));
    }
  }
});
