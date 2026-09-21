import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackNotice } from "../../src/features/history/fallback-note.tsx";

// #190 대체 사유 배지. 같은 값이 모드마다 다른 뜻이다(탐사 API 8.3).

test("당시 배열이 없으면 그대로라고 말하지 않는다", () => {
  const withArray = fallbackNotice("RETIRED_CANDIDATE", "SUBMITTED", true);
  const without = fallbackNotice("RETIRED_CANDIDATE", "SUBMITTED", false);
  assert.match(withArray!, /아래 배열은 당시 그대로입니다/);
  assert.doesNotMatch(without!, /아래 배열/);
  // 앞문장은 8.3절이 정한 것이라 두 경우 모두 유지한다.
  for (const text of [withArray!, without!])
    assert.match(text, /당시 잔차 조합을 재현할 수 없습니다/);
});

test("SUBMITTED에서 원본으로 대체했다고 말하지 않는다", () => {
  const text = fallbackNotice("RETIRED_CANDIDATE", "SUBMITTED", true)!;
  assert.doesNotMatch(text, /대체했습니다|원본 곡선/);
});

test("8.3절이 뜻을 정하지 않은 사유는 SUBMITTED에서 말하지 않는다", () => {
  for (const reason of ["RESIDUAL_NOT_AVAILABLE", "WHAT_IS_THIS"])
    assert.equal(fallbackNotice(reason, "SUBMITTED", true), null);
});

test("모르는 사유에는 모른다고 말한다", () => {
  // 개인 조회에 오는 값은 RETIRED_CANDIDATE 하나뿐이지만, 사유가 늘었을 때
  // 화면이 아무 말도 하지 않는 쪽이 더 나쁘다.
  const text = fallbackNotice("SOMETHING_NEW", "CURRENT", true)!;
  assert.match(text, /확인할 수 없습니다/);
  assert.doesNotMatch(text, /은퇴|원본 곡선으로 대체/);
});

test("사유가 없으면 배지도 없다", () => {
  for (const mode of ["CURRENT", "SUBMITTED"] as const)
    assert.equal(fallbackNotice(null, mode, true), null);
});

test("열거값을 그대로 노출하지 않는다", () => {
  for (const mode of ["CURRENT", "SUBMITTED"] as const)
    assert.doesNotMatch(
      fallbackNotice("RETIRED_CANDIDATE", mode, true) ?? "",
      /[A-Z_]{6,}/,
    );
});
