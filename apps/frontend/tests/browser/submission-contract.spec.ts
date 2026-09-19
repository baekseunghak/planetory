import { expect, test, type APIRequestContext } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import { ANALYSIS_FIXTURE_TICS } from "../../dev/analysis-fixtures.ts";
import { SUBMISSION_FIXTURE_HEADER } from "../../dev/submission-fixtures.ts";
import { decodeSubmissionReceipt } from "../../src/features/analysis/submission-data.ts";

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
      // 직접 고른 주기다. 봉우리를 고르면 #188 조합표가 매칭 결과를 채우는데,
      // 이 검사가 보는 것은 접수의 뼈대이지 매칭 결과가 아니다.
      sourcePeakGridIndex: null,
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

// 응답 유실은 헤더까지 보낸 뒤 본문을 끊어 만든다. 아무 바이트도 보내지 않고
// 끊으면 클라이언트가 POST를 스스로 다시 보내 유실이 되지 않는다.
async function expectLostResponse(
  pending: Promise<import("@playwright/test").APIResponse>,
) {
  let response: import("@playwright/test").APIResponse;
  try {
    response = await pending;
  } catch {
    return; // 연결 자체가 끊긴 경우도 결과 불명이다.
  }
  expect(response.status()).toBe(500);
  await expect(response.json()).rejects.toThrow();
}

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
  await expectLostResponse(post(candidate(id), "drop-saved"));
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

  await expectLostResponse(post(candidate(id), "drop-unsaved"));
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

test("the real fixture body passes the parser for every submission kind", async ({
  request,
}) => {
  const { candidate, context, post } = await setUp(request);
  // 손으로 쓴 표본이 아니라 개발 서버가 실제로 보내는 본문을 읽는다.
  // 지난 계약 불일치가 바로 이 틈에서 나왔다.
  const id = uuid();
  const created = await post(candidate(id));
  const receipt = decodeSubmissionReceipt(
    await created.json(),
    {
      ticId: TIC,
      requestId: id,
    },
    created.status(),
  );
  expect(receipt.outcome).toBe("created");
  expect(receipt.matchStatus).toBe("not_matched");
  expect(receipt.curveContext).toEqual(context.currentCurveContext);
  expect(receipt.progress.currentCurveStep).toBe(
    context.currentCurveContext.curveStep,
  );

  const replayed = await post(candidate(id));
  expect(
    decodeSubmissionReceipt(
      await replayed.json(),
      { ticId: TIC, requestId: id },
      replayed.status(),
    ).outcome,
  ).toBe("replayed");

  const none = uuid();
  const empty = await post({
    requestId: none,
    submissionKind: "no_candidate",
    curveContext: context.currentCurveContext,
    retryOfSubmissionId: null,
  });
  const noCandidate = decodeSubmissionReceipt(
    await empty.json(),
    { ticId: TIC, requestId: none },
    empty.status(),
  );
  expect(noCandidate.submissionKind).toBe("no_candidate");
  expect(noCandidate.matchStatus).toBe("none_wrong");
});

test("an eligible tutorial star accepts a skip and completes with that reason", async ({
  request,
}) => {
  const tutorial = PERIODOGRAM_FIXTURE_TICS.tutorial;
  const csrf = await (await request.get("/api/v1/auth/csrf")).json();
  const context = await (
    await request.get(`/api/v1/stars/${tutorial}/analysis-context`)
  ).json();
  // 건너뛰기 허용은 서버가 정한다. 프론트는 이 표시가 있을 때만 제안한다.
  expect(context.tutorial.skipAvailable).toBe(true);

  const id = uuid();
  const response = await request.post(`/api/v1/stars/${tutorial}/submissions`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      requestId: id,
      submissionKind: "skipped",
      curveContext: context.currentCurveContext,
      retryOfSubmissionId: null,
    },
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(201);
  const receipt = decodeSubmissionReceipt(
    await response.json(),
    { ticId: tutorial, requestId: id },
    response.status(),
  );
  expect(receipt.submissionKind).toBe("skipped");
  expect(receipt.matchStatus).toBe("skipped");
  // SUB-12: 건너뛴 별은 completion_reason=skipped로 완료된다.
  expect(receipt.progress.stage).toBe("completed");
  expect(receipt.progress.completionReason).toBe("skipped");
});

