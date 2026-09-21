import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackMessage } from "../../src/features/history/public-graph-text.ts";
import type { HistoryGraphDto } from "../../src/features/history/HistoryGraph.tsx";

// #191 공개 소비 경계의 대체 사유 문구. 소비자가 둘(첨부·공개 분석)이라
// 한곳에서 나와야 한다. 같은 값이 모드마다 다른 뜻이다(탐사 API 8.3).

const graph = (reason: string | null, hasSnapshot: boolean) =>
  ({
    reproduction: { fallbackReason: reason },
    snapshot: hasSnapshot ? { bins: 150 } : null,
  }) as unknown as HistoryGraphDto;

test("SUBMITTED는 원본으로 대체했다고 말하지 않는다", () => {
  const text = fallbackMessage(graph("RETIRED_CANDIDATE", true), "SUBMITTED")!;
  assert.match(text, /당시 잔차 조합을 재현할 수 없습니다/);
  assert.doesNotMatch(text, /대체했습니다|원본 곡선/);
});

test("당시 배열이 없으면 그대로라고 말하지 않는다", () => {
  const without = fallbackMessage(
    graph("RETIRED_CANDIDATE", false),
    "SUBMITTED",
  )!;
  assert.doesNotMatch(without, /아래 배열/);
  assert.match(without, /당시 잔차 조합을 재현할 수 없습니다/);
});

test("8.3절이 뜻을 정하지 않은 사유는 SUBMITTED에서 말하지 않는다", () => {
  for (const reason of ["RESIDUAL_NOT_AVAILABLE", "WHAT_IS_THIS"])
    assert.equal(fallbackMessage(graph(reason, true), "SUBMITTED"), null);
});

test("CURRENT의 두 사유는 서로 다른 문구다", () => {
  const retired = fallbackMessage(graph("RETIRED_CANDIDATE", true), "CURRENT")!;
  const missing = fallbackMessage(
    graph("RESIDUAL_NOT_AVAILABLE", true),
    "CURRENT",
  )!;
  assert.match(retired, /은퇴한 후보/);
  assert.match(missing, /사용할 수 있는 잔차 자료가 없어/);
  assert.notEqual(retired, missing);
});

test("모르는 사유에는 모른다고 말한다", () => {
  const unknown = fallbackMessage(
    graph("SOMETHING_NEW", "CURRENT" as never),
    "CURRENT",
  )!;
  assert.match(unknown, /확인할 수 없습니다/);
  assert.doesNotMatch(unknown, /은퇴|잔차 자료가 없어/);
});

test("사유가 없으면 배지도 없다", () => {
  for (const mode of ["CURRENT", "SUBMITTED"] as const)
    assert.equal(fallbackMessage(graph(null, true), mode), null);
});

test("열거값을 그대로 노출하지 않는다", () => {
  for (const mode of ["CURRENT", "SUBMITTED"] as const)
    for (const reason of ["RETIRED_CANDIDATE", "RESIDUAL_NOT_AVAILABLE"])
      assert.doesNotMatch(
        fallbackMessage(graph(reason, true), mode) ?? "",
        /[A-Z_]{6,}/,
      );
});
