import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, DomainError } from "../server/store";
import { TUTORIALS } from "../server/fixtures";
import { MapIndex } from "../server/spatial-index";
import { rephase } from "../shared/replay";
import type { Judgment, StarNode } from "../shared/types";
test("HIS-02 harmonic replay restores original selected period and interval width", () => {
  const s = setup();
  const h = s.submit("tester", {
    starId: TUTORIALS[0].id,
    period: 7.2,
    phaseStart: 0.2,
    phaseEnd: 0.3,
    judgment: "LIKELY_PLANET",
    requestId: "harmonic",
  });
  assert.equal(h.period, 3.6);
  assert.equal(h.originalPeriod, 7.2);
  const phase = rephase(h, h.referenceTime);
  assert.ok(Math.abs(phase.phaseStart! - 0.2) < 1e-9);
  assert.ok(Math.abs(phase.phaseEnd! - 0.3) < 1e-9);
});
function setup() {
  const s = new Store();
  s.addUser("tester", "테스터");
  return s;
}
test("COM-11 return checks current TIC and visibility without changing histories", () => {
  const s = setup();
  const h = submit(s);
  const saved = JSON.stringify(s.state.histories);
  const input = {
    title: "별 토론",
    body: "복귀 검증",
    tag: "DISCUSSION" as const,
    starId: h.starId,
    attachments: [],
    sources: [],
  };
  const p = s.savePost("tester", input);
  assert.equal(s.postDetail("tester", p.id, h.starId).post.id, p.id);
  s.savePost("tester", { ...input, starId: TUTORIALS[1].id }, p.id);
  assert.throws(
    () => s.postDetail("tester", p.id, h.starId),
    (e) =>
      e instanceof DomainError &&
      e.code === "RETURN_STAR_MISMATCH" &&
      e.status === 409,
  );
  assert.equal(s.postDetail("tester", p.id).post.starId, TUTORIALS[1].id);
  s.state.posts.find((post) => post.id === p.id)!.hidden = true;
  assert.throws(
    () => s.postDetail("tester", p.id, TUTORIALS[1].id),
    (e) => e instanceof DomainError && e.status === 404,
  );
  s.state.posts.find((post) => post.id === p.id)!.hidden = false;
  s.deletePost("tester", p.id);
  assert.throws(
    () => s.postDetail("tester", p.id, TUTORIALS[1].id),
    (e) => e instanceof DomainError && e.status === 404,
  );
  assert.equal(JSON.stringify(s.state.histories), saved);
});
function submit(
  s: Store,
  id: string = TUTORIALS[0].id,
  j: Judgment = "LIKELY_PLANET",
  retryOf?: string,
  signal = 0,
) {
  return s.submit("tester", {
    starId: id,
    period: s.star(id).signals[signal].period,
    phaseStart: 0.25,
    phaseEnd: 0.35,
    judgment: j,
    retryOf,
    requestId: s.id("req"),
  });
}
function unconfirmed() {
  const s = setup(),
    id = "910000002";
  s.unlock("tester", id, "achievement", TUTORIALS[0].id, null);
  return { s, id };
}
test("HOME-02 first login has tutorial 1 only; locked analysis and detail rejected", () => {
  const s = setup();
  assert.deepEqual(Object.keys(s.user("tester").stars), [TUTORIALS[0].id]);
  assert.throws(
    () => s.analysis("tester", TUTORIALS[1].id),
    (e) => e instanceof DomainError && e.code === "STAR_LOCKED",
  );
  assert.throws(() => s.detail("tester", "900000099"));
});
test("HOME-02/GRD-08 one unique achievement opens one random existing star", () => {
  const s = setup(),
    h = submit(s);
  assert.equal(h.achievementResult, "recognized");
  assert.equal(s.dto("tester", h.starId).grade, "A");
  assert.equal(
    Object.values(s.user("tester").stars).filter(
      (p) => p.node.source === "achievement",
    ).length,
    1,
  );
  assert.ok(s.user("tester").stars[TUTORIALS[1].id]);
  assert.equal(s.dto("tester", h.starId).status, "complete");
  const before = Object.keys(s.user("tester").stars);
  submit(s, h.starId, "LIKELY_PLANET", h.id);
  assert.deepEqual(Object.keys(s.user("tester").stars), before);
});
test("SUB-11 wrong judgment completes numerical exploration without achievement; confirmed orbit remains", () => {
  const s = setup(),
    h = submit(s, TUTORIALS[0].id, "UNLIKELY_PLANET"),
    n = s.dto("tester", h.starId);
  assert.equal(n.status, "complete");
  assert.equal(n.achievementCount, 0);
  assert.equal(n.planetCount, 1);
  assert.equal(h.achievementResult, "judgment_mismatch");
});
test("SUB-10 uncertain then correct retry preserves original and grants once", () => {
  const s = setup(),
    h = submit(s, TUTORIALS[0].id, "UNSURE"),
    copy = JSON.stringify(s.state.histories.find((x) => x.id === h.id));
  const next = submit(s, h.starId, "LIKELY_PLANET", h.id);
  assert.notEqual(next.id, h.id);
  assert.equal(next.achievementResult, "recognized");
  assert.equal(
    JSON.stringify(s.state.histories.find((x) => x.id === h.id)),
    copy,
  );
  assert.equal(s.dto("tester", h.starId).status, "complete");
});
test("GRD-01 combined FP performance can reach S and opens one per signal", () => {
  const s = setup(),
    id = TUTORIALS[4].id;
  s.unlock("tester", id, "tutorial", TUTORIALS[3].id, null);
  submit(s, id, "UNLIKELY_PLANET", undefined, 0);
  submit(s, id, "UNLIKELY_PLANET", undefined, 1);
  const n = s.dto("tester", id);
  assert.equal(n.grade, "S");
  assert.equal(n.typeCounts.fp, 2);
  assert.equal(n.planetCount, 0);
  assert.equal(n.status, "complete");
  assert.equal(
    Object.values(s.user("tester").stars).filter(
      (p) => p.node.source === "achievement",
    ).length,
    2,
  );
});
test("NFR-02 duplicate request ID creates only one immutable submission", () => {
  const s = setup(),
    input = {
      starId: TUTORIALS[0].id,
      period: 3.6,
      phaseStart: 0.2,
      phaseEnd: 0.3,
      judgment: "LIKELY_PLANET" as const,
      requestId: "same",
    };
  const a = s.submit("tester", input),
    b = s.submit("tester", input);
  assert.equal(a.id, b.id);
  assert.equal(s.histories("tester").total, 1);
});
test("SUB-12 skip requires counted failure threshold and detailed explanation", () => {
  const s = setup(),
    id: string = TUTORIALS[0].id;
  for (let n = 0; n < 3; n++)
    s.submit("tester", {
      starId: id,
      period: 31.123,
      phaseStart: 0.2,
      phaseEnd: 0.3,
      judgment: "UNSURE",
      requestId: "wrong" + n,
    });
  assert.equal(s.canSkip("tester", id), true);
  assert.throws(() => s.skip("tester", id));
  s.reveal("tester", s.histories("tester").items[0].id);
  s.skip("tester", id);
  assert.equal(s.dto("tester", id).completionReason, "skipped");
  assert.equal(s.histories("tester").items[0].outcome, "skipped");
  assert.equal(s.dto("tester", id).achievementCount, 0);
  assert.ok(s.user("tester").stars[TUTORIALS[1].id]);
});
test("SUB-12 matching UNSURE does not count; judgment mismatch does; production 0 disables skip", () => {
  const s = setup(),
    id: string = TUTORIALS[0].id,
    h = submit(s, id, "UNSURE");
  submit(s, id, "UNSURE", h.id);
  submit(s, id, "UNSURE", h.id);
  assert.equal(s.canSkip("tester", id), false);
  for (let n = 0; n < 3; n++) submit(s, id, "UNLIKELY_PLANET", h.id);
  assert.equal(s.canSkip("tester", id), true);
  s.skipAfter = 0;
  assert.equal(s.canSkip("tester", id), false);
});
test("COM-18/19 unpublished does not award; any explicit public judgment awards once; cancellation preserves", () => {
  const { s, id } = unconfirmed(),
    h = submit(s, id, "UNSURE");
  assert.equal(s.dto("tester", id).achievementCount, 0);
  const p = s.publish("tester", h.id);
  assert.equal(s.dto("tester", id).achievementCount, 1);
  assert.equal(s.dto("tester", id).planetCount, 0);
  const nodes = Object.keys(s.user("tester").stars);
  s.publish("tester", h.id, false);
  s.publish("tester", h.id, true);
  assert.deepEqual(Object.keys(s.user("tester").stars), nodes);
  assert.equal(
    s.state.publications.filter((a) => a.historyId === h.id).length,
    1,
  );
  assert.equal(
    s.state.posts.filter((t) => t.signalId === h.signalId).length,
    1,
  );
  assert.equal(
    s.state.comments.filter((c) => c.postId === p.threadId).length,
    0,
  );
  assert.throws(() => s.react("tester", p.threadId, "agree"));
});
test("COM-14 public latest is submission time, not publish time; cancel falls back", () => {
  const { s, id } = unconfirmed(),
    a = submit(s, id, "LIKELY_PLANET");
  const b = submit(s, id, "UNSURE", a.id);
  s.state.histories.find((h) => h.id === a.id)!.submittedAt =
    "2026-09-08T00:00:00Z";
  s.state.histories.find((h) => h.id === b.id)!.submittedAt =
    "2026-09-09T00:00:00Z";
  const before = s.distribution(a.signalId!);
  s.publish("tester", b.id);
  s.publish("tester", a.id);
  let d = s.distribution(a.signalId!);
  assert.equal(d.counts.UNSURE, before.counts.UNSURE + 1);
  s.publish("tester", b.id, false);
  d = s.distribution(a.signalId!);
  assert.equal(d.counts.LIKELY_PLANET, before.counts.LIKELY_PLANET + 1);
});
test("COM-14 simultaneous submittedAt uses larger submission id", () => {
  const { s, id } = unconfirmed(),
    a = submit(s, id, "LIKELY_PLANET"),
    b = submit(s, id, "UNLIKELY_PLANET", a.id);
  s.state.histories.find((h) => h.id === a.id)!.submittedAt = b.submittedAt;
  const before = s.distribution(a.signalId!);
  s.publish("tester", a.id);
  s.publish("tester", b.id);
  assert.equal(
    s.distribution(a.signalId!).counts.UNLIKELY_PLANET,
    before.counts.UNLIKELY_PLANET + 1,
  );
});
test("COM-14 scored denominator uses first matching member regardless of later recognition", () => {
  const s = setup(),
    id: string = TUTORIALS[0].id,
    h = submit(s, id, "UNLIKELY_PLANET");
  submit(s, id, "LIKELY_PLANET", h.id);
  const d = s.distribution(h.signalId!);
  assert.equal(d.kind, "scored");
  assert.equal(d.total, 1);
  assert.equal(d.percent, 0);
});
test("HIS-02 replay uses latest Bundle + absolute epoch; snapshot float32 has 150 bins", () => {
  const s = setup(),
    h = submit(s),
    snap = JSON.stringify(h.snapshot);
  s.state.bundleId = "fixture-v2";
  const r = s.replay("tester", h.id);
  assert.equal(r.bundleId, "fixture-v2");
  assert.equal(r.referenceTime, 1513.25);
  assert.ok(Math.abs(r.phaseStart! - h.phaseStart!) > 0.01);
  assert.equal(JSON.stringify(s.history("tester", h.id).snapshot), snap);
  assert.equal(h.snapshot?.length, 150);
  assert.equal(h.snapshot?.[1][0], Math.fround(h.snapshot![1][0]));
  assert.equal(s.analysis("tester", h.starId, h.id).bundleId, "fixture-v2");
});
test("SUB-10 retired target blocks retry; retired removed set falls back", () => {
  const s = setup(),
    id = TUTORIALS[4].id;
  s.unlock("tester", id, "tutorial", null, null);
  const h = submit(s, id, "UNLIKELY_PLANET");
  const next = submit(s, id, "UNLIKELY_PLANET", undefined, 1);
  s.star(id).signals[0].retired = true;
  assert.equal(s.history("tester", h.id).retired, true);
  assert.ok(s.analysis("tester", id, h.id).readOnlyReason);
  assert.throws(() => submit(s, id, "UNLIKELY_PLANET", h.id));
  assert.equal(s.history("tester", next.id).restoreFallback, true);
});
test("COM-20 own same-TIC attachment and source only; free post has neither", () => {
  const s = setup(),
    h = submit(s),
    input = {
      title: "test",
      body: "test",
      tag: "QUESTION" as const,
      starId: h.starId,
      attachments: [h.id],
      sources: [],
    };
  assert.ok(s.savePost("tester", input));
  assert.throws(() => s.savePost("tester", { ...input, starId: null }));
  assert.throws(() => s.savePost("tester", { ...input, starId: "900000099" }));
  assert.throws(() => s.savePost("peer-sky", input));
});
test("COM-20 attachment grants selected history only; hiding parent revokes access", () => {
  const s = setup(),
    h = submit(s),
    p = s.savePost("tester", {
      title: "test",
      body: "selected",
      tag: "QUESTION",
      starId: h.starId,
      attachments: [h.id],
      sources: [],
    });
  assert.equal(s.attachment("peer-sky", p.id, h.id).id, h.id);
  assert.throws(() => s.history("peer-sky", h.id));
  const unrelated = submit(s, h.starId, "UNSURE", h.id);
  assert.throws(() => s.attachment("peer-sky", p.id, unrelated.id));
  s.state.posts.find((x) => x.id === p.id)!.hidden = true;
  assert.throws(() => s.attachment("peer-sky", p.id, h.id));
});
test("COM-13/18 hidden public analysis and parent never expose source content", () => {
  const { s, id } = unconfirmed(),
    h = submit(s, id),
    p = s.publish("tester", h.id);
  s.state.publications.find((x) => x.id === p.id)!.hidden = true;
  assert.equal(s.sourceCard({ kind: "analysis", id: p.id }).available, false);
  assert.throws(() => s.publish("tester", h.id));
  s.state.publications.find((x) => x.id === p.id)!.hidden = false;
  s.state.posts.find((t) => t.id === p.threadId)!.hidden = true;
  assert.equal(s.sourceCard({ kind: "analysis", id: p.id }).available, false);
  assert.equal(
    s.sourceCard({ kind: "thread", id: p.threadId }).available,
    false,
  );
});
test("COM-08 reactions own post, change, cancel; nickname reflects immediately", () => {
  const s = setup(),
    p = s.savePost("tester", {
      title: "test",
      body: "text",
      tag: "DISCUSSION",
      starId: null,
      attachments: [],
      sources: [],
    });
  s.react("tester", p.id, "agree");
  s.react("tester", p.id, "disagree");
  assert.equal(s.postDetail("tester", p.id).post.agree, 0);
  assert.equal(s.postDetail("tester", p.id).post.disagree, 1);
  s.updateProfile("tester", { nickname: "바뀐이름" });
  assert.equal(s.reactors("tester", p.id, "disagree")[0].nickname, "바뀐이름");
  assert.equal(s.postDetail("tester", p.id).post.author, "바뀐이름");
  s.react("tester", p.id, null);
  assert.equal(s.postDetail("tester", p.id).post.disagree, 0);
});
test("COM-05/06 general and single-level comment ownership enforced", () => {
  const s = setup(),
    p = s.savePost("tester", {
      title: "test",
      body: "text",
      tag: "DISCUSSION",
      starId: null,
      attachments: [],
      sources: [],
    });
  assert.throws(() => s.deletePost("peer-sky", p.id));
  const c = s.saveComment("tester", p.id, {
    body: "reply",
    attachments: [],
    sources: [],
  });
  assert.throws(() => s.deleteComment("peer-sky", c.id));
  s.deleteComment("tester", c.id);
  assert.equal(s.postDetail("tester", p.id).comments.length, 0);
  s.deletePost("tester", p.id);
  assert.throws(() => s.postDetail("tester", p.id));
});
test("MY-02 only submitted stars, no silent page-size truncation; reopen sorted first", () => {
  const s = setup();
  for (const star of s.catalogue.slice(6, 41)) {
    s.unlock("tester", star.id, "achievement", null, null);
    submit(s, star.id, "UNSURE");
  }
  assert.equal(s.listStars("tester", { submittedOnly: true }).total, 35);
  assert.equal(
    s.listStars("tester", { submittedOnly: true, page: 2 }).items.length,
    15,
  );
  s.reopen("910000000");
  assert.equal(
    s.listStars("tester", { submittedOnly: true }).items[0].id,
    "910000000",
  );
  assert.ok(s.listStars("tester", { submittedOnly: true }).items[0].reopenedAt);
});
test("ACC-05 duplicate/banned nickname validation and MY-04 privacy default true", () => {
  const s = setup();
  assert.equal(s.profile("peer-sky", "tester").publicStars, true);
  assert.throws(() => s.updateProfile("tester", { nickname: "지웅" }));
  assert.throws(() => s.updateProfile("tester", { nickname: "관리자" }));
  s.updateProfile("tester", {
    settings: { publicStars: false, notifications: {} },
  });
  assert.equal(s.profile("peer-sky", "tester").publicStars, false);
});
test("NTF-01 follow notifications obey setting", () => {
  const s = setup();
  s.follow("tester", "star", "900000099", true);
  const p = {
    title: "follow test",
    body: "new post",
    tag: "QUESTION" as const,
    starId: "900000099",
    attachments: [],
    sources: [],
  };
  s.savePost("peer-sky", p);
  const n = s.user("tester").notifications.length;
  assert.ok(n > 0);
  s.user("tester").member.settings.notifications.follow = false;
  s.savePost("peer-sky", p);
  assert.equal(s.user("tester").notifications.length, n);
});
test("STA-03 ignores inactive members in median; no invalid evidence", () => {
  const s = setup();
  assert.throws(() =>
    s.submit("tester", {
      starId: TUTORIALS[0].id,
      period: 3.6,
      phaseStart: 0.2,
      phaseEnd: 0.3,
      judgment: "LIKELY_PLANET",
      evidence: ["중심 위치"],
      requestId: "bad",
    }),
  );
  const before = s.statistics("tester").baseline;
  s.addUser("idle", "휴면사용자");
  assert.deepEqual(s.statistics("tester").baseline, before);
});
test("rephase preserves interval width across wrap boundary", () => {
  const p = rephase(
    { period: 10, epoch: 1510, duration: 2, phaseStart: 0.1, phaseEnd: 0.3 },
    1500,
  );
  assert.ok(Math.abs(p.phaseStart! - 0.9) < 1e-9);
  assert.ok(Math.abs(p.phaseEnd! - 1.1) < 1e-9);
});
export function mapPoints(count: number): StarNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    name: "TIC " + i,
    x: (i % 317) * 91 + 13,
    y: Math.floor(i / 317) * 91 + 13,
    generation: 1,
    angle: 0,
    status: i % 5 === 0 ? "complete" : "unexplored",
    completionReason: null,
    planetCount: i % 20 === 0 ? 5 : 0,
    achievementCount: 0,
    grade: "—",
    typeCounts: { fp: 0, unconfirmed: 0, confirmed: 0 },
    matchedCount: 0,
    curveStep: 0,
    unpublishedCount: 0,
    hasFp: false,
    tutorial: null,
    challenge: false,
    reopenedAt: null,
    lastActivity: "",
    source: "achievement",
    parentId: null,
    sourceAchievementId: null,
    foundAt: "",
  }));
}
test("NFR-20 100k hierarchy budgets, viewport selection and incremental branch update", () => {
  const points = mapPoints(100000),
    index = new MapIndex(points);
  assert.equal(index.count, 100000);
  for (const zoom of [0.001, 0.005, 0.01, 0.03, 0.1, 0.4, 0.8, 1, 8]) {
    const nodes = index.view(index.bounds, zoom);
    assert.ok(nodes.filter((n) => n.star).length <= 400);
    assert.ok(nodes.filter((n) => !n.star).length <= 80);
    assert.equal(
      nodes.reduce((n, p) => n + p.count, 0),
      100000,
    );
  }
  const root = index.root;
  index.upsert({ ...points[500], planetCount: 4 });
  assert.equal(index.root, root);
  assert.ok(index.updatedBranches < 50);
  index.upsert({ ...points[0], id: "new", x: 99999 });
  assert.equal(index.count, 100001);
  assert.ok(index.updatedBranches < 50);
  const near = index.view({ x: 0, y: 0, w: 500, h: 500 }, 8);
  assert.ok(near.length < 100);
  assert.ok(
    near.every((n) => n.x >= 0 && n.x <= 500 && n.y >= 0 && n.y <= 500),
  );
});
test("DEC-32 nearby points cluster under .8; normal cluster diameter <=46px", () => {
  const p = mapPoints(2);
  p[0].x = 13;
  p[0].y = 13;
  p[1].x = 33;
  p[1].y = 13;
  const index = new MapIndex(p);
  const coarse = index.groups(0.7);
  assert.equal(coarse.length, 1);
  assert.equal(coarse[0].count, 2);
  assert.ok(Math.hypot(coarse[0].bounds.w, coarse[0].bounds.h) * 0.7 <= 46);
  assert.equal(index.groups(0.8).length, 2);
});
