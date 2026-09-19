import { expect, test, type APIRequestContext } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import { ANALYSIS_FIXTURE_TICS } from "../../dev/analysis-fixtures.ts";
import { SUBMISSION_FIXTURE_HEADER } from "../../dev/submission-fixtures.ts";

// 제출 fixture가 탐사 API 2.2·2.3·6.1~6.6 그대로 답하는지 HTTP로 확인한다.
// 앱 코드가 아니라 개발 서버의 계약을 검사하므로 브라우저 페이지를 쓰지 않는다.
const TIC = PERIODOGRAM_FIXTURE_TICS.normal;
const BUNDLE = "9007199254741093";

type Context = {
  currentCurveContext: {
    bundleId: string;
    curveStep: number;
    removedCandidateIds: string[];
    residualModelVersion: string;
    periodogramConfigVersion: string;
  };
};
async function setUp(request: APIRequestContext) {
  const csrf = await (await request.get("/api/v1/auth/csrf")).json();
  const context: Context = await (
    await request.get(`/api/v1/stars/${TIC}/analysis-context`)
  ).json();
  const headers = { [csrf.headerName]: csrf.token };
  const candidate = (
    requestId: string,
    patch: Record<string, unknown> = {},
  ) => ({
    requestId,
    submissionKind: "candidate",
    curveContext: context.currentCurveContext,
    selection: {
      periodDays: 11.7346,
      sourcePeakGridIndex: 3600,
      phaseStart: 0.49,
      phaseEnd: 0.51,
    },
    userJudgment: "LIKELY_PLANET",
    evidenceChecks: ["oddeven"],
    memo: "합성 확인",
    viewState: {
      periodogramViewport: { minDays: 8, maxDays: 16 },
      foldedXZoomRatio: 4,
    },
    retryOfSubmissionId: null,
    ...patch,
  });
  const post = (data: unknown, scenario?: string) =>
    request.post(`/api/v1/stars/${TIC}/submissions`, {
      headers: scenario
        ? { ...headers, [SUBMISSION_FIXTURE_HEADER]: scenario }
        : headers,
      data: data as object,
      failOnStatusCode: false,
    });
  const byRequest = (requestId: string) =>
    request.get(`/api/v1/submissions/by-request/${requestId}`, {
      failOnStatusCode: false,
    });
  return { headers, context, candidate, post, byRequest };
}
const uuid = () => crypto.randomUUID();

test("the same request id replays one submission and rejects a different body", async ({
  request,
}) => {
  const { candidate, post } = await setUp(request);
  const id = uuid();

  const created = await post(candidate(id));
  expect(created.status()).toBe(201);
  // 판 교체 감지가 헛돌지 않도록 이 별의 현재 판을 실어야 한다.
  expect(created.headers()["x-current-bundle"]).toBe(BUNDLE);
  const first = await created.json();
  expect(first.submissionKind).toBe("candidate");
  expect(first.requestId).toBe(id);
  // 미매칭은 signal·통계를 주지 않는다(AT-14·75).
  expect(first.signal).toBeNull();
  expect(first.judgmentStatistics).toBeNull();

  const replay = await post(candidate(id));
  expect(replay.status()).toBe(200);
  // SUB-09: 새 행·성과 없음. 같은 Submission·History를 그대로 재현한다.
  const again = await replay.json();
  expect(again.submissionId).toBe(first.submissionId);
  expect(again.historyId).toBe(first.historyId);

  const conflict = await post(candidate(id, { memo: "다른 내용" }));
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).code).toBe("IDEMPOTENCY_CONFLICT");
});

test("a lost response is recovered by request id without creating a second submission", async ({
  request,
}) => {
  const { candidate, post, byRequest } = await setUp(request);
  const id = uuid();

  // 접수까지 끝난 뒤 응답만 사라진 경우. 상태 코드조차 없다.
  await expect(post(candidate(id), "drop-saved")).rejects.toThrow();
  const recovered = await byRequest(id);
  expect(recovered.status()).toBe(200);
  const stored = await recovered.json();
  expect(stored.requestId).toBe(id);

  // 같은 ID로 다시 보내도 저장된 결과를 재현할 뿐 새로 만들지 않는다.
  const resend = await post(candidate(id));
  expect(resend.status()).toBe(200);
  expect((await resend.json()).submissionId).toBe(stored.submissionId);
});

