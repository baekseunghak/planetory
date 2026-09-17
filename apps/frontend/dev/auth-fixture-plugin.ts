import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { nicknameProblem, normalizedNickname } from "../src/auth/flow.ts";

// Development-only contract simulator. These endpoints are NOT the S03 OAuth contract.
// Each browser gets a distinct server-memory session. No real provider/account is used.
export function authFixturePlugin(): Plugin {
  const sessions = new Map<
    string,
    {
      provider: string;
      nickname: string | null;
      csrf: string;
      loseNicknameReply: boolean;
    }
  >();
  return {
    name: "auth-fixture-202",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const cookies = Object.fromEntries(
          (req.headers.cookie || "")
            .split(";")
            .map((part) => part.trim().split("=")),
        );
        const sessionId = cookies["auth-fixture-202-session"];
        const session = sessions.get(sessionId);
        const reply = (status: number, value?: unknown) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(value === undefined ? undefined : JSON.stringify(value));
        };
        const redirect = (target: string) => {
          res.writeHead(302, { Location: target, "Cache-Control": "no-store" });
          res.end();
        };
        const error = (status: number, code: string, message: string) =>
          reply(status, { code, message });
        const provider = url.pathname.match(
          /^\/dev-auth-202\/(ssafy|google)$/,
        )?.[1];
        if (provider && req.method === "GET") {
          if (url.searchParams.get("scenario") === "cancel")
            return redirect("/oauth/callback?error=access_denied");
          if (url.searchParams.get("scenario") === "failure")
            return redirect("/oauth/callback?error=server_error");
          const id = randomUUID(),
            csrf = randomUUID();
          sessions.set(id, {
            provider,
            nickname:
              url.searchParams.get("scenario") === "first"
                ? null
                : provider === "google"
                  ? "구글탐사자"
                  : "싸피탐사자",
            csrf,
            loseNicknameReply:
              url.searchParams.get("loseNicknameReply") === "1",
          });
          res.setHeader("Set-Cookie", [
            `auth-fixture-202-session=${id}; HttpOnly; Path=/; SameSite=Lax`,
            `auth-fixture-202-csrf=${csrf}; Path=/; SameSite=Lax`,
          ]);
          return redirect("/oauth/callback");
        }
        if (!session)
          return error(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
        if (req.method === "GET" && url.pathname === "/v1/me") {
          if (!session.nickname)
            return error(
              403,
              "FIXTURE_NICKNAME_REQUIRED_202",
              "닉네임을 등록해 주세요.",
            );
          return reply(200, {
            memberId: `auth-fixture-202-${session.provider}`,
            nickname: session.nickname,
            onboardingDone: false,
            tutorialCompleted: false,
          });
        }
        if (
          !["GET", "HEAD"].includes(req.method || "GET") &&
          req.headers["x-fixture-202-csrf"] !== session.csrf
        )
          return error(403, "CSRF_INVALID", "인증 정보를 확인할 수 없습니다.");
        if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
          sessions.delete(sessionId);
          res.setHeader("Set-Cookie", [
            "auth-fixture-202-session=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax",
            "auth-fixture-202-csrf=; Max-Age=0; Path=/; SameSite=Lax",
          ]);
          return reply(204);
        }
        if (req.method === "PATCH" && url.pathname === "/v1/me/profile") {
          let body = "";
          try {
            req.setEncoding("utf8");
            for await (const chunk of req) {
              body += chunk;
              if (Buffer.byteLength(body, "utf8") > 4096)
                return error(413, "TOO_LARGE", "요청이 너무 큽니다.");
            }
            const value: unknown = JSON.parse(body).nickname;
            if (typeof value !== "string")
              return error(400, "INVALID_NICKNAME", "닉네임을 입력해 주세요.");
            const reason = nicknameProblem(value);
            if (reason)
              return reply(400, {
                code: "INVALID_NICKNAME",
                message: reason,
                fieldErrors: [{ field: "nickname", reason }],
              });
            if (normalizedNickname(value) === "이미사용중")
              return reply(409, {
                code: "NICKNAME_DUPLICATED",
                message: "닉네임을 확인해 주세요.",
                fieldErrors: [
                  { field: "nickname", reason: "이미 사용 중인 닉네임입니다." },
                ],
              });
            session.nickname = normalizedNickname(value);
            if (session.loseNicknameReply) {
              session.loseNicknameReply = false;
              // Start a response before breaking it; a pre-header disconnect can
              // be retried transparently by the browser's HTTP transport.
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": "1024",
                "Cache-Control": "no-store",
              });
              res.write('{"nickname":', () => res.destroy());
              return;
            }
            return reply(200, {
              memberId: `auth-fixture-202-${session.provider}`,
              nickname: session.nickname,
            });
          } catch {
            if (req.destroyed || res.destroyed) return;
            return error(400, "INVALID_BODY", "요청을 읽을 수 없습니다.");
          }
        }
        return error(
          404,
          "RESOURCE_NOT_FOUND",
          "이 테스트 응답에는 해당 기능이 없습니다.",
        );
      });
    },
  };
}
