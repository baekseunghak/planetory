import { expect, test } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";

// 접수·복구 사다리를 실제 클라이언트와 개발 서버로 끝까지 돌린다.
// 단위 검사는 가짜 request를 쓰므로 공용 클라이언트가 소켓 끊김을
// outcomeUnknown으로 바꿔 주는지, 복구가 실제 HTTP에서 이어지는지는 보지 못한다.
const TIC = PERIODOGRAM_FIXTURE_TICS.normal;

type Run = {
  state: string;
  recovered?: boolean;
  outcome?: string;
  submissionId?: string;
  requestId?: string;
  reason?: string;
  posts: number;
  gets: number;
  released: number;
};

async function run(
  page: import("@playwright/test").Page,
  scenario: string | null,
) {
  return page.evaluate<Run, string | null>(async (fixtureScenario) => {
    const paths = [
      "/src/api/client.ts",
      "/src/features/analysis/submit-analysis.ts",
    ];
    const [{ createApiClient }, { submitAnalysis }] = await Promise.all(
      paths.map((path) => import(/* @vite-ignore */ path)),
    );
    let posts = 0;
    let gets = 0;
    // 유실·처리 중은 한 번만 일어나야 한다. 첫 POST에만 붙인다.
    let pending = fixtureScenario;
    const client = createApiClient({
      baseUrl: "/api",
      csrfHeaders: async () => {
        const token = await (await fetch("/api/v1/auth/csrf")).json();
        return { [token.headerName]: token.token };
      },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if ((init?.method ?? "GET") === "POST") {
          posts += 1;
          if (pending) {
            headers.set("X-Fixture-Submit", pending);
            pending = null;
          }
        } else gets += 1;
        return fetch(input, { ...init, headers });
      },
    });
    const context = await (
      await fetch(`/api/v1/stars/${"259377024"}/analysis-context`)
    ).json();
    let released = 0;
    const result = await submitAnalysis({
      request: client.request,
      ticId: "259377024",
      input: {
        submissionKind: "candidate",
        curveContext: context.currentCurveContext,
        selection: {
          periodDays: 11.7346,
          sourcePeakGridIndex: 3600,
          phaseStart: 0.49,
          phaseEnd: 0.51,
        },
        userJudgment: "LIKELY_PLANET",
        evidenceChecks: [],
        memo: "",
        viewState: null,
        retryOfSubmissionId: null,
      },
      requestId: crypto.randomUUID(),
      signal: new AbortController().signal,
      releaseRequestId: () => {
        released += 1;
      },
      wait: async () => {},
    });
    return {
      state: result.state,
      recovered: "recovered" in result ? result.recovered : undefined,
      outcome: "receipt" in result ? result.receipt.outcome : undefined,
      submissionId:
        "receipt" in result ? result.receipt.submissionId : undefined,
      requestId: "receipt" in result ? result.receipt.requestId : undefined,
      reason: "reason" in result ? result.reason : undefined,
      posts,
      gets,
      released,
    };
  }, scenario);
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/analysis/${TIC}`);
});

test("a normal submission is accepted in one send", async ({ page }) => {
  const result = await run(page, null);
  expect(result.state).toBe("accepted");
  expect(result.outcome).toBe("created");
  expect(result.recovered).toBe(false);
  expect(result.posts).toBe(1);
  expect(result.gets).toBe(0);
  expect(result.released).toBe(0);
});

test("a dropped response after acceptance is recovered by request id", async ({
  page,
}) => {
  const result = await run(page, "drop-saved");
  // 공용 클라이언트가 끊긴 소켓을 결과 불명으로 바꾸고, 사다리가 조회로 잇는다.
  expect(result.state).toBe("accepted");
  expect(result.recovered).toBe(true);
  expect(result.posts).toBe(1);
  expect(result.gets).toBe(1);
  // 한 번 보냈고 한 번 조회했다. 두 번째 제출은 만들지 않았다.
  expect(result.released).toBe(0);
});

test("a dropped response before acceptance resends the same id and succeeds", async ({
  page,
}) => {
  const result = await run(page, "drop-unsaved");
  expect(result.state).toBe("accepted");
  expect(result.outcome).toBe("created");
  expect(result.recovered).toBe(true);
  expect(result.posts).toBe(2);
  expect(result.gets).toBe(1);
  expect(result.released).toBe(0);
});

test("a request already in progress settles through polling, not resending", async ({
  page,
}) => {
  const result = await run(page, "in-progress");
  expect(result.state).toBe("accepted");
  expect(result.recovered).toBe(true);
  expect(result.posts).toBe(1);
  // 409 한 번, 저장된 결과 한 번.
  expect(result.gets).toBe(2);
  expect(result.released).toBe(0);
});

test("a second submission of the same body replays the first one", async ({
  page,
}) => {
  const first = await run(page, null);
  const second = await page.evaluate(async (requestId) => {
    const paths = [
      "/src/api/client.ts",
      "/src/features/analysis/submit-analysis.ts",
    ];
    const [{ createApiClient }, { submitAnalysis }] = await Promise.all(
      paths.map((path) => import(/* @vite-ignore */ path)),
    );
    const client = createApiClient({
      baseUrl: "/api",
      csrfHeaders: async () => {
        const token = await (await fetch("/api/v1/auth/csrf")).json();
        return { [token.headerName]: token.token };
      },
    });
    const context = await (
      await fetch("/api/v1/stars/259377024/analysis-context")
    ).json();
    const result = await submitAnalysis({
      request: client.request,
      ticId: "259377024",
      input: {
        submissionKind: "no_candidate",
        curveContext: context.currentCurveContext,
        retryOfSubmissionId: null,
      },
      requestId,
      signal: new AbortController().signal,
      releaseRequestId: () => {},
      wait: async () => {},
    });
    return { state: result.state };
  }, first.requestId!);
  // 같은 ID에 다른 본문이므로 재현이 아니라 거절이다.
  expect(second.state).toBe("conflict");
});

test("the browser's own resend of a POST does not create a second submission", async ({
  page,
}) => {
  // 재사용된 연결이 한 바이트도 없이 닫히면 브라우저가 POST를 스스로 다시
  // 보낸다. 앱의 fetch는 한 번이지만 서버는 두 번 받는다. 앱이 볼 수도 없고
  // 막을 수도 없는 재전송이므로, 요청 ID가 흡수하는지가 유일한 방어다.
  const result = await run(page, "reset-connection");
  expect(result.state).toBe("accepted");
  // 앱은 한 번만 보냈다고 알고 있다.
  expect(result.posts).toBe(1);
  expect(result.gets).toBe(0);
  // 서버가 저장된 결과를 재현했다. 새 Submission이 생기지 않았다는 뜻이다.
  expect(result.outcome).toBe("replayed");
  expect(result.released).toBe(0);
});
