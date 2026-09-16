import type { Plugin } from "vite";
// Serve-only fixture. No account-selection, reset, achievement or OAuth endpoints.
export function fixturePlugin(): Plugin {
  return {
    name: "foundation-fixture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", (req, res) => {
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
