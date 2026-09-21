import type { Plugin } from "vite";
export function settingsFixturePlugin(): Plugin {
  let visibility = "PUBLIC";
  return {
    name: "settings-fixture-221",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const send = (value: unknown, status = 200) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        if (path === "/v1/me" && req.method === "GET") {
          send({
            memberId: "u-209",
            nickname: "설정 확인 탐사자",
            role: "MEMBER",
            joinedAt: "2026-09-14T15:30:00Z",
            onboardingDone: true,
            tutorialCompleted: true,
            starListVisibility: visibility,
            achievementSummary: {
              discoveredStarCount: 57,
              completedStarCount: 5,
              signalCount: 9,
              byType: { confirmed: 5, unconfirmed: 3, fp: 1 },
              starCountByGrade: { A: 3, S: 1, SS: 1, SSS: 0 },
            },
          });
          return;
        }
        if (path !== "/v1/me/settings" || req.method !== "PATCH") return next();
        if (req.headers["x-csrf-token"] !== "community-fixture-209")
          return send({ code: "CSRF_INVALID", message: "CSRF 확인" }, 403);
        try {
          let body = "";
          for await (const chunk of req) {
            body += String(chunk);
            if (body.length > 10000) throw Error();
          }
          const value = JSON.parse(body).starListVisibility;
          if (!["PUBLIC", "PRIVATE"].includes(value)) throw Error();
          visibility = value;
          send({ starListVisibility: value });
        } catch {
          send({ code: "VALIDATION_FAILED", message: "공개 설정 확인" }, 400);
        }
      });
    },
  };
}