test("an unsaved lost response answers 404 and the same id still succeeds", async ({
  request,
}) => {
  const { candidate, post, byRequest } = await setUp(request);
  const id = uuid();

  await expect(post(candidate(id), "drop-unsaved")).rejects.toThrow();
  expect((await byRequest(id)).status()).toBe(404);
  // 404를 미접수로 단정하지 않고 같은 ID로 재전송한다. 새 ID를 만들지 않는다.
  const resent = await post(candidate(id));
  expect(resent.status()).toBe(201);
  expect((await resent.json()).requestId).toBe(id);
});

test("a request in progress is polled by request id rather than resent with a new one", async ({
  request,
}) => {
  const { candidate, post, byRequest } = await setUp(request);
  const id = uuid();

  const held = await post(candidate(id), "in-progress");
  expect(held.status()).toBe(409);
  expect((await held.json()).code).toBe("REQUEST_IN_PROGRESS");
  expect((await byRequest(id)).status()).toBe(409);
  const settled = await byRequest(id);
  expect(settled.status()).toBe(200);
  expect((await settled.json()).requestId).toBe(id);
});

test("a stale bundle is refused with the current one instead of being accepted", async ({
  request,
}) => {
  const { candidate, context, post } = await setUp(request);
  const stale = await post(
    candidate(uuid(), {
      curveContext: {
        ...context.currentCurveContext,
        bundleId: "9007199254740000",
      },
    }),
  );
  expect(stale.status()).toBe(409);
  const body = await stale.json();
  expect(body.code).toBe("BUNDLE_CHANGED");
  expect(body.currentBundleId).toBe(BUNDLE);
});

test("validation failures name the field and use the implemented reason key", async ({
  request,
}) => {
  const { candidate, post } = await setUp(request);
  const invalid = await post(
    candidate(uuid(), {
      selection: {
        periodDays: 0,
        sourcePeakGridIndex: null,
        phaseStart: 0.49,
        phaseEnd: 0.51,
      },
    }),
  );
  expect(invalid.status()).toBe(400);
  const body = await invalid.json();
  expect(body.code).toBe("VALIDATION_FAILED");
  // 명세 예제는 message지만 구현된 ErrorResponse.FieldError는 reason이다.
  expect(body.fieldErrors[0]).toEqual({
    field: "selection.periodDays",
    reason: expect.any(String),
  });

  const notUuid = await post(candidate("not-a-uuid"));
  expect(notUuid.status()).toBe(400);
  expect((await notUuid.json()).fieldErrors[0].field).toBe("requestId");
});

test("no_candidate carries no selection or judgment and cannot smuggle the previous one", async ({
  request,
}) => {
  const { context, post } = await setUp(request);
  const base = {
    submissionKind: "no_candidate",
    curveContext: context.currentCurveContext,
    retryOfSubmissionId: null,
  };

  const accepted = await post({ ...base, requestId: uuid() });
  expect(accepted.status()).toBe(201);
  const body = await accepted.json();
  expect(body.match.status).toBe("none_wrong");
  expect(body.original).toBeNull();
  expect(body.judgment).toBeNull();

  // 완료 조건: 더 없음 요청에 이전 후보의 수치·판단·근거를 섞지 않는다.
  const smuggled = await post({
    ...base,
    requestId: uuid(),
    selection: {
      periodDays: 11.7346,
      sourcePeakGridIndex: 3600,
      phaseStart: 0.49,
      phaseEnd: 0.51,
    },
    userJudgment: "LIKELY_PLANET",
  });
  expect(smuggled.status()).toBe(400);
  expect((await smuggled.json()).fieldErrors[0].field).toBe("selection");
});

test("skipping a star that is not an eligible tutorial is refused", async ({
  request,
}) => {
  const { context, post } = await setUp(request);
  const refused = await post({
    requestId: uuid(),
    submissionKind: "skipped",
    curveContext: context.currentCurveContext,
    retryOfSubmissionId: null,
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe("SKIP_NOT_AVAILABLE");
});

test("a locked star and a missing csrf token are refused before any submission is stored", async ({
  request,
}) => {
  const { candidate, headers } = await setUp(request);
  const locked = await request.post(
    `/api/v1/stars/${ANALYSIS_FIXTURE_TICS.locked}/submissions`,
    { headers, data: candidate(uuid()), failOnStatusCode: false },
  );
  expect(locked.status()).toBe(403);
  expect((await locked.json()).code).toBe("STAR_LOCKED");

  const noToken = await request.post(`/api/v1/stars/${TIC}/submissions`, {
    data: candidate(uuid()),
    failOnStatusCode: false,
  });
  expect(noToken.status()).toBe(403);
});
