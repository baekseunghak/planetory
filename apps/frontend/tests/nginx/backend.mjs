// Synthetic responses only; no OAuth provider, credentials, or database.
import { createServer } from "node:http";

createServer((request, response) => {
  const url = new URL(request.url, "http://backend:8080");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname.startsWith("/oauth2/authorization/")) {
    response.writeHead(302, {
      Location: "/login/oauth2/code/google?status=503",
    });
    response.end();
    return;
  }
  const status = Number(
    url.searchParams.get("status") ??
      (url.pathname === "/api/v1/me" ? 401 : 200),
  );
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (status === 302) {
      response.writeHead(302, {
        Location: "/oauth/callback",
        "Set-Cookie": "test-session=synthetic; Path=/; HttpOnly; SameSite=Lax",
      });
    } else {
      response.writeHead(status, { "Content-Type": "application/json" });
    }
    response.end(
      JSON.stringify({
        code: status === 503 ? "DEPENDENCY_UNAVAILABLE" : "TEST_RESPONSE",
        uri: request.url,
        method: request.method,
        body: Buffer.concat(chunks).toString(),
        host: request.headers.host,
        proto: request.headers["x-forwarded-proto"],
        forwardedHost: request.headers["x-forwarded-host"],
        csrf: request.headers["x-csrf-token"],
      }),
    );
  });
}).listen(8080, "0.0.0.0");
