import type { Plugin } from "vite";
export function notificationsFixturePlugin(): Plugin {
  const notices = [
    {
      notificationId: "n-comment",
      kind: "COMMENT",
      createdAt: "2026-09-21T02:00:00Z",
      read: false,
      available: true,
      title: "탐사 기록에 새 댓글이 달렸습니다",
      body: "함께 관측한 내용을 확인해 보세요.",
    },
    {
      notificationId: "n-achievement",
      kind: "ACHIEVEMENT",
      createdAt: "2026-09-21T01:00:00Z",
      read: false,
      available: true,
      title: "새로운 성과가 인정되었습니다",
      body: "TOI-270에서 발견한 행성을 확인하세요.",
    },
    {
      notificationId: "n-hidden",
      kind: "FOLLOW",
      createdAt: "2026-09-20T01:00:00Z",
      read: true,
      available: false,
      title: "",
      body: "",
    },
  ];
  return {
    name: "notifications-fixture-220",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", (req, res, next) => {
        const url = new URL(req.url || "/", "http://localhost");
        if (!url.pathname.startsWith("/v1/me/notifications")) return next();
        const send = (body: unknown, status = 200) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(body));
        };
        const count = () => ({
          unreadCount: notices.filter((n) => !n.read).length,
        });
        if (req.method === "GET") {
          if (url.pathname === "/v1/me/notifications/unread-count")
            return send(count());
          if (url.pathname === "/v1/me/notifications")
            return send({
              items: notices.filter(
                (n) => url.searchParams.get("unreadOnly") !== "true" || !n.read,
              ),
              hasNext: false,
              nextCursor: null,
              readBoundary: "preview-boundary-1",
            });
          const match = url.pathname.match(
            /^\/v1\/me\/notifications\/([^/]+)\/target$/,
          );
          if (match) {
            const row = notices.find((n) => n.notificationId === match[1]);
            if (!row)
              return send({ code: "NOT_FOUND", message: "알림 없음" }, 404);
            return send({
              notificationId: row.notificationId,
              available: row.available,
              target: !row.available
                ? null
                : row.kind === "COMMENT"
                  ? { kind: "POST", postId: "p-201" }
                  : { kind: "STAR", ticId: "259377017" },
            });
          }
        }
        if (req.method === "PATCH") {
          if (req.headers["x-csrf-token"] !== "community-fixture-209")
            return send({ code: "CSRF_INVALID", message: "CSRF 확인" }, 403);
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const value = JSON.parse(body);
              if (url.pathname === "/v1/me/notifications/read") {
                if (value.through !== "preview-boundary-1")
                  return send(
                    { code: "VALIDATION_FAILED", message: "잘못된 경계" },
                    400,
                  );
                notices.forEach((n) => (n.read = true));
                return send(count());
              }
              const row = notices.find(
                (n) =>
                  url.pathname === "/v1/me/notifications/" + n.notificationId,
              );
              if (!row)
                return send({ code: "NOT_FOUND", message: "알림 없음" }, 404);
              if (value.read !== true)
                return send(
                  { code: "VALIDATION_FAILED", message: "true만 허용" },
                  400,
                );
              row.read = true;
              send({ notificationId: row.notificationId, read: true });
            } catch {
              send({ code: "VALIDATION_FAILED", message: "잘못된 요청" }, 400);
            }
          });
          return;
        }
        next();
      });
    },
  };
}
