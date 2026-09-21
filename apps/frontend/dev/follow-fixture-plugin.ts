import type { Plugin } from "vite";
export function followFixturePlugin(): Plugin {
  const follows = new Map<
    string,
    { kind: "MEMBER" | "STAR"; id: string; label: string }
  >();
  return {
    name: "follow-fixture-219",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", (req, res, next) => {
        const url = new URL(req.url || "/", "http://localhost");
        const send = (body: unknown, status = 200) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(body));
        };
        const relation = url.pathname.match(
          /^\/v1\/me\/following\/(members|stars)\/([^/]+)$/,
        );
        const summary = url.pathname.match(
          /^\/v1\/members\/([^/]+)\/follow-summary$/,
        );
        const list = url.pathname.match(
          /^\/v1\/me\/(followers|following\/(members|stars))$/,
        );
        if (summary && req.method === "GET")
          return send({
            memberId: summary[1],
            followers:
              summary[1] === "u-209"
                ? 1
                : Number(follows.has("MEMBER:" + summary[1])),
            followingMembers: [...follows.values()].filter(
              (t) => t.kind === "MEMBER",
            ).length,
            followingStars: [...follows.values()].filter(
              (t) => t.kind === "STAR",
            ).length,
          });
        if (relation) {
          const kind = relation[1] === "members" ? "MEMBER" : "STAR",
            id = decodeURIComponent(relation[2]),
            key = kind + ":" + id;
          if (
            req.method !== "GET" &&
            req.headers["x-csrf-token"] !== "community-fixture-209"
          )
            return send({ code: "CSRF_INVALID", message: "CSRF 확인" }, 403);
          if (id === "u-209")
            return send(
              {
                code: "FOLLOW_SELF",
                message: "자기 자신은 팔로우할 수 없습니다.",
              },
              400,
            );
          if (id === "missing")
            return send(
              {
                code: "FOLLOW_TARGET_UNAVAILABLE",
                message: "대상을 확인할 수 없습니다.",
              },
              404,
            );
          if (req.method === "PUT")
            follows.set(key, {
              kind,
              id,
              label: kind === "STAR" ? "TOI-270" : "탐사자 " + id,
            });
          else if (req.method === "DELETE") follows.delete(key);
          else if (req.method !== "GET") return next();
          return send({ kind, id, following: follows.has(key) });
        }
        if (list && req.method === "GET")
          return send({
            items:
              list[1] === "followers"
                ? [{ kind: "MEMBER", id: "u-211", label: "별을읽는사람" }]
                : [...follows.values()].filter(
                    (t) =>
                      t.kind === (list[2] === "members" ? "MEMBER" : "STAR"),
                  ),
            nextCursor: null,
            hasNext: false,
          });
        if (
          url.pathname === "/v1/community/following-feed" &&
          req.method === "GET"
        ) {
          const matchedBy = [
            ...new Set([...follows.values()].map((t) => t.kind)),
          ];
          return send({
            items: matchedBy.length
              ? [
                  {
                    type: "POST",
                    id: "p-201",
                    ticId: "259377017",
                    title: "반복되는 밝기 감소를 함께 살펴봐요",
                    author: { memberId: "u-211", nickname: "별을읽는사람" },
                    commentCount: 22,
                    createdAt: "2026-09-21T01:00:00Z",
                    matchedBy,
                  },
                ]
              : [],
            nextCursor: null,
            hasNext: false,
          });
        }
        next();
      });
    },
  };
}
