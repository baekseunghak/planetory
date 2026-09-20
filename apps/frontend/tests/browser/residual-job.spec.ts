import { expect, test, type APIRequestContext } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import { RESIDUAL_FIXTURE_HEADER } from "../../dev/residual-job-fixtures.ts";

// 개발 서버의 실제 응답이 7.1·7.2절 모양인지 본다. 단위 검사는 우리가 만든
// 본문을 읽으므로 서버 자리의 응답이 달라도 알 수 없다.

const TIC = PERIODOGRAM_FIXTURE_TICS.normal;
const target = (removed: string[]) => ({
  target: {
    bundleId: "9007199254741093",
    removedCandidateIds: removed,
    residualModelVersion: "rm-fixture-183",
    periodogramConfigVersion: "pg-synthetic-184-v2",
  },
});
const post = (
  request: APIRequestContext,
  removed: string[],
  scenario?: string,
) =>
  request.post(`/api/v1/stars/${TIC}/residual-jobs`, {
    headers: scenario ? { [RESIDUAL_FIXTURE_HEADER]: scenario } : {},
    data: target(removed),
    failOnStatusCode: false,
  });
const unique = () => [`c-${crypto.randomUUID().slice(0, 8)}`];

test("a job runs through the whole order and then serves from cache", async ({
  request,
}) => {
  const removed = unique();
  const created = await post(request, removed);
  expect(created.status()).toBe(202);
  const first = await created.json();
  expect(first.status).toBe("QUEUED");
  expect(first.cacheHit).toBe(false);

  const seen: string[] = [first.status];
  for (let i = 0; i < 6 && seen.at(-1) !== "COMPLETED"; i++) {
    const poll = await request.get(`/api/v1/residual-jobs/${first.jobId}`);
    expect(poll.status()).toBe(200);
    seen.push((await poll.json()).status);
  }
  // 2.4절 순서 그대로다. 건너뛰지 않는다.
  expect(seen).toEqual([
    "QUEUED",
    "RESIDUAL_CALCULATING",
    "RESIDUAL_READY",
    "PERIODOGRAM_CALCULATING",
    "COMPLETED",
  ]);

  // 같은 목표를 다시 요청하면 계산하지 않고 캐시가 온다.
  const again = await post(request, removed);
  expect(again.status()).toBe(200);
  const cached = await again.json();
  expect(cached.cacheHit).toBe(true);
  expect(cached.jobId).toBeNull();
  expect(cached.resultCurveContext.removedCandidateIds).toEqual(removed);
});

test("the same target is computed once, and an empty one is refused", async ({
  request,
}) => {
  const removed = unique();
  const first = await post(request, removed);
  const second = await post(request, removed);
  // 같은 키는 하나만 계산한다. 두 번째는 그 작업을 그대로 돌려준다.
  expect(second.status()).toBe(202);
  expect((await second.json()).jobId).toBe((await first.json()).jobId);

  // 빈 배열은 원본이므로 작업이 아니다(7.1절).
  const empty = await post(request, []);
  expect(empty.status()).toBe(400);
});

test("each refusal keeps the field the screen needs", async ({ request }) => {
  const full = await post(request, unique(), "queue-full");
  expect(full.status()).toBe(429);
  expect((await full.json()).retryAfterSeconds).toBe(12);
  // 내가 이미 돌리고 있는 작업이면 그 ID가 함께 온다(D-4).
  const other = await post(request, unique(), "other-job");
  expect((await other.json()).activeJobId).toBe("rj-other");

  const changed = await post(request, unique(), "bundle-changed");
  expect(changed.status()).toBe(409);
  expect((await changed.json()).code).toBe("BUNDLE_CHANGED");
});

test("a failure carries its reason and no result context", async ({
  request,
}) => {
  const created = await post(request, unique(), "fail");
  const { jobId } = await created.json();
  let body: { status: string; failure: unknown; resultCurveContext: unknown } =
    {
      status: "QUEUED",
      failure: null,
      resultCurveContext: null,
    };
  for (let i = 0; i < 6 && body.status !== "FAILED"; i++)
    body = await (await request.get(`/api/v1/residual-jobs/${jobId}`)).json();
  expect(body.status).toBe("FAILED");
  expect(body.failure).not.toBeNull();
  // 실패에는 바꿀 문맥이 없다.
  expect(body.resultCurveContext).toBeNull();
});
