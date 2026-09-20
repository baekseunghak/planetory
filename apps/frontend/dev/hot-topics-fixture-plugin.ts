import type { Plugin } from "vite";

// S18 HTTP contract samples only; no claim of real DB aggregation validation.
// Summary mutations represent responses after the backend re-aggregates.
const epoch = "2026-09-20T00:00:00Z";
function initialRows() {
  return Array.from({ length: 24 }, (_, i) => ({
    type: "SIGNAL_THREAD" as const,
    id: String(9007199254741000n + BigInt(i)),
    ticId: i === 0 ? "307210830" : "259377017",
    title:
      [
        "오래된 관측에서도 계속되는 토론",
        "같은 신호를 서로 다른 시선으로",
        "주기가 짧은 밝기 감소를 함께 살펴봐요",
        "열 번째 탐사자가 함께한 신호",
        "아직 아홉 명이 살펴본 신호",
      ][i] ?? `함께 확인하는 신호 · ${i + 1}`,
    author: { type: "SYSTEM" as const, displayName: "SYSTEM" as const },
    createdAt:
      i === 0 ? "2025-01-01T00:00:00Z" : i < 3 ? epoch : "2026-08-01T00:00:00Z",
    commentCount: i === 4 ? 1000 : 2,
    judgmentSummary: {
      participantCount: i < 3 ? 11 : i === 4 ? 9 : 10,
      likelyPlanet: i < 3 ? 5 : i === 4 ? 3 : 4,
      unlikelyPlanet: 3,
      unsure: 3,
    },
    hotReasons: ["JUDGMENT_THRESHOLD"],
  }));
}

export function hotTopicsFixturePlugin(): Plugin {
  let rows = initialRows();
  const hidden = new Set<string>();
  let failure = 0;
  return {
    name: "hot-topics-fixture-218",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const id =
          path.match(/^\/v1\/signal-threads\/([^/]+)/)?.[1] ??
          url.searchParams.get("parentId");
        const control = path.startsWith("/dev-hot-topics-218/");
        const list = path === "/v1/community/hot-topics";
        if (!control && !list && !rows.some((row) => row.id === id))
          return next();
        const send = (value: unknown, status = 200) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        const missing = () =>
          send(
            {
              code: "RESOURCE_NOT_FOUND",
              message: "자료를 찾을 수 없거나 볼 수 없습니다.",
            },
            404,
          );
        const invalid = () =>
          send(
            {
              code: "VALIDATION_FAILED",
              message: "목록의 처음 페이지에서 다시 확인해 주세요.",
            },
            400,
          );
        if (control && req.method === "POST") {
          const target = rows.find(
            (row) => row.id === url.searchParams.get("id"),
          );
          if (path.endsWith("/reset")) {
            rows = initialRows();
            hidden.clear();
            failure = 0;
          } else if (path.endsWith("/fail"))
            failure = Number(url.searchParams.get("status"));
          else if (path.endsWith("/empty"))
            rows.forEach((row) => hidden.add(row.id));
          else if (target) {
            if (path.endsWith("/hide")) hidden.add(target.id);
            else if (path.endsWith("/restore")) hidden.delete(target.id);
            else if (path.endsWith("/summary")) {
              const likelyPlanet = Number(url.searchParams.get("likelyPlanet"));
              const unlikelyPlanet = Number(
                url.searchParams.get("unlikelyPlanet"),
              );
              const unsure = Number(url.searchParams.get("unsure"));
              if (
                ![likelyPlanet, unlikelyPlanet, unsure].every(
                  (n) => Number.isSafeInteger(n) && n >= 0,
                )
              )
                return invalid();
              target.judgmentSummary = {
                participantCount: likelyPlanet + unlikelyPlanet + unsure,
                likelyPlanet,
                unlikelyPlanet,
                unsure,
              };
            } else if (path.endsWith("/comments")) target.commentCount = 9999;
            else return missing();
          } else return missing();
          return send({ ok: true });
        }
        if (req.method !== "GET") return missing();
        if (list) {
          if (failure)
            return send(
              {
                code: failure === 403 ? "FORBIDDEN" : "DEPENDENCY_UNAVAILABLE",
                message: "핫 토픽을 확인할 수 없습니다.",
              },
              failure,
            );
          const selected = rows
            .filter(
              (row) =>
                !hidden.has(row.id) &&
                row.judgmentSummary.participantCount >= 10,
            )
            .sort(
              (a, b) =>
                b.judgmentSummary.participantCount -
                  a.judgmentSummary.participantCount ||
                b.createdAt.localeCompare(a.createdAt) ||
                (BigInt(a.id) < BigInt(b.id) ? 1 : -1),
            );
          const cursor = url.searchParams.get("cursor");
          if (cursor && !/^hot-218-page:\d+$/.test(cursor)) return invalid();
          const offset = cursor ? Number(cursor.split(":")[1]) : 0;
          if (!Number.isSafeInteger(offset)) return invalid();
          const end = offset + 20;
          return send({
            items: selected.slice(offset, end),
            hasNext: end < selected.length,
            nextCursor: end < selected.length ? `hot-218-page:${end}` : null,
          });
        }
        const row = rows.find((row) => row.id === id);
        if (!row || hidden.has(row.id)) return missing();
        if (path === "/v1/comments")
          return send({ items: [], nextCursor: null, hasNext: false });
        if (path.endsWith("/analyses")) {
          // Only current records in this sample; each participant is distinct.
          const s = row.judgmentSummary;
          const items = Array.from({ length: s.participantCount }, (_, i) => ({
            analysisId: `pa-hot-218-${row.id}-${i}`,
            author: {
              memberId: `u-hot-218-${i}`,
              nickname: `공개 탐사자 ${i + 1}`,
            },
            submittedAt: epoch,
            judgment:
              i < s.likelyPlanet
                ? "LIKELY_PLANET"
                : i < s.likelyPlanet + s.unlikelyPlanet
                  ? "UNLIKELY_PLANET"
                  : "UNSURE",
            contributesToSummary: true,
          })).filter(
            (a) =>
              !url.searchParams.has("judgment") ||
              a.judgment === url.searchParams.get("judgment"),
          );
          return send({ items, nextCursor: null, hasNext: false });
        }
        const s = row.judgmentSummary;
        return send({
          ...row,
          threadId: row.id,
          candidateId: `c-hot-218-${row.id}`,
          judgmentSummary: {
            ...s,
            asOf: epoch,
            percentages: s.participantCount
              ? {
                  likelyPlanet: (s.likelyPlanet / s.participantCount) * 100,
                  unlikelyPlanet: (s.unlikelyPlanet / s.participantCount) * 100,
                  unsure: (s.unsure / s.participantCount) * 100,
                }
              : null,
          },
        });
      });
    },
  };
}
