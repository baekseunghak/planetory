import type { Plugin } from "vite";
import { searchFixtureFeed } from "./search-fixture.ts";

// Development HTTP samples only. Imported exclusively by Vite serve mode.
const date = "2026-09-18T01:00:00Z";
const author = { memberId: "u-209", nickname: "관측자" };
const summary = {
  participantCount: 15,
  likelyPlanet: 8,
  unlikelyPlanet: 4,
  unsure: 3,
  percentages: { likelyPlanet: 53.3, unlikelyPlanet: 26.7, unsure: 20 },
  asOf: date,
};
const emptySummary = {
  participantCount: 0,
  likelyPlanet: 0,
  unlikelyPlanet: 0,
  unsure: 0,
  percentages: null,
  asOf: date,
};
const system = { type: "SYSTEM", displayName: "SYSTEM" };
const titles = [
  "반복되는 밝기 감소를 함께 살펴봐요",
  "첫 탐사를 마치고 남기는 기록",
  "관측 회차가 달라지면 무엇이 달라질까요?",
];
const posts = Array.from({ length: 24 }, (_, index) => ({
  postId: `p-${201 + index}`,
  title: `${titles[index % titles.length]} · ${index + 1}`,
  body: "빛이 일정한 간격으로 작아지는 구간을 발견했습니다.\n\n같은 신호를 살펴본 분들의 이야기가 궁금합니다. 관측 자료를 비교하면서 생각을 나눠 보고 싶어요.",
  purposeTag: "DISCUSSION",
  ticId: index % 3 === 1 ? null : "259377017",
  author,
  attachments: [] as unknown[],
  sourceLinks: [] as unknown[],
  reactionSummary: { agree: 0, disagree: 0, myReaction: "NONE" },
  commentCount: index === 0 ? 22 : 0,
  createdAt: date,
  updatedAt: date,
}));
const threads = [
  {
    threadId: "st-301",
    ticId: "259377017",
    candidateId: "c-401",
    title: "TIC 259377017 · 함께 관측한 반복 신호",
    author: system,
    judgmentSummary: summary,
  },
  {
    threadId: "st-302",
    ticId: "259377017",
    candidateId: "c-402",
    title: "TIC 259377017 · 새 신호의 첫 이야기",
    author: system,
    judgmentSummary: emptySummary,
  },
];
const analyses = Array.from({ length: 23 }, (_, index) => ({
  analysisId: `pa-${601 + index}`,
  author: {
    memberId: `u-${301 + (index % 15)}`,
    nickname: `탐사자 ${(index % 15) + 1}`,
  },
  submittedAt: date,
  judgment:
    index < 15
      ? index < 8
        ? "LIKELY_PLANET"
        : index < 12
          ? "UNLIKELY_PLANET"
          : "UNSURE"
      : ["LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE"][(index - 15) % 3],
  contributesToSummary: index < 15,
}));

type CommunityFixtureOptions = {
  writable?: boolean;
  commentWrites?: boolean;
  reactionWrites?: boolean;
  materialWrites?: boolean;
  currentNickname?: () => string;
  searchable?: boolean;
};