test("a not-ready residual is refused without storing, and the same id still works", async ({
  request,
}) => {
  const { candidate, post, byRequest } = await setUp(request);
  const id = uuid();

  const refused = await post(candidate(id), "context-not-ready");
  expect(refused.status()).toBe(409);
  const body = await refused.json();
  expect(body.code).toBe("SUBMISSION_CONTEXT_NOT_READY");
  // 상태·작업 번호를 실어 와야 화면이 왜 못 보내는지 말할 수 있다.
  expect(body.residual).toEqual({
    status: "QUEUED",
    jobId: "job-7701",
    computedAt: null,
  });

  // 저장하지 않았다. 조회가 200이면 접수된 것이라 「미접수」가 거짓이 된다.
  expect((await byRequest(id)).status()).toBe(404);

  // 잔차가 준비된 뒤 같은 ID로 다시 보내면 새 접수가 된다.
  const accepted = await post(candidate(id));
  expect(accepted.status()).toBe(201);
  expect((await accepted.json()).requestId).toBe(id);
});

test("every result combination the fixture produces passes the parser", async ({
  request,
}) => {
  const { context, post } = await setUp(request);
  const send = async (
    sourcePeakGridIndex: number | null,
    userJudgment: string,
    outcome?: string,
  ) => {
    const id = uuid();
    const csrf = await (await request.get("/api/v1/auth/csrf")).json();
    const response = await request.post(`/api/v1/stars/${TIC}/submissions`, {
      headers: outcome
        ? { [csrf.headerName]: csrf.token, "X-Fixture-Outcome": outcome }
        : { [csrf.headerName]: csrf.token },
      data: {
        requestId: id,
        submissionKind: "candidate",
        curveContext: context.currentCurveContext,
        selection: {
          periodDays: 11.7346,
          sourcePeakGridIndex,
          phaseStart: 0.49,
          phaseEnd: 0.51,
        },
        userJudgment,
        evidenceChecks: [],
        memo: "",
        retryOfSubmissionId: null,
      },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(201);
    return decodeSubmissionReceipt(
      await response.json(),
      { ticId: TIC, requestId: id },
      response.status(),
    );
  };

  // 확정 + 맞힘: 매칭도 성과도 성공이고 채점이 붙는다.
  const right = await send(3600, "LIKELY_PLANET");
  expect(right.matchStatus).toBe("matched");
  expect(right.explanation.evaluation).toBe("AGREES");
  expect(right.explanation.achievement.result).toBe("recognized");
  expect(right.explanation.achievement.unlockedTicIds).toHaveLength(1);
  expect(right.explanation.statistics?.kind).toBe("graded");

  // 확정 + 오판: 매칭은 성공인데 성과만 미인정이다. 완료 조건의 그 조합이다.
  const wrong = await send(3600, "UNLIKELY_PLANET");
  expect(wrong.matchStatus).toBe("matched");
  expect(wrong.explanation.evaluation).toBe("DISAGREES");
  expect(wrong.explanation.achievement.result).toBe("judgment_mismatch");

  // 미확정: 채점하지 않고 게시할 수 있으며 공개 분포를 준다. 배수 정정이 있다.
  const open = await send(2500, "LIKELY_PLANET");
  expect(open.matchStatus).toBe("matched_harmonic");
  expect(open.explanation.evaluation).toBe("UNSCORED");
  expect(open.explanation.publication.state).toBe("UNPUBLISHED");
  expect(open.explanation.statistics?.kind).toBe("public_analyses");
  expect(open.explanation.correction?.multiplier).toBe(2);
  expect(open.explanation.correction?.correctedPeriodDays).toBeCloseTo(
    11.7346 * 2,
    6,
  );

  // FP: AI를 실행하지 못했다. 점수를 0으로 만들지 않는다.
  const fp = await send(1600, "UNLIKELY_PLANET");
  expect(fp.explanation.signal?.ai.status).toBe("input_insufficient");
  expect(fp.explanation.signal?.ai.score).toBeUndefined();
  // 외부 출처는 원천 표기 그대로다.
  expect(fp.explanation.signal?.external[0].disposition).toBe("FP");

  // 직접 선택: 미매칭이라 신호·통계가 없고 그 단계의 힌트를 준다.
  const free = await send(null, "UNSURE");
  expect(free.matchStatus).toBe("not_matched");
  expect(free.explanation.signal).toBeNull();
  expect(free.explanation.statistics).toBeNull();
  expect(free.explanation.detail.targetKind).toBe("CURRENT_CURVE_HINT");

  // 모호: 서버가 어느 후보도 고르지 않았다. 아무것도 붙이지 않는다.
  const unsure = await send(3600, "LIKELY_PLANET", "ambiguous");
  expect(unsure.matchStatus).toBe("ambiguous_match");
  expect(unsure.explanation.signal).toBeNull();
  expect(unsure.explanation.achievement.result).toBe("none");
  expect(unsure.explanation.detail.targetKind).toBeNull();

  // 공개 0명: 비율이 null이며 0%가 아니다.
  const empty = await send(2500, "UNSURE", "empty-statistics");
  const statistics = empty.explanation.statistics as {
    participantCount: number;
    percentages: unknown;
  };
  expect(statistics.participantCount).toBe(0);
  expect(statistics.percentages).toBeNull();
});
