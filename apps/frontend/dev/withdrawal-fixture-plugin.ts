import type { Plugin } from "vite";
export function withdrawalFixturePlugin(): Plugin {
  const requests = new Map<string, string>();
  let completed = false;
  return {
    name: "withdrawal-fixture-222",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        const path = new URL(req.url || "/", "http://localhost").pathname;
        const send = (body: unknown, status = 200) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(body));
        };
        if (path === "/v1/me" && req.method === "GET" && completed)
          return send(
            { code: "UNAUTHORIZED", message: "검증 계정 세션 종료" },
            401,
          );
        if (path === "/v1/me/withdrawal-policy" && req.method === "GET")
          return send({
            available: true,
            version: "test-only-policy-1",
            effects: ["검증용 임시 계정의 로그인 상태만 종료됩니다."],
            retention: [
              "이 문구는 로컬 화면 검증용이며 실제 데이터 보관 정책이 아닙니다.",
            ],
            rejoining: ["실제 재가입 정책은 아직 승인되지 않았습니다."],
          });
        const status = path.match(/^\/v1\/withdrawal-requests\/([^/]+)$/);
        if (status && req.method === "GET")
          return requests.has(status[1])
            ? send({
                requestId: status[1],
                status: requests.get(status[1]),
                message:
                  requests.get(status[1]) === "COMPLETED"
                    ? "검증용 처리 결과입니다. 실제 회원을 삭제하지 않았습니다."
                    : "검증용 요청입니다.",
              })
            : send(
                { code: "NOT_FOUND", message: "확인할 요청이 없습니다." },
                404,
              );
        if (
          !path.startsWith("/v1/me/withdrawal-requests") ||
          req.method !== "POST"
        )
          return next();
        if (req.headers["x-csrf-token"] !== "community-fixture-209")
          return send({ code: "CSRF_INVALID", message: "CSRF 확인" }, 403);
        let body = "";
        for await (const chunk of req) body += chunk;
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          return send({ code: "VALIDATION_FAILED", message: "요청 확인" }, 400);
        }
        if (data.policyVersion !== "test-only-policy-1")
          return send(
            {
              code: "POLICY_CHANGED",
              message: "정책이 바뀌었습니다. 다시 확인해 주세요.",
            },
            409,
          );
        if (path === "/v1/me/withdrawal-requests") {
          const id = "test-request";
          if (!requests.has(id)) requests.set(id, "READY");
          return send({
            requestId: id,
            status: requests.get(id),
            message: "테스트 준비 완료",
          });
        }
        if (
          path === "/v1/me/withdrawal-requests/test-request/confirm" &&
          data.confirmation === "탈퇴" &&
          requests.has("test-request")
        ) {
          requests.set("test-request", "COMPLETED");
          completed = true;
          return send({
            requestId: "test-request",
            status: "COMPLETED",
            message: "검증 세션 종료",
          });
        }
        send({ code: "VALIDATION_FAILED", message: "확인 내용 불일치" }, 400);
      });
    },
  };
}
