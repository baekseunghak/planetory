import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { Store, DomainError, type State, type SubmissionInput } from "./store";
import { prepareGalaxyDemo, galaxyData } from "./galaxy-demo";
import { MapIndex } from "./spatial-index";
import type { SourceRef, Tag } from "../shared/types";
const location = resolve(
  process.env.FIXTURE_STATE_PATH || ".local/galaxy-state.json",
);
mkdirSync(dirname(location), { recursive: true });
let saved: State | undefined;
try {
  if (process.env.FIXTURE_RESET !== "1" && existsSync(location))
    saved = JSON.parse(readFileSync(location, "utf8"));
} catch {
  console.warn(
    "Local fixture state could not be read; using new fixture state.",
  );
}
export const store = new Store(saved);
prepareGalaxyDemo(store);
store.skipAfter = Number(process.env.TUTORIAL_SKIP_AFTER ?? 3);
store.persist = () => {
  writeFileSync(location + ".tmp", JSON.stringify(store.state));
  renameSync(location + ".tmp", location);
};
store.persist();
const sessions = new Map<string, string>(),
  oauthStates = new Map<
    string,
    { provider: "ssafy" | "google"; returnTo: string }
  >(),
  indices = new Map<string, { version: number; index: MapIndex }>();
function map(uid: string) {
  let cached = indices.get(uid);
  if (!cached) {
    cached = {
      version: store.state.version,
      index: new MapIndex(
        Object.keys(store.user(uid).stars).map((id) => store.dto(uid, id)),
      ),
    };
    indices.set(uid, cached);
  } else if (cached.version !== store.state.version) {
    for (const id of Object.keys(store.user(uid).stars))
      cached.index.upsert(store.dto(uid, id));
    cached.version = store.state.version;
  }
  return cached.index;
}
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
};
async function body(req: IncomingMessage) {
  let content = "";
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 1000000)
      throw new DomainError(413, "TOO_LARGE", "요청 내용이 너무 큽니다.");
  }
  return content ? JSON.parse(content) : {};
}
const sessionKey = (req: IncomingMessage) =>
  req.headers.cookie?.match(/(?:^|;\s*)planetory_galaxy_fixture=([^;]+)/)?.[1];
