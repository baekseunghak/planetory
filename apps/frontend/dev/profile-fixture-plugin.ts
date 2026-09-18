import type { Plugin } from "vite";
import { nicknameProblem, normalizedNickname } from "../src/auth/flow.ts";
export function createProfileFixture() {
  let nickname = "탐사자214";
  const summary = {
    discoveredStarCount: 57,
    completedStarCount: 5,
    signalCount: 9,
    byType: { confirmed: 5, unconfirmed: 3, fp: 1 },
    starCountByGrade: { A: 3, S: 1, SS: 1, SSS: 0 },
  };
  const plugin: Plugin = {
    name: "profile-fixture-214",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const send = (value: unknown, status = 200) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && url.pathname === "/v1/me") {
          send({
            memberId: "u-209",
            nickname,
            joinedAt: "2026-09-14T15:30:00Z",
            role: "MEMBER",
            starListVisibility: "PUBLIC",
            tutorialCompleted: true,
            onboardingDone: true,
            achievementSummary: summary,
          });
          return;
        }
        if (req.method === "PATCH" && url.pathname === "/v1/me/profile") {
          if (req.headers["x-csrf-token"] !== "community-fixture-209") {
            send({ code: "CSRF_INVALID", message: "CSRF 확인" }, 403);
            return;
          }
          let input;
          try {
            let body = "";
            for await (const chunk of req) {
              body += String(chunk);
              if (body.length > 10000) throw Error();
            }
            input = JSON.parse(body);
          } catch {
            send({ code: "VALIDATION_FAILED", message: "요청 확인" }, 400);
            return;
          }
          const error =
            typeof input?.nickname === "string"
              ? nicknameProblem(input.nickname)
              : "닉네임 확인";
          if (error) {
            send(
              {
                code: "VALIDATION_FAILED",
                message: error,
                fieldErrors: [{ field: "nickname", reason: error }],
              },
              400,
            );
            return;
          }
          if (input.nickname === "이미사용중") {
            send(
              {
                code: "NICKNAME_CONFLICT",
                message: "이미 사용 중인 닉네임입니다.",
              },
              409,
            );
            return;
          }
          nickname = normalizedNickname(input.nickname);
          send({ memberId: "u-209", nickname });
          return;
        }
        const member = url.pathname.match(/^\/v1\/members\/(u-\d+)$/);
        if (req.method === "GET" && member) {
          if (!["u-210", "u-211"].includes(member[1])) {
            send(
              {
                code: "RESOURCE_NOT_FOUND",
                message: "회원을 찾을 수 없습니다.",
              },
              404,
            );
            return;
          }
          send({
            memberId: member[1],
            nickname: "다른탐사자",
            starListVisibility: member[1] === "u-210" ? "PRIVATE" : "PUBLIC",
            achievementSummary: {
              signalCount: 7,
              starCountByGrade: { A: 3, S: 1, SS: 0, SSS: 0 },
            },
          });
          return;
        }
        next();
      });
    },
  };
  return { plugin, nickname: () => nickname };
}
