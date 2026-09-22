import type { Plugin } from "vite";
import { resolve } from "node:path";
import { observationFixtureResponse } from "./observation-fixtures.ts";
import { periodogramFixtureResponse } from "./periodogram-fixtures.ts";
import { historyFixtureResponse } from "./history-fixtures.ts";
import { createPublicationFixture } from "./publication-fixtures.ts";
import {
  ANALYSIS_FIXTURE_BUNDLE,
  analysisFixtureResponse,
} from "./analysis-fixtures.ts";
import {
  readOutcome,
  readScenario,
  SUBMISSION_FIXTURE_CSRF,
  SUBMISSION_FIXTURE_HEADER,
  SUBMISSION_OUTCOME_HEADER,
  submissionFixtureResponse,
} from "./submission-fixtures.ts";
import {
  pollResidualJobFixture,
  readResidualScenario,
  requestResidualJobFixture,
  RESIDUAL_FIXTURE_HEADER,
} from "./residual-job-fixtures.ts";

const BODY_LIMIT = 100_000;
// Serve-only fixture. No account-selection, reset, achievement or OAuth endpoints.
export function fixturePlugin(observations = false): Plugin {
  return {
    name: "foundation-fixture",
    apply: "serve",
    configureServer(server) {
      const publicationFixture = createPublicationFixture();
      server.middlewares.use("/api", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "GET" && req.url?.split("?")[0] === "/v1/me") {
          // Test-only acknowledgement: prove the browser sent the cookie to
          // this HTTP server, without reflecting any cookie value to the UI.
          const hasTestSession = (req.headers.cookie ?? "")
            .split(";")
            .some((cookie) => cookie.trim() === "test-session=fixture-only");
          res.setHeader("X-Fixture-Session-Received", String(hasTestSession));
          res.end(
            JSON.stringify({
              memberId: "foundation-fixture-member-201",
              nickname: "연결 확인 계정",
              onboardingDone: true,
              tutorialCompleted: true,
            }),
          );
          return;
        }
        const url = new URL(req.url ?? "/", "http://fixture.invalid");
        if (req.method === "GET" && url.pathname === "/v1/auth/csrf") {
          // 쓰기 요청마다 새로 받는 토큰. 고정값이며 실제 CSRF 방어가 아니다.
          res.end(
            JSON.stringify({
              headerName: "X-CSRF-TOKEN",
              token: SUBMISSION_FIXTURE_CSRF,
            }),
          );
          return;
        }
        if (url.pathname.startsWith("/v1/public-analyses") || /^\/v1\/histories\/h-195[123](\/graph)?$/.test(url.pathname) ||
            (url.pathname === "/v1/me/histories" && url.searchParams.get("candidateId")?.startsWith("c-195"))) {
          let body: unknown;
          if (req.method !== "GET") {
            let raw = "";
            for await (const chunk of req) {
              raw += chunk;
              if (raw.length > BODY_LIMIT) { res.statusCode = 413; res.end(); return; }
            }
            try { body = raw ? JSON.parse(raw) : undefined; }
            catch { res.statusCode = 400; res.end(); return; }
          }
          const reply = publicationFixture(req.method ?? "GET", url, body);
          if (reply) { res.statusCode = reply.status; res.end(JSON.stringify(reply.body)); return; }
        }
        // #190 기록 상세·그래프. 읽기만 하므로 본문을 받지 않는다.
        const history = historyFixtureResponse(url.pathname, url.searchParams);
        if (req.method === "GET" && history) {
          res.statusCode = history.status;
          res.end(JSON.stringify(history.body));
          return;
        }

        // 7.1·7.2절 잔차 작업. 제출과 달리 요청 ID가 없고 목표 문맥이
        // 멱등 단위다. 같은 목표를 다시 보내면 같은 작업이나 캐시가 온다.
        {
          const job = /^[/]v1[/]residual-jobs[/]([^/]+)$/.exec(url.pathname);
          const create = /^[/]v1[/]stars[/]([^/]+)[/]residual-jobs$/.exec(
            url.pathname,
          );
          if (job && req.method === "GET") {
            const reply = pollResidualJobFixture(job[1]);
            res.statusCode = reply.status;
            // D-5 현재 판 헤더. 폴링이 이 값으로 판 교체를 잡는다.
            for (const [name, value] of Object.entries(reply.headers ?? {}))
              res.setHeader(name, value);
            res.end(JSON.stringify(reply.body));
            return;
          }
          if (create && req.method === "POST") {
            let raw = "";
            let body: unknown = null;
            try {
              for await (const chunk of req) {
                raw += String(chunk);
                if (raw.length > BODY_LIMIT) throw new Error("too large");
              }
              body = raw ? JSON.parse(raw) : null;
            } catch {
              body = null;
            }
            const reply = requestResidualJobFixture({
              ticId: create[1],
              body,
              scenario: readResidualScenario(
                req.headers[RESIDUAL_FIXTURE_HEADER],
              ),
            });
            res.statusCode = reply.status;
            res.end(JSON.stringify(reply.body));
            return;
          }
        }
        if (
          url.pathname.startsWith("/v1/submissions/") ||
          /^\/v1\/stars\/[^/]+\/submissions$/.test(url.pathname)
        ) {
          let body: unknown = null;
          if (req.method !== "GET") {
            let raw = "";
            try {
              for await (const chunk of req) {
                raw += String(chunk);
                if (raw.length > BODY_LIMIT) throw new Error("too large");
              }
              body = raw ? JSON.parse(raw) : null;
            } catch {
              body = null;
            }
          }
          const reply = submissionFixtureResponse({
            method: req.method ?? "GET",
            url,
            csrf: req.headers["x-csrf-token"],
            scenario: readScenario(req.headers[SUBMISSION_FIXTURE_HEADER]),
            outcome: readOutcome(req.headers[SUBMISSION_OUTCOME_HEADER]),
            body,
            // 진입 응답을 그대로 재사용해 별 접근 거절을 한 곳에서 판정한다.
            contextFor: (ticId) => {
              const probe = new URL(
                `/v1/stars/${ticId}/analysis-context`,
                "http://fixture.invalid",
              );
              return (
                periodogramFixtureResponse(probe) ??
                analysisFixtureResponse(probe)
              );
            },
          });
          if (reply) {
            if (reply.kind === "drop") {
              // 브라우저는 재사용된 연결이 한 바이트도 없이 닫히면 POST를 스스로
              // 다시 보낸다. 그러면 유실이 아니라 멱등 재현이 되므로, 유실은
              // 헤더를 보낸 뒤 본문을 끊어 「받긴 했지만 읽을 수 없는」 응답으로
              // 만든다. 공용 클라이언트가 이때 outcomeUnknown을 켠다.
              if (reply.reset) {
                res.destroy();
                return;
              }
              res.writeHead(500, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              // 헤더와 첫 조각이 소켓에 실제로 나간 뒤에 끊어야 한다. 바로
              // destroy하면 Node가 버퍼째 버려 바이트 없는 초기화가 된다.
              res.write('{"code":"SERVER_ERROR"', () =>
                setTimeout(() => res.destroy(), 20),
              );
              return;
            }
            res.statusCode = reply.status;
            res.setHeader(
              "X-Current-Bundle",
              reply.currentBundleId ?? ANALYSIS_FIXTURE_BUNDLE,
            );
            res.end(JSON.stringify(reply.body));
            return;
          }
        }
        if (req.method === "GET") {
          const analysis =
            (observations
              ? await observationFixtureResponse(
                  url,
                  resolve(server.config.root, "dev/observations"),
                )
              : null) ??
            periodogramFixtureResponse(url) ??
            analysisFixtureResponse(url);
          if (analysis) {
            res.statusCode = analysis.status;
            res.setHeader(
              "X-Current-Bundle",
              analysis.currentBundleId ?? ANALYSIS_FIXTURE_BUNDLE,
            );
            res.end(JSON.stringify(analysis.body));
            return;
          }
        }
        res.statusCode = req.method === "GET" ? 404 : 405;
        res.end(
          JSON.stringify({
            code: "RESOURCE_NOT_FOUND",
            message: "이 테스트 응답에는 해당 기능이 없습니다.",
            fieldErrors: [],
          }),
        );
      });
    },
  };
}
