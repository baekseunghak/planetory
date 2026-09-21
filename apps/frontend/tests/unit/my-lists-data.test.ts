import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readMyStars,
  readMyHistories,
  myHistoriesPath,
  starsPath,
} from "../../src/features/my-lists/my-lists-data.ts";

// #196. 명세 4.4·8.1과 실제 백엔드 구현을 함께 본다.

const star = {
  ticId: "123456789",
  progressStage: "in_progress",
  planetCount: 2,
  completedWithoutPlanets: false,
  achievementCount: 2,
  grade: "S",
  currentCurveStep: 1,
  reopenPending: false,
  reopened: false,
  unpublishedSignalCount: 1,
  lastActivityAt: "2026-09-10T02:30:00Z",
  unlockReason: "achievement",
  marker: null,
};

const history = {
  historyId: "h-501",
  submissionId: "sub-7001",
  ticId: "123456789",
  candidateId: "c-402",
  submissionKind: "candidate",
  matchResult: "matched_harmonic",
  userJudgment: "LIKELY_PLANET",
  achievementResult: "pending_publish",
  submittedAt: "2026-09-10T02:30:00Z",
  bundleId: "b-2",
  isPreviousBundle: false,
  curveStep: 1,
  publication: {
    publicAnalysisId: null,
    isPublic: false,
    isModerationHidden: false,
  },
  achievementGranted: false,
  snapshotAvailable: true,
  detailAvailable: true,
  answerViewed: false,
  relabel: null,
  retryOfSubmissionId: null,
};

test("공개하지 않은 신호 수는 없음과 0이 다르다", () => {
  // 본인 조회: 0도 사실이다.
  const own = readMyStars({ items: [{ ...star, unpublishedSignalCount: 0 }] });
  assert.equal(own.items[0].unpublishedSignalCount, 0);

  // 타인 조회: 서버가 필드를 통째로 뺀다(@JsonInclude(NON_NULL)).
  const { unpublishedSignalCount, ...withoutField } = star;
  void unpublishedSignalCount;
  const other = readMyStars({ items: [withoutField] });
  assert.equal(other.items[0].unpublishedSignalCount, null);

  // 서버는 키를 빼지만 개발용 응답·프록시가 null을 실을 수 있다. 그것 때문에
  // 목록 전체를 잃지 않는다.
  const asNull = readMyStars({
    items: [{ ...star, unpublishedSignalCount: null }],
  });
  assert.equal(asNull.items[0].unpublishedSignalCount, null);
});

test("없을 수 있는 값을 지어내지 않는다", () => {
  const page = readMyStars({
    items: [
      { ...star, grade: null, currentCurveStep: null, unlockReason: null },
    ],
  });
  assert.equal(page.items[0].grade, null);
  assert.equal(page.items[0].currentCurveStep, null);
  assert.equal(page.items[0].unlockReason, null);
  // 0으로 바뀌지 않았는지 함께 본다.
  assert.notEqual(page.items[0].currentCurveStep, 0);
});

test("커서가 없으면 끝이다", () => {
  assert.equal(readMyStars({ items: [star] }).nextCursor, null);
  assert.equal(readMyStars({ items: [], nextCursor: null }).nextCursor, null);
  assert.equal(readMyStars({ items: [], nextCursor: "abc" }).nextCursor, "abc");
});

test("기록 목록의 없을 수 있는 값을 읽는다", () => {
  const page = readMyHistories({
    items: [
      { ...history, candidateId: null, userJudgment: null, bundleId: null },
    ],
  });
  assert.equal(page.items[0].candidateId, null);
  assert.equal(page.items[0].userJudgment, null);
  assert.equal(page.items[0].bundleId, null);
});

test("상세 제공 여부와 스냅샷 유무는 독립이다", () => {
  const page = readMyHistories({
    items: [{ ...history, detailAvailable: false, snapshotAvailable: true }],
  });
  assert.equal(page.items[0].detailAvailable, false);
  assert.equal(page.items[0].snapshotAvailable, true);
});

test("모양이 어긋나면 조용히 통과시키지 않는다", () => {
  assert.throws(() => readMyStars({ items: [{ ...star, planetCount: "2" }] }));
  assert.throws(() => readMyStars({ items: null }));
  assert.throws(() =>
    readMyHistories({ items: [{ ...history, publication: null }] }),
  );
  // 빈 문자열 ID는 없는 것과 같다. 그대로 두면 빈 경로로 조회하게 된다.
  assert.throws(() => readMyHistories({ items: [{ ...history, ticId: "" }] }));
});

test("보내지 않기로 한 것은 경로에 싣지 않는다", () => {
  assert.equal(myHistoriesPath({}, null), "/v1/me/histories");
  assert.equal(starsPath(null, null), "/v1/me/stars");
  assert.equal(starsPath("u-7", null), "/v1/members/u-7/stars");
  // 서버가 받지 않는 필터를 실어 보내지 않는다(P1 미구현).
  assert.doesNotMatch(starsPath(null, "c1"), /stage|grade|ticId|size/);
  // 타인에게 scope=discovered를 보내면 400이다. 아예 싣지 않는다.
  assert.doesNotMatch(starsPath("u-7", "c1"), /scope|discovered/);
});

test("빈 필터는 서버에 보내지 않는다", () => {
  // 서버는 빈 문자열을 미지정으로 읽지만, 보내면 커서 묶음 문자열이 달라 보인다.
  assert.equal(
    myHistoriesPath({ result: "", ticId: "" }, null),
    "/v1/me/histories",
  );
  assert.equal(
    myHistoriesPath({ result: "matched" }, null),
    "/v1/me/histories?result=matched",
  );
});

test("커서는 조건 뒤에 붙는다", () => {
  assert.equal(
    myHistoriesPath({ result: "skipped" }, "abc=="),
    "/v1/me/histories?result=skipped&cursor=abc%3D%3D",
  );
  assert.equal(starsPath(null, "a b"), "/v1/me/stars?cursor=a%20b");
});
