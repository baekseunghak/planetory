import test from "node:test";
import assert from "node:assert/strict";
import { readNotificationPreferences } from "../../src/features/notifications/contracts.ts";
test("preferences never invent missing defaults or coerce non-boolean values", () => {
  assert.throws(() =>
    readNotificationPreferences({ preferences: { COMMENT: true } }),
  );
  const preferences = {
    ACHIEVEMENT: true,
    REOPEN: true,
    CHALLENGE: false,
    FOLLOW: false,
    COMMENT: true,
  };
  assert.deepEqual(readNotificationPreferences({ preferences }), preferences);
  assert.throws(() =>
    readNotificationPreferences({
      preferences: { ...preferences, FOLLOW: "false" },
    }),
  );
});