export function communityFixturePlugin({
  writable = false,
  commentWrites = false,
  reactionWrites = false,
  materialWrites = false,
  currentNickname,
  searchable = false,
}: CommunityFixtureOptions = {}): Plugin {
  const validMaterials = (input: Record<string, unknown>, ticId: unknown) => {
    const ids = input.historyIds ?? [],
      sources = input.sourceLinks ?? [];
    if (
      !Array.isArray(ids) ||
      !Array.isArray(sources) ||
      ids.length > 3 ||
      sources.length > 3
    )
      return false;
    if ((ids.length || sources.length) && ticId !== "259377017") return false;
    return (
      new Set(ids).size === ids.length &&
      ids.every((id) => /^h-5(0[1-9]|1[0-9]|2[0-4])$/.test(String(id))) &&
      new Set(sources.map((s) => s.type + ":" + s.id)).size ===
        sources.length &&
      sources.every(
        (s) =>
          (s.type === "PUBLIC_ANALYSIS" &&
            analyses.some((a) => a.analysisId === s.id)) ||
          (s.type === "SIGNAL_THREAD" &&
            threads.some((t) => t.threadId === s.id)),
      )
    );
  };
  const records = structuredClone(posts);
  if (searchable) {
    records.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        ...structuredClone(posts[index]),
        postId: `p-${225 + index}`,
      })),
    );
    records[0] = {
      ...records[0],
      title: "TOI-270 · 10%_ 감소 + A&B",
      body: "빛 감소 기록입니다. 두  공백을 유지합니다.",
      purposeTag: "QUESTION",
      author: { memberId: "u-orbit-217", nickname: "Orbit" },
      createdAt: "2026-09-19T01:00:00Z",
    };
    records[1].title = "TOI-270 자유 이야기";
    records[1].purposeTag = "GENERAL";
  }
  const unavailable = new Set(searchable ? ["p-223", "p-224", "st-302"] : []);
  const materialPayload = (
    input: Record<string, unknown>,
    previous?: { attachments: unknown[]; sourceLinks: unknown[] },
  ) => ({
    attachments:
      input.historyIds === undefined
        ? (previous?.attachments ?? [])
        : (input.historyIds as string[]).map((historyId) => ({
            historyId,
            type: "HISTORY",
          })),
    sourceLinks:
      input.sourceLinks === undefined
        ? (previous?.sourceLinks ?? [])
        : (input.sourceLinks as object[]).map((s) => ({
            ...s,
            available: true,
          })),
  });
  if (materialWrites) {
    records[0].attachments = [{ historyId: "h-501", type: "HISTORY" }];
    records[0].sourceLinks = [
      { type: "PUBLIC_ANALYSIS", id: "pa-601", available: true },
    ];
  }

  const deleted = new Set<string>();
  let serial = 1000;
  const commentRows = new Map<
    string,
    {
      commentId: string;
      author: typeof author;
      body: string;
      attachments: unknown[];
      sourceLinks: unknown[];
      createdAt: string;
      updatedAt: string;
    }[]
  >();
  for (const [id, count] of [
    ["p-201", 22],
    ["st-301", 2],
  ] as const)
    commentRows.set(
      id,
      Array.from({ length: count }, (_, index) => ({
        commentId: `cm-${id}-${index}`,
        author,
        body: `다른 관측 회차의 신호도 비교해 보고 있습니다. 함께 확인해 주셔서 감사합니다. (${index + 1})`,
        attachments: [],
        sourceLinks: [],
        createdAt: date,
        updatedAt: date,
      })),
    );
  const choices = new Map<string, string>();
  const voters = Array.from({ length: 23 }, (_, i) => ({
    memberId: "u-voter-" + i,
    nickname: "반응 회원 " + (i + 1),
  }));
  const reaction = (id: string) => {
    const mine = choices.get(id) ?? "NONE";
    return {
      myReaction: mine,
      agree: 23 + (mine === "AGREE" ? 1 : 0),
      disagree: mine === "DISAGREE" ? 1 : 0,
    };
  };
  const deletedComments = new Set<string>();
  const parentExists = (type: string | null, id: string | null) =>
    type === "POST"
      ? records.some((row) => row.postId === id)
      : type === "SIGNAL_THREAD" && threads.some((row) => row.threadId === id);
  return {
    name: "community-fixture-209",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "div",
          attrs: {
            style:
              "padding:8px 28px;background:#142239;color:#c9dafa;font:12px system-ui",
            "data-testid": "community-fixture-notice",
          },
          children: searchable
            ? "217 개발 검증용 검색 · 합성 게시글이며 실제 검색 서버 연결 전입니다"
            : currentNickname
              ? "214 개발 검증용 프로필 · 실제 회원 데이터가 아닙니다"
              : materialWrites
                ? "213 개발 검증용 첨부 · 합성 자료이며 공용 그래프는 연결 전입니다"
                : reactionWrites
                  ? "212 개발 검증용 반응 · 실제 데이터가 아닙니다"
                  : commentWrites
                    ? "211 개발 검증용 댓글 · 실제 데이터가 아닙니다 · 서버 재시작 시 초기화"
                    : writable
                      ? "210 개발 검증용 데이터 · 실제 게시글이 아닙니다 · 서버 재시작 시 초기화"
                      : "209 개발 검증용 데이터 · 실제 게시글이 아닙니다",
          injectTo: "body-prepend",
        },
      ];
    },
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const url = new URL(req.url ?? "/", "http://localhost");
        const send = (value: unknown, status = 200) => {
          res.statusCode = status;
          res.end(
            JSON.stringify(value, (_key, item) =>
              currentNickname &&
              item &&
              typeof item === "object" &&
              item.memberId === "u-209"
                ? { ...item, nickname: currentNickname() }
                : item,
            ),
          );
        };
        const missing = () =>
          send(
            {
              code: "RESOURCE_NOT_FOUND",
              message: "자료를 찾을 수 없거나 볼 수 없습니다.",
            },
            404,
          );
        const paginate = (items: unknown[]) => {
          const cursor = url.searchParams.get("cursor");
          const context =
            url.pathname +
            "|" +
            [
              "board",
              "ticId",
              "parentType",
              "parentId",
              "judgment",
              "reaction",
              "size",
              ...(searchable ? ["q", "searchIn", "author", "tag"] : []),
            ]
              .map((key) => url.searchParams.get(key) ?? "")
              .map((value) => encodeURIComponent(value))
              .join("|");
          const prefix = Buffer.from(context).toString("base64url") + ":";
          const offset = cursor?.startsWith(prefix)
            ? Number(cursor.slice(prefix.length))
            : 0;
          if (
            cursor &&
            (!cursor.startsWith(prefix) ||
              !Number.isInteger(offset) ||
              offset < 0)
          ) {
            send(
              {
                code: "VALIDATION_FAILED",
                message: "목록의 처음부터 다시 확인해 주세요.",
              },
              400,
            );
            return;
          }
          const next = offset + 20;
          send({
            items: items.slice(offset, next),
            nextCursor: next < items.length ? prefix + next : null,
            hasNext: next < items.length,
          });
        };
        if (
          searchable &&
          req.method === "POST" &&
          url.pathname.startsWith("/dev-search-217/")
        ) {
          if (url.pathname.endsWith("/reset")) {
            unavailable.clear();
            ["p-223", "p-224", "st-302"].forEach((id) => unavailable.add(id));
            records[0].author.nickname = "Orbit";
          } else if (url.pathname.endsWith("/hide"))
            unavailable.add(url.searchParams.get("id") ?? "");
          else if (url.pathname.endsWith("/nickname"))
            records[0].author.nickname =
              url.searchParams.get("value") ?? "NewOrbit";
          send({ ok: true });
          return;
        }
        if (searchable) {
          const parent =
            url.pathname.match(
              /^\/v1\/(?:posts|signal-threads)\/([^/]+)/,
            )?.[1] ?? url.searchParams.get("parentId");
          if (parent && unavailable.has(parent)) {
            missing();
            return;
          }
        }
        if (
          materialWrites &&
          req.method === "GET" &&
          url.pathname === "/v1/me/histories"
        ) {
          paginate(
            url.searchParams.get("ticId") === "259377017"
              ? Array.from({ length: 24 }, (_, i) => ({
                  historyId: "h-" + (501 + i),
                  ticId: "259377017",
                  userJudgment: "UNSURE",
                  submittedAt: date,
                  publication: {
                    isPublic: false,
                    publicAnalysisId: null,
                    isModerationHidden: false,
                  },
                  achievementGranted: false,
                }))
              : [],
          );
          return;
        }
        if (
          materialWrites &&
          req.method === "GET" &&
          url.pathname === "/v1/source-cards"
        ) {
          const type = url.searchParams.get("type"),
            id = url.searchParams.get("id");
          if (
            url.searchParams.get("ticId") !== "259377017" ||
            !(
              (type === "PUBLIC_ANALYSIS" &&
                analyses.some((a) => a.analysisId === id)) ||
              (type === "SIGNAL_THREAD" &&
                threads.some((t) => t.threadId === id))
            )
          ) {
            missing();
            return;
          }
          send({
            type,
            id,
            ticId: "259377017",
            available: true,
            author,
            judgment: "UNSURE",
            submittedAt: date,
            judgmentSummary: summary,
          });
          return;
        }
        const attachment = url.pathname.match(
          /^\/v1\/(posts|comments)\/([^/]+)\/history-attachments\/([^/]+)$/,
        );
        if (materialWrites && req.method === "GET" && attachment) {
          const [, kind, parentId, historyId] = attachment;
          const parent =
            kind === "posts"
              ? records.find((p) => p.postId === parentId)
              : [...commentRows.values()]
                  .flat()
                  .find((c) => c.commentId === parentId);
          const commentParent =
            kind === "comments"
              ? [...commentRows].find(([, rows]) =>
                  rows.some((c) => c.commentId === parentId),
                )?.[0]
              : null;
          if (
            !parent ||
            !parent.attachments.some(
              (a) => (a as { historyId: string }).historyId === historyId,
            ) ||
            (commentParent &&
              !parentExists(
                commentParent.startsWith("p-") ? "POST" : "SIGNAL_THREAD",
                commentParent,
              ))
          ) {
            missing();
            return;
          }
          const submitted = url.searchParams.get("graphMode") === "SUBMITTED";
          send({
            parentType: kind === "posts" ? "POST" : "COMMENT",
            parentId,
            historyId,
            ticId: "259377017",
            submittedAt: date,
            judgment: "UNSURE",
            evidenceChecks: ["ushape"],
            memo: "213 합성 첨부 메모",
            graph: {
              historyId,
              reproduction: {
                submittedBundleId: "b-1",
                currentBundleId: "b-2",
                residualReproducible: true,
                fallbackReason: null,
              },
              selection: {
                userPeriodDays: 3.21,
                correctedPeriodDays: 3.21,
                harmonicMultiplier: 1,
                epochBtjd: 1684.02,
                durationHours: 2.4,
              },
              curve: submitted
                ? null
                : {
                    ticId: "259377017",
                    bundleId: "b-2",
                    curveContext: {
                      bundleId: "b-2",
                      curveStep: 0,
                      removedCandidateIds: [],
                      residualModelVersion: "rm-1",
                      periodogramConfigVersion: "pg-1",
                    },
                    foldReferenceTimeBtjd: 1683.35,
                    segments: [
                      {
                        segmentId: "seg-1",
                        sector: 14,
                        binningRevision: 1,
                        startBtjd: 1683.35,
                        binMinutes: 10,
                        nPoints: 4,
                        flux: [1, 0.99, null, 1.01],
                        fluxScatter: 0.001,
                        gaps: [[2, 2]],
                      },
                    ],
                  },
              snapshot:
                submitted && historyId !== "h-502"
                  ? {
                      bins: 150,
                      foldedFlux: Array(150).fill(1),
                      foldedError: Array(150).fill(0.001),
                    }
                  : null,
            },
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (
          writable &&
          ["POST", "PATCH", "DELETE"].includes(req.method ?? "") &&
          /^\/v1\/posts(?:\/[^/]+)?$/.test(url.pathname)
        ) {
          if (req.headers["x-csrf-token"] !== "community-fixture-209") {
            send(
              { code: "CSRF_INVALID", message: "인증 정보를 확인해 주세요." },
              403,
            );
            return;
          }
          const id = url.pathname.split("/")[3];
          const index = records.findIndex((post) => post.postId === id);
          if (req.method === "DELETE") {
            if (deleted.has(id)) {
              res.statusCode = 204;
              res.end();
              return;
            }
            if (index < 0) {
              missing();
              return;
            }
            deleted.add(id);
            records.splice(index, 1);
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method === "PATCH" && index < 0) {
            missing();
            return;
          }
          let input: Record<string, unknown>;
          try {
            let body = "";
            for await (const chunk of req) {
              body += String(chunk);
              if (body.length > 100_000) throw new Error();
            }
            input = JSON.parse(body);
            if (!input || Array.isArray(input) || typeof input !== "object")
              throw new Error();
          } catch {
            send(
              { code: "VALIDATION_FAILED", message: "입력을 확인해 주세요." },
              400,
            );
            return;
          }
          const values =
            req.method === "PATCH" ? { ...records[index], ...input } : input;
          if (materialWrites && !validMaterials(input, values.ticId)) {
            send(
              {
                code: "TIC_MISMATCH",
                message: "첨부 개수·중복·소유자·별을 확인해 주세요.",
              },
              400,
            );
            return;
          }
          const fields = [];
          if (
            typeof values.title !== "string" ||
            !values.title.trim() ||
            Array.from(values.title.trim()).length > 100 ||
            /[\r\n\u0085\u2028\u2029]/.test(values.title.trim())
          )
            fields.push({
              field: "title",
              reason: "제목은 1~100자로 입력해 주세요.",
            });
          if (
            typeof values.body !== "string" ||
            !values.body.trim() ||
            Array.from(values.body).length > 10_000
          )
            fields.push({
              field: "body",
              reason: "본문은 1~10,000자로 입력해 주세요.",
            });
          if (
            ![
              "ANALYSIS",
              "QUESTION",
              "DISCUSSION",
              "INFORMATION",
              "GENERAL",
            ].includes(String(values.purposeTag))
          )
            fields.push({
              field: "purposeTag",
              reason: "글 종류를 선택해 주세요.",
            });
          if (fields.length || !Object.keys(input).length) {
            send(
              {
                code: "VALIDATION_FAILED",
                message: "입력을 확인해 주세요.",
                fieldErrors: fields,
              },
              400,
            );
            return;
          }
          if (
            values.ticId !== null &&
            values.ticId !== undefined &&
            values.ticId !== "259377017"
          ) {
            send(
              {
                code: "RESOURCE_NOT_FOUND",
                message: "공개된 별 게시판을 찾을 수 없습니다.",
              },
              404,
            );
            return;
          }
          const now = new Date().toISOString();
          const post = {
            ...posts[0],
            ...(req.method === "PATCH"
              ? records[index]
              : { postId: `p-${++serial}`, commentCount: 0, createdAt: now }),
            title: (values.title as string).trim(),
            body: values.body as string,
            purposeTag: values.purposeTag as string,
            ticId: (values.ticId as string | null) ?? null,
            updatedAt: now,
            ...(materialWrites ? materialPayload(values) : {}),
          };
          if (req.method === "PATCH") {
            records[index] = post;
            send(post);
          } else {
            records.unshift(post);
            send({ postId: post.postId, createdAt: post.createdAt }, 201);
          }
          return;
        }
        if (
          commentWrites &&
          ["POST", "PATCH", "DELETE"].includes(req.method ?? "") &&
          /^\/v1\/comments(?:\/[^/]+)?$/.test(url.pathname)
        ) {
          if (req.headers["x-csrf-token"] !== "community-fixture-209") {
            send(
              { code: "CSRF_INVALID", message: "인증 정보를 확인해 주세요." },
              403,
            );
            return;
          }
          const id = url.pathname.split("/")[3];
          const entry = [...commentRows].find(([, rows]) =>
            rows.some((row) => row.commentId === id),
          );
          const item = entry?.[1].find((row) => row.commentId === id);
          if (req.method === "DELETE") {
            if (!item && !deletedComments.has(id)) {
              missing();
              return;
            }
            if (entry) {
              commentRows.set(
                entry[0],
                entry[1].filter((row) => row.commentId !== id),
              );
              const post = records.find((row) => row.postId === entry[0]);
              if (post) post.commentCount = commentRows.get(entry[0])!.length;
            }
            deletedComments.add(id);
            res.statusCode = 204;
            res.end();
            return;
          }
          let input: Record<string, unknown>;
          try {
            let body = "";
            for await (const chunk of req) {
              body += String(chunk);
              if (body.length > 100000) throw new Error();
            }
            input = JSON.parse(body);
          } catch {
            send(
              { code: "VALIDATION_FAILED", message: "입력을 확인해 주세요." },
              400,
            );
            return;
          }
          if (
            !input ||
            typeof input.body !== "string" ||
            !input.body.trim() ||
            Array.from(input.body).length > 2000
          ) {
            send(
              {
                code: "VALIDATION_FAILED",
                message: "댓글을 확인해 주세요.",
                fieldErrors: [
                  {
                    field: "body",
                    reason: "댓글은 1~2,000자로 입력해 주세요.",
                  },
                ],
              },
              400,
            );
            return;
          }
          const relatedId = entry?.[0] ?? String(input.parentId);
          const relatedTic =
            records.find((p) => p.postId === relatedId)?.ticId ??
            threads.find((t) => t.threadId === relatedId)?.ticId ??
            null;
          if (materialWrites && !validMaterials(input, relatedTic)) {
            send(
              {
                code: "TIC_MISMATCH",
                message: "첨부 개수·중복·소유자·별을 확인해 주세요.",
              },
              400,
            );
            return;
          }
          if (req.method === "PATCH") {
            if (
              !item ||
              !entry ||
              !parentExists(
                entry[0].startsWith("p-") ? "POST" : "SIGNAL_THREAD",
                entry[0],
              )
            ) {
              missing();
              return;
            }
            if (materialWrites)
              Object.assign(item, materialPayload(input, item));
            item.body = input.body;
            item.updatedAt = new Date().toISOString();
            send(item);
            return;
          }
          if (!parentExists(String(input.parentType), String(input.parentId))) {
            missing();
            return;
          }
          const parentId = String(input.parentId),
            now = new Date().toISOString();
          const row = {
            commentId: "c-" + ++serial,
            author,
            body: input.body,
            attachments: [],
            sourceLinks: [],
            createdAt: now,
            updatedAt: now,
            ...(materialWrites ? materialPayload(input) : {}),
          };
          commentRows.set(parentId, [
            row,
            ...(commentRows.get(parentId) ?? []),
          ]);
          const post = records.find((row) => row.postId === parentId);
          if (post) post.commentCount = commentRows.get(parentId)!.length;
          send({ commentId: row.commentId, createdAt: now }, 201);
          return;
        }
        const reactionMatch = url.pathname.match(
          /^\/v1\/posts\/([^/]+)\/(my-reaction|reactions)$/,
        );
        if (reactionWrites && reactionMatch) {
          const id = reactionMatch[1];
          if (!records.some((row) => row.postId === id)) {
            missing();
            return;
          }
          if (req.method === "GET" && reactionMatch[2] === "reactions") {
            const kind = url.searchParams.get("reaction");
            if (!["AGREE", "DISAGREE"].includes(kind ?? "")) {
              send(
                { code: "VALIDATION_FAILED", message: "반응 종류 확인" },
                400,
              );
              return;
            }
            paginate([
              ...(kind === "AGREE" ? voters : []),
              ...(choices.get(id) === kind ? [author] : []),
            ]);
            return;
          }
          if (req.method === "PUT" && reactionMatch[2] === "my-reaction") {
            if (req.headers["x-csrf-token"] !== "community-fixture-209") {
              send({ code: "CSRF_INVALID", message: "CSRF 확인" }, 403);
              return;
            }
            let input;
            try {
              let body = "";
              for await (const chunk of req) {
                body += String(chunk);
                if (body.length > 1000) throw new Error();
              }
              input = JSON.parse(body);
            } catch {
              send({ code: "VALIDATION_FAILED", message: "입력 확인" }, 400);
              return;
            }
            if (!["AGREE", "DISAGREE", "NONE"].includes(input?.reaction)) {
              send({ code: "VALIDATION_FAILED", message: "반응 값 확인" }, 400);
              return;
            }
            choices.set(id, input.reaction);
            send({ postId: id, ...reaction(id) });
            return;
          }
        }
        if (req.method !== "GET") {
          send(
            {
              code: "METHOD_NOT_ALLOWED",
              message: "조회 전용 검사 서버입니다.",
            },
            405,
          );
          return;
        }
        if (url.pathname === "/v1/me") {
          send({
            memberId: writable ? "u-209" : "community-fixture-member-209",
            nickname: writable ? "210 검증 계정" : "209 검증 계정",
            onboardingDone: true,
            tutorialCompleted: true,
          });
          return;
        }
        if (url.pathname === "/v1/auth/csrf") {
          send({ headerName: "X-CSRF-TOKEN", token: "community-fixture-209" });
          return;
        }
        if (url.pathname === "/v1/community/feed") {
          const board = url.searchParams.get("board"),
            ticId = url.searchParams.get("ticId");
          const feed = [
            ...threads.map((thread) => ({
              ...thread,
              id: thread.threadId,
              type: "SIGNAL_THREAD",
              createdAt: date,
              commentCount: thread.threadId === "st-301" ? 2 : 0,
              ...(searchable
                ? { body: "공식 요약: 빛 변화를 확인했습니다." }
                : {}),
            })),
            ...records.map((post) => ({
              ...post,
              id: post.postId,
              type: "POST",
            })),
          ];
          if (searchable) {
            const selected = searchFixtureFeed(
              feed.filter((item) => !unavailable.has(item.id)),
              url.searchParams,
            );
            if (!selected)
              send(
                {
                  code: "VALIDATION_FAILED",
                  message: "검색 조건을 확인해 주세요.",
                },
                400,
              );
            else paginate(selected);
            return;
          }
          paginate(
            feed.filter(
              (item) =>
                (!ticId || item.ticId === ticId) &&
                (!board ||
                  (board === "FREE"
                    ? item.ticId === null
                    : item.ticId !== null)),
            ),
          );
          return;
        }
        const postId = url.pathname.match(/^\/v1\/posts\/([^/]+)$/)?.[1];
        if (postId) {
          const post = records.find((value) => value.postId === postId);
          if (post)
            send(
              reactionWrites
                ? { ...post, reactionSummary: reaction(postId) }
                : post,
            );
          else missing();
          return;
        }
        const threadMatch = url.pathname.match(
          /^\/v1\/signal-threads\/([^/]+)(\/analyses)?$/,
        );
        if (threadMatch) {
          const thread = threads.find(
            (value) => value.threadId === threadMatch[1],
          );
          if (!thread) {
            missing();
            return;
          }
          if (threadMatch[2])
            paginate(
              thread.threadId === "st-302"
                ? []
                : analyses.filter(
                    (item) =>
                      !url.searchParams.get("judgment") ||
                      item.judgment === url.searchParams.get("judgment"),
                  ),
            );
          else send(thread);
          return;
        }
        if (url.pathname === "/v1/comments") {
          const id = url.searchParams.get("parentId"),
            type = url.searchParams.get("parentType");
          if (
            !(type === "POST"
              ? records.some((post) => post.postId === id)
              : type === "SIGNAL_THREAD" &&
                threads.some((thread) => thread.threadId === id))
          ) {
            missing();
            return;
          }
          paginate(commentRows.get(id!) ?? []);
          return;
        }
        missing();
      });
    },
  };
}