export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1:58242"),
      path = url.pathname
        .replace(/^\/api/, "")
        .split("/")
        .filter(Boolean),
      q = Object.fromEntries(url.searchParams),
      method = req.method || "GET";
    if (!url.pathname.startsWith("/api/"))
      return send(res, 404, {
        code: "NOT_FOUND",
        message: "API 경로를 확인해 주세요.",
      });
    if (
      method !== "GET" &&
      req.headers.origin &&
      ![
        "http://127.0.0.1:" + (process.env.CLIENT_PORT || "58241"),
        "http://localhost:58241",
        "http://127.0.0.1:58242",
      ].includes(req.headers.origin)
    )
      throw new DomainError(403, "ORIGIN_DENIED", "허용되지 않은 출처입니다.");
    const key = sessionKey(req),
      uid = key ? sessions.get(key) : undefined;
    if (path[0] === "session" && method === "GET")
      return send(res, 200, {
        member: uid ? store.user(uid).member : null,
        mode: "local-fixture",
      });
    if (
      path[0] === "auth" &&
      ["ssafy", "google"].includes(path[1]) &&
      method === "GET"
    ) {
      const state = randomUUID();
      oauthStates.set(state, {
        provider: path[1] as "ssafy" | "google",
        returnTo:
          q.returnTo?.startsWith("/") && !q.returnTo.startsWith("//")
            ? q.returnTo
            : "/sky",
      });
      res.writeHead(302, {
        Location: "/oauth/callback?code=fixture&state=" + state,
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    if (path[0] === "auth" && path[1] === "callback" && method === "POST") {
      const input = await body(req),
        state = oauthStates.get(input.state);
      if (!state)
        throw new DomainError(
          400,
          "OAUTH_STATE_INVALID",
          "로그인 요청이 만료되었습니다. 다시 시작해 주세요.",
        );
      oauthStates.delete(input.state);
      const id = state.provider === "ssafy" ? "seojin" : "google-seojin";
      store.addUser(
        id,
        id === "seojin" ? "서진" : "서진의 Google 계정",
        state.provider,
      );
      const token = randomUUID();
      sessions.set(token, id);
      store.touch();
      res.setHeader(
        "Set-Cookie",
        "planetory_galaxy_fixture=" +
          token +
          "; HttpOnly; SameSite=Lax; Path=/api",
      );
      return send(res, 200, {
        member: store.user(id).member,
        returnTo: state.returnTo,
      });
    }
    if (!uid)
      throw new DomainError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    const u = store.user(uid),
      input = method !== "GET" ? await body(req) : {};
    if (path[0] === "logout") {
      if (key) sessions.delete(key);
      res.setHeader(
        "Set-Cookie",
        "planetory_galaxy_fixture=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0",
      );
      return send(res, 200, { ok: true });
    }
    if (path[0] === "me") {
      if (path[1] === "guide") {
        u.member.firstVisit = false;
        store.touch();
        return send(res, 200, { ok: true });
      }
      if (path[1] === "settings" || path[1] === "profile")
        return send(res, 200, store.updateProfile(uid, input));
      if (path[1] === "withdraw")
        throw new DomainError(
          409,
          "POLICY_UNDECIDED",
          "탈퇴 시 기록 처리 정책이 아직 확정되지 않았습니다. 계정 정보와 연결은 유지됩니다.",
        );
      return send(res, 200, store.profile(uid, uid));
    }
    if (path[0] === "members") {
      if (path[2] === "stars") {
        if (path[1] !== uid && !store.user(path[1]).member.settings.publicStars)
          throw new DomainError(
            403,
            "PROFILE_PRIVATE",
            "비공개 별 목록입니다.",
          );
        return send(
          res,
          200,
          store.listStars(path[1], { ...q, submittedOnly: true }),
        );
      }
      return send(res, 200, store.profile(uid, path[1]));
    }
    if (path[0] === "follows")
      return send(
        res,
        200,
        store.follow(uid, input.kind, input.id, !!input.active),
      );
    if (path[0] === "notifications") {
      if (method === "POST") {
        for (const n of u.notifications)
          if (!input.id || n.id === input.id) n.read = true;
        store.touch();
      }
      return send(res, 200, {
        items: u.notifications.map((n) => ({
          ...n,
          unavailable: n.target.startsWith("/community/posts/")
            ? !store.state.posts.some(
                (p) =>
                  "/community/posts/" + p.id === n.target &&
                  !p.deleted &&
                  !p.hidden,
              )
            : false,
        })),
      });
    }
    if (path[0] === "quests") return send(res, 200, store.quests(uid));
    if (path[0] === "map") {
      if (path[1] === "galaxy") return send(res, 200, galaxyData(store, uid));
      const index = map(uid);
      if (path[1] === "manifest")
        return send(res, 200, {
          bounds: index.bounds,
          count: index.count,
          revision: store.state.version,
          overview: index.groups(0.001),
          tileSize: 512,
        });
      const zoom = Math.max(0.001, Math.min(8, Number(q.zoom) || 1));
      const bounds = {
        x: Number(q.x) || 0,
        y: Number(q.y) || 0,
        w: Number(q.w) || 1000,
        h: Number(q.h) || 700,
      };
      if (!Number.isFinite(bounds.x + bounds.y + bounds.w + bounds.h))
        throw new DomainError(
          400,
          "INVALID_BOUNDS",
          "지도 범위를 확인해 주세요.",
        );
      const keys = (q.keys || "").split(";").filter(Boolean).slice(0, 100);
      const tileNodes = index.tiles(keys, zoom);
      const allowed = new Set(index.view(bounds, zoom).map((n) => n.id));
      const nodes = tileNodes.filter((n) => allowed.has(n.id));
      // Parent groups can span multiple tiles; ensure a coarser budget node is included once.
      for (const n of index.view(bounds, zoom))
        if (!nodes.some((x) => x.id === n.id)) nodes.push(n);
      return send(res, 200, { nodes, revision: store.state.version, keys });
    }
    if (path[0] === "stars") {
      if (!path[1])
        return send(
          res,
          200,
          store.listStars(uid, {
            ...q,
            submittedOnly: q.submittedOnly === "true",
          }),
        );
      if (path[2] === "skip") return send(res, 200, store.skip(uid, path[1]));
      if (path[2] === "analysis")
        return send(res, 200, store.analysis(uid, path[1], q.retry));
      if (path[2] === "results") {
        const d = store.detail(uid, path[1]);
        if (!d.historyCount)
          throw new DomainError(
            404,
            "NO_RESULTS",
            "아직 제출한 기록이 없습니다.",
          );
        return send(res, 200, {
          star: d,
          histories: store.histories(uid, { starId: path[1], pageSize: 100 })
            .items,
          newStars: store
            .listStars(uid, { pageSize: 100 })
            .items.filter((n) => n.parentId === path[1]),
          threads: store.feed(uid, { starId: path[1], kind: "system_thread" })
            .items,
        });
      }
      return send(res, 200, store.detail(uid, path[1]));
    }
    if (path[0] === "submissions" && method === "POST")
      return send(res, 200, store.submit(uid, input as SubmissionInput));
    if (path[0] === "history") {
      if (!path[1]) return send(res, 200, store.histories(uid, q));
      if (path[2] === "replay")
        return send(res, 200, store.replay(uid, path[1]));
      if (path[2] === "reveal")
        return send(res, 200, store.reveal(uid, path[1]));
      if (path[2] === "distribution") {
        const h = store.history(uid, path[1]);
        return send(
          res,
          200,
          h.signalId ? store.distribution(h.signalId) : null,
        );
      }
      return send(res, 200, store.history(uid, path[1]));
    }
    if (path[0] === "publications") {
      if (path[1] === "destinations" && method === "GET")
        return send(res, 200, {
          items: store.publicationDestinations(uid, q.starId),
        });
      if (path[1] === "batch") {
        const items = [];
        for (const id of input.ids || []) {
          try {
            items.push({
              id,
              status: "published",
              publication: store.publish(uid, id, true),
            });
          } catch (e) {
            items.push({ id, status: "failed", message: (e as Error).message });
          }
        }
        return send(res, 200, { items });
      }
      if (method === "POST")
        return send(
          res,
          200,
          store.publish(uid, input.historyId, input.active !== false),
        );
      const p = store.state.publications.find((p) => p.id === path[1]);
      if (!p || !store.publicationVisible(p))
        throw new DomainError(
          404,
          "CONTENT_UNAVAILABLE",
          "현재 볼 수 없는 공개 분석입니다.",
        );
      if (path[2] === "replay")
        return send(res, 200, store.replay(p.memberId, p.historyId));
      return send(res, 200, {
        publication: p,
        author: {
          id: p.memberId,
          nickname: store.user(p.memberId).member.nickname,
        },
        history: store.publicHistory(p.memberId, p.historyId),
        distribution: store.distribution(p.signalId),
      });
    }
    if (path[0] === "community") {
      if (path[1] === "attachment") {
        const h = store.attachment(uid, q.postId, q.historyId, q.commentId);
        return send(
          res,
          200,
          q.replay === "true"
            ? store.replay(h.memberId, h.id)
            : store.publicHistory(h.memberId, h.id),
        );
      }
      if (path[1] === "stars") {
        const ids = Object.values(store.state.users).flatMap((u) =>
          Object.keys(u.stars),
        );
        return send(res, 200, {
          items: [...new Set(ids)]
            .filter((id) => !q.q || id.includes(q.q))
            .slice(0, 100)
            .map((id) => ({
              id,
              name: "TIC " + id,
              canAnalyze: !!u.stars[id],
            })),
        });
      }
      if (path[1] === "sources") {
        store.accessibleStar(q.starId);
        return send(res, 200, {
          items: [
            ...store.state.posts
              .filter(
                (p) =>
                  p.starId === q.starId &&
                  p.kind === "system_thread" &&
                  store.postVisible(p),
              )
              .map((p) => store.sourceCard({ kind: "thread", id: p.id })),
            ...store.state.publications
              .filter(
                (p) => p.starId === q.starId && store.publicationVisible(p),
              )
              .map((p) => store.sourceCard({ kind: "analysis", id: p.id })),
          ],
        });
      }
      if (path[1] === "source")
        return send(
          res,
          200,
          store.sourceCard({ kind: q.kind as SourceRef["kind"], id: q.id }),
        );
      if (path[1] === "posts") {
        if (!path[2])
          return send(
            res,
            200,
            method === "POST" ? store.savePost(uid, input) : store.feed(uid, q),
          );
        if (path[3] === "comments")
          return send(
            res,
            200,
            store.saveComment(uid, path[2], input, path[4]),
          );
        if (path[3] === "reaction")
          return send(res, 200, store.react(uid, path[2], input.value));
        if (path[3] === "reactors")
          return send(res, 200, {
            items: store.reactors(uid, path[2], q.value),
          });
        return send(
          res,
          200,
          method === "DELETE"
            ? store.deletePost(uid, path[2])
            : method === "PATCH"
              ? store.savePost(uid, input, path[2])
              : store.postDetail(uid, path[2], q.returnStarId),
        );
      }
      if (path[1] === "comments" && method === "DELETE")
        return send(res, 200, store.deleteComment(uid, path[2]));
    }
    if (path[0] === "statistics") return send(res, 200, store.statistics(uid));
    throw new DomainError(
      404,
      "NOT_FOUND",
      "요청한 화면의 자료를 찾을 수 없습니다.",
    );
  } catch (error) {
    const e = error as Error;
    send(res, error instanceof DomainError ? error.status : 500, {
      code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
      message:
        error instanceof DomainError
          ? e.message
          : "자료를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    });
    if (!(error instanceof DomainError)) console.error(error);
  }
});
server.listen(Number(process.env.PORT) || 58242, "127.0.0.1", () =>
  console.log(
    "Planetory local fixture API on http://127.0.0.1:" +
      (Number(process.env.PORT) || 58242),
  ),
);
