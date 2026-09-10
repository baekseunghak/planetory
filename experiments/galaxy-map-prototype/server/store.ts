import type {
  Member,
  Signal,
  StarNode,
  StarDetail,
  History,
  Publication,
  Post,
  Comment,
  Judgment,
  SourceRef,
  Distribution,
  Profile,
  Notification,
  Metrics,
  Statistics,
  AnalysisContext,
  Page,
  Tag,
  Viewport,
} from "../shared/types";
import { EVIDENCE } from "../shared/types";
import { catalogue, curve, member, TUTORIALS, correct } from "./fixtures";
import { rephase, type Replay } from "../shared/replay";
import {
  readAnalysisView,
  type AnalysisViewState,
} from "../shared/analysis-contract";
import type { CatalogueStar } from "./fixtures";
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(message: string, status = 400, code = "INVALID_INPUT"): never {
  throw new DomainError(status, code, message);
}
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const grade = (n: number) =>
  n >= 4 ? "SSS" : n === 3 ? "SS" : n === 2 ? "S" : n === 1 ? "A" : "—";
const tags = ["DISCUSSION", "QUESTION", "OBSERVATION", "INFORMATION"];
const blankCounts = () => ({ LIKELY_PLANET: 0, UNLIKELY_PLANET: 0, UNSURE: 0 });
type StoredPost = Omit<
  Post,
  | "author"
  | "agree"
  | "disagree"
  | "myReaction"
  | "commentCount"
  | "followingAuthor"
  | "followingStar"
  | "canAnalyze"
>;
type StoredComment = Omit<Comment, "author">;
interface Progress {
  node: StarNode;
  matches: Record<string, { judgment: Judgment; historyId: string }>;
  achievements: Record<string, Signal["type"]>;
}
interface UserState {
  member: Member;
  stars: Record<string, Progress>;
  follows: string[];
  notifications: Notification[];
}
export interface State {
  schema: 1;
  users: Record<string, UserState>;
  histories: History[];
  publications: Publication[];
  posts: StoredPost[];
  comments: StoredComment[];
  reactions: Record<string, Record<string, "agree" | "disagree">>;
  requests: Record<string, unknown>;
  sequence: number;
  bundleId: string;
  version: number;
  challengeId: string;
  challengeStart: string;
  challengeEnd: string;
}
export interface SubmissionInput {
  starId: string;
  period?: number;
  phaseStart?: number;
  phaseEnd?: number;
  judgment?: Judgment;
  evidence?: string[];
  memo?: string;
  curveStep?: number;
  removedIds?: string[];
  viewport?: Viewport;
  foldedZoom?: number;
  analysisView?: AnalysisViewState;
  retryOf?: string;
  noCandidate?: boolean;
  requestId: string;
}
export class Store {
  catalogue: CatalogueStar[] = catalogue();
  state: State;
  skipAfter = 3;
  starsPerAchievement = 1;
  persist: () => void = () => {};
  constructor(state?: State) {
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    this.state = state || {
      schema: 1,
      users: {},
      histories: [],
      publications: [],
      posts: [],
      comments: [],
      reactions: {},
      requests: {},
      sequence: 0,
      bundleId: "fixture-2026-09-v1",
      version: 1,
      challengeId: "900000099",
      challengeStart: monday.toISOString(),
      challengeEnd: new Date(+monday + 7 * 86400000).toISOString(),
    };
    if (!state) this.seedPeers();
  }
  id(prefix: string) {
    return prefix + "-" + String(++this.state.sequence).padStart(8, "0");
  }
  touch() {
    this.state.version++;
    this.persist();
  }
  replay(uid: string, id: string): Replay {
    const h = this.history(uid, id),
      referenceTime = this.state.bundleId.endsWith("v1") ? 1500 : 1513.25;
    const selection = rephase(h, referenceTime),
      signal = h.signal;
    const phase = signal
      ? ((((signal.epoch - referenceTime) /
          (h.originalPeriod || h.period || signal.period)) %
          1) +
          1) %
        1
      : 0.3;
    return {
      ...selection,
      points: curve(
        h.originalPeriod || h.period || 3.6,
        signal ? signal.depth / 100 : 0.004,
        phase,
      ).map((row) => row.map(Math.fround)),
      bundleId: this.state.bundleId,
      referenceTime,
      restoreFallback: h.restoreFallback,
      removedIds: h.restoreFallback ? [] : h.removedIds,
    };
  }
  publicHistory(uid: string, id: string) {
    const { answerViewed, retryOf, viewport, ...fields } = this.history(
      uid,
      id,
    );
    return fields;
  }
  attachment(
    uid: string,
    postId: string,
    historyId: string,
    commentId?: string,
  ) {
    this.user(uid);
    const post = this.getPost(postId);
    const comment = commentId
      ? this.state.comments.find(
          (c) =>
            c.id === commentId &&
            c.postId === postId &&
            !c.hidden &&
            !c.deleted,
        )
      : null;
    const owner = commentId ? comment?.memberId : post.memberId;
    const ids = commentId ? comment?.attachments : post.attachments;
    if (!owner || !ids?.includes(historyId))
      fail("현재 볼 수 없는 첨부 자료입니다.", 404, "CONTENT_UNAVAILABLE");
    const h = this.history(owner, historyId);
    if (h.starId !== post.starId)
      fail("현재 볼 수 없는 첨부 자료입니다.", 404, "CONTENT_UNAVAILABLE");
    return h;
  }
  user(id: string) {
    return (
      this.state.users[id] ||
      fail("로그인이 필요합니다.", 401, "UNAUTHENTICATED")
    );
  }
  star(id: string) {
    return (
      this.catalogue.find((s) => s.id === id) ||
      fail("별을 찾을 수 없습니다.", 404, "NOT_FOUND")
    );
  }
  progress(uid: string, id: string) {
    return (
      this.user(uid).stars[id] ||
      fail("아직 못 찾은 별입니다.", 403, "STAR_LOCKED")
    );
  }
  accessibleStar(id: string) {
    this.star(id);
    if (!Object.values(this.state.users).some((u) => u.stars[id]))
      fail("아직 공개되지 않은 별입니다.", 404, "NOT_FOUND");
  }
  addUser(
    id: string,
    nickname: string,
    provider: "ssafy" | "google" = "ssafy",
  ) {
    if (this.state.users[id]) return this.state.users[id].member;
    this.state.users[id] = {
      member: member(id, nickname, provider),
      stars: {},
      follows: [],
      notifications: [],
    };
    this.unlock(id, TUTORIALS[0].id, "tutorial", null, null);
    return this.user(id).member;
  }
  unlock(
    uid: string,
    id: string,
    source: StarNode["source"],
    parentId: string | null,
    achievementId: string | null,
  ) {
    const u = this.user(uid);
    if (u.stars[id]) return u.stars[id].node;
    const parent = parentId ? u.stars[parentId]?.node : null;
    const gen = parent ? parent.generation + 1 : 0;
    let x = 0,
      y = 0,
      angle = 0;
    if (source === "challenge") {
      x = -230;
      y = 80;
    } else if (source === "tutorial") {
      const positions = [
        [0, 0],
        [140, -90],
        [-140, -90],
        [-145, 95],
        [145, 95],
      ];
      const n = TUTORIALS.findIndex((t) => t.id === id);
      [x, y] = positions[Math.max(0, n)];
      angle = Math.atan2(y, x);
    } else if (parent) {
      for (let attempt = 0; attempt < 1000; attempt++) {
        angle =
          parent.angle +
          Math.sin(this.state.sequence * 3.31 + attempt * 7.73) * 1.2;
        const radius = gen * 360 + attempt * 3 + 50 * Math.sin(attempt * 9.32);
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
        if (
          Object.values(u.stars).every(
            (p) => Math.hypot(p.node.x - x, p.node.y - y) >= 76,
          )
        )
          break;
      }
    }
    const timestamp = now();
    const t = TUTORIALS.find((t) => t.id === id);
    const node: StarNode = {
      id,
      name: "TIC " + id,
      x,
      y,
      generation: gen,
      angle,
      status: "unexplored",
      completionReason: null,
      planetCount: 0,
      achievementCount: 0,
      grade: "—",
      typeCounts: { confirmed: 0, fp: 0, unconfirmed: 0 },
      matchedCount: 0,
      curveStep: 0,
      unpublishedCount: 0,
      hasFp: false,
      tutorial: t?.number || null,
      challenge: source === "challenge",
      reopenedAt: null,
      lastActivity: timestamp,
      source,
      parentId,
      sourceAchievementId: achievementId,
      foundAt: timestamp,
    };
    u.stars[id] = { node, matches: {}, achievements: {} };
    return node;
  }
  dto(uid: string, id: string): StarNode {
    const p = this.progress(uid, id),
      signals = this.star(id).signals;
    const displayed = signals.filter(
      (s) =>
        p.matches[s.id] &&
        (s.type === "confirmed" ||
          (s.type === "unconfirmed" &&
            p.matches[s.id].judgment === "LIKELY_PLANET")),
    );
    const values = Object.values(p.achievements);
    const unpublished = new Set(
      this.state.histories
        .filter(
          (h) =>
            h.memberId === uid &&
            h.starId === id &&
            h.type === "unconfirmed" &&
            h.signalId &&
            !this.state.publications.some(
              (p) => p.historyId === h.id && p.active && !p.hidden,
            ),
        )
        .map((h) => h.signalId),
    );
    return {
      ...p.node,
      planetCount: displayed.length,
      matchedCount: Object.keys(p.matches).length,
      curveStep: Object.keys(p.matches).length,
      achievementCount: values.length,
      grade: grade(values.length),
      typeCounts: {
        confirmed: values.filter((v) => v === "confirmed").length,
        fp: values.filter((v) => v === "fp").length,
        unconfirmed: values.filter((v) => v === "unconfirmed").length,
      },
      unpublishedCount: unpublished.size,
      hasFp: signals.some((s) => s.type === "fp" && p.matches[s.id]),
    };
  }
  detail(uid: string, id: string): StarDetail {
    const s = this.star(id),
      p = this.progress(uid, id);
    return {
      ...this.dto(uid, id),
      sectors: s.sectors,
      magnitude: s.magnitude,
      historyCount: this.state.histories.filter(
        (h) => h.memberId === uid && h.starId === id,
      ).length,
      knownSignals: s.signals
        .filter((s) => p.matches[s.id])
        .map((s) => ({ ...clone(s), judgment: p.matches[s.id].judgment })),
      following: this.user(uid).follows.includes("star:" + id),
      fixture: true,
    };
  }
  listStars(
    uid: string,
    options: {
      query?: string;
      status?: string;
      grade?: string;
      submittedOnly?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
  ): Page<StarNode> {
    let list = Object.keys(this.user(uid).stars).map((id) => this.dto(uid, id));
    if (options.submittedOnly) {
      const submitted = new Set(
        this.state.histories
          .filter((h) => h.memberId === uid)
          .map((h) => h.starId),
      );
      list = list.filter((n) => submitted.has(n.id));
    }
    if (options.query) list = list.filter((n) => n.id.includes(options.query!));
    if (options.status && options.status !== "all")
      list = list.filter((n) => n.status === options.status);
    if (options.grade && options.grade !== "all")
      list = list.filter((n) => n.grade === options.grade);
    list.sort(
      (a, b) =>
        b.lastActivity.localeCompare(a.lastActivity) ||
        a.id.localeCompare(b.id),
    );
    return this.page(list, options);
  }
  page<T>(items: T[], o: { page?: number; pageSize?: number } = {}): Page<T> {
    const page = Math.max(1, Number(o.page) || 1),
      pageSize = Math.min(100, Math.max(1, Number(o.pageSize) || 20));
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize,
    };
  }
  quests(uid: string) {
    const u = this.user(uid);
    return {
      tutorials: TUTORIALS.map((t) => ({
        id: t.id,
        number: t.number,
        purpose: t.purpose,
        state: !u.stars[t.id]
          ? "locked"
          : u.stars[t.id].node.completionReason === "skipped"
            ? "skipped"
            : u.stars[t.id].node.status === "unexplored"
              ? "ready"
              : u.stars[t.id].node.status,
      })),
      challenge: {
        id: this.state.challengeId,
        start: this.state.challengeStart,
        end: this.state.challengeEnd,
        description: "아직 확인 안 된 신호를 함께 살펴보세요.",
        participants: new Set(
          this.state.histories
            .filter((h) => h.starId === this.state.challengeId)
            .map((h) => h.memberId),
        ).size,
        unlocked: !!u.stars[this.state.challengeId],
        status: u.stars[this.state.challengeId]?.node.status || "unexplored",
      },
      reopened: Object.keys(u.stars)
        .filter((id) => u.stars[id].node.reopenedAt)
        .map((id) => this.dto(uid, id)),
    };
  }
  profile(viewer: string, target: string): Profile {
    const u = this.user(target),
      stars = Object.keys(u.stars).map((id) => this.dto(target, id));
    return {
      member: {
        id: target,
        nickname: u.member.nickname,
        joinedAt: u.member.joinedAt,
      },
      own: viewer === target,
      publicStars: u.member.settings.publicStars,
      following: this.user(viewer).follows.includes("member:" + target),
      followers: Object.values(this.state.users).filter((x) =>
        x.follows.includes("member:" + target),
      ).length,
      followingCount: u.follows.length,
      found: stars.length,
      completed: stars.filter((s) => s.status === "complete").length,
      signals: stars.reduce((n, s) => n + s.matchedCount, 0),
      grades: Object.fromEntries(
        ["A", "S", "SS", "SSS"].map((g) => [
          g,
          stars.filter((s) => s.grade === g).length,
        ]),
      ),
    };
  }
  updateProfile(
    uid: string,
    body: { nickname?: string; settings?: Member["settings"] },
  ) {
    const u = this.user(uid);
    if (body.nickname !== undefined) {
      const nickname = body.nickname.trim();
      if (
        nickname.length < 2 ||
        nickname.length > 20 ||
        /system|admin|운영자|관리자|[<>]/i.test(nickname)
      )
        fail("닉네임은 2~20자이며 금칙어를 사용할 수 없습니다.");
      if (
        Object.values(this.state.users).some(
          (x) => x.member.id !== uid && x.member.nickname === nickname,
        )
      )
        fail("이미 사용 중인 닉네임입니다.", 409, "NICKNAME_TAKEN");
      u.member.nickname = nickname;
    }
    if (body.settings) {
      u.member.settings.publicStars = !!body.settings.publicStars;
      for (const k of Object.keys(u.member.settings.notifications))
        if (k in body.settings.notifications)
          u.member.settings.notifications[k] = !!body.settings.notifications[k];
    }
    this.touch();
    return clone(u.member);
  }
  notify(uid: string, kind: string, message: string, target: string) {
    const u = this.user(uid);
    if (u.member.settings.notifications[kind] === false) return;
    u.notifications.unshift({
      id: this.id("notice"),
      kind,
      message,
      target,
      createdAt: now(),
      read: false,
      unavailable: false,
    });
  }
  follow(uid: string, kind: "member" | "star", id: string, active: boolean) {
    if (kind === "star") this.accessibleStar(id);
    else {
      this.user(id);
      if (id === uid) fail("본인을 팔로우할 수 없습니다.");
    }
    const u = this.user(uid),
      key = kind + ":" + id;
    u.follows = u.follows.filter((x) => x !== key);
    if (active) u.follows.push(key);
    this.touch();
    return { active };
  }
  award(uid: string, id: string, signal: Signal) {
    const p = this.progress(uid, id);
    if (p.achievements[signal.id]) return false;
    p.achievements[signal.id] = signal.type;
    const achievementId = uid + ":" + signal.id;
    for (let i = 0; i < this.starsPerAchievement; i++) {
      const candidates = this.catalogue.filter(
        (s) =>
          !this.user(uid).stars[s.id] &&
          !TUTORIALS.some((t) => t.id === s.id) &&
          s.id !== this.state.challengeId &&
          s.signals.some((s) => s.discoverable && !s.retired),
      );
      if (candidates.length) {
        const selected =
          candidates[
            (this.state.sequence * 1777 +
              Object.keys(p.achievements).length * 97) %
              candidates.length
          ];
        this.unlock(uid, selected.id, "achievement", id, achievementId);
      }
    }
    this.notify(
      uid,
      "grade",
      "TIC " + id + " · 성과가 인정되었습니다.",
      "/results/" + id,
    );
    return true;
  }
  advance(uid: string, id: string) {
    const p = this.progress(uid, id),
      t = TUTORIALS.find((t) => t.id === id);
    if (!t || p.node.status !== "complete") return;
    const next = TUTORIALS.find((n) => n.number === t.number + 1);
    if (next) this.unlock(uid, next.id, "tutorial", id, null);
    if (
      TUTORIALS.every(
        (t) => this.user(uid).stars[t.id]?.node.status === "complete",
      )
    )
      this.unlock(uid, this.state.challengeId, "challenge", null, null);
  }
  record(uid: string, h: History) {
    return (
      this.state.histories.find((x) => x.id === h.id && x.memberId === uid) ||
      fail("기록을 볼 권한이 없습니다.", 404, "NOT_FOUND")
    );
  }
  history(uid: string, id: string): History {
    const h =
      this.state.histories.find((h) => h.id === id && h.memberId === uid) ||
      fail("기록을 찾을 수 없습니다.", 404, "NOT_FOUND");
    const s = h.signalId
      ? this.star(h.starId).signals.find((s) => s.id === h.signalId)
      : null;
    return {
      ...clone(h),
      currentBundleId: this.state.bundleId,
      publication: clone(
        this.state.publications.find((p) => p.historyId === h.id) || null,
      ),
      signal: clone(s || null),
      retired: !!s?.retired,
      restoreFallback: h.removedIds.some(
        (id) => this.star(h.starId).signals.find((s) => s.id === id)?.retired,
      ),
      hintAvailable: !!this.hint(uid, h),
    };
  }
  histories(
    uid: string,
    o: {
      starId?: string;
      from?: string;
      to?: string;
      outcome?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    this.user(uid);
    let hs = this.state.histories.filter((h) => h.memberId === uid);
    if (o.starId) hs = hs.filter((h) => h.starId.includes(o.starId!));
    if (o.from) hs = hs.filter((h) => h.submittedAt >= o.from!);
    if (o.to) hs = hs.filter((h) => h.submittedAt <= o.to! + "T23:59:59.999Z");
    if (o.outcome && o.outcome !== "all")
      hs = hs.filter((h) => h.outcome === o.outcome);
    hs.sort(
      (a, b) =>
        b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id),
    );
    return this.page(
      hs.map((h) => this.history(uid, h.id)),
      o,
    );
  }
  hint(uid: string, h: History): Signal | null {
    if (h.signalId)
      return (
        this.star(h.starId).signals.find((s) => s.id === h.signalId) || null
      );
    return (
      this.star(h.starId)
        .signals.filter(
          (s) => s.discoverable && !s.retired && !h.removedIds.includes(s.id),
        )
        .sort((a, b) => b.sde - a.sde)[0] || null
    );
  }
  reveal(uid: string, id: string) {
    const h = this.history(uid, id),
      signal = this.hint(uid, h);
    if (!signal) fail("제공할 해설이 없습니다.", 409, "NO_HINT");
    this.state.histories.find((x) => x.id === id)!.answerViewed = true;
    this.touch();
    return { signal, canSkip: this.canSkip(uid, h.starId) };
  }
  canSkip(uid: string, id: string) {
    if (!TUTORIALS.some((t) => t.id === id) || this.skipAfter <= 0)
      return false;
    return (
      this.state.histories.filter(
        (h) =>
          h.memberId === uid &&
          h.starId === id &&
          (h.outcome === "not_matched" ||
            h.outcome === "none_wrong" ||
            h.achievementResult === "judgment_mismatch"),
      ).length >= this.skipAfter
    );
  }
  skip(uid: string, id: string) {
    const p = this.progress(uid, id);
    if (
      !this.canSkip(uid, id) ||
      !this.state.histories.some(
        (h) => h.memberId === uid && h.starId === id && h.answerViewed,
      )
    )
      fail(
        "해설을 확인한 뒤 다음 튜토리얼로 이동할 수 있습니다.",
        409,
        "SKIP_NOT_READY",
      );
    if (p.node.completionReason === "skipped") return this.detail(uid, id);
    const h = this.emptyHistory(uid, id);
    h.outcome = "skipped";
    h.achievementResult = "skipped";
    this.state.histories.push(h);
    p.node.status = "complete";
    p.node.completionReason = "skipped";
    p.node.lastActivity = h.submittedAt;
    this.advance(uid, id);
    this.touch();
    return this.detail(uid, id);
  }
  emptyHistory(uid: string, id: string): History {
    return {
      id: this.id("submission"),
      memberId: uid,
      starId: id,
      signalId: null,
      submittedAt: now(),
      bundleId: this.state.bundleId,
      currentBundleId: this.state.bundleId,
      curveStep: 0,
      removedIds: [],
      period: null,
      originalPeriod: null,
      phaseStart: null,
      phaseEnd: null,
      referenceTime: this.state.bundleId.endsWith("v1") ? 1500 : 1513.25,
      epoch: null,
      duration: null,
      judgment: null,
      evidence: [],
      memo: "",
      viewport: { x: 0, y: 0, zoom: 1 },
      foldedZoom: 1,
      reproduction: {
        schema: 1,
        periodogramViewport: null,
        folding: null,
        versions: {
          preprocessing: null,
          residual: null,
          periodogram: null,
          feature: null,
          ai: null,
          matching: "local-fixture-matcher-v1",
          external: null,
          folding: "local-fixture-curve-v1",
        },
      },
      outcome: "not_matched",
      achievementResult: "no_match",
      type: null,
      answerViewed: false,
      retryOf: null,
      centroidDataStatus: "unavailable",
      snapshot: null,
      retired: false,
      restoreFallback: false,
      hintAvailable: false,
    };
  }
  analysis(uid: string, id: string, retryId?: string): AnalysisContext {
    const p = this.progress(uid, id),
      star = this.star(id);
    let retry: History | null = null;
    if (retryId) {
      retry = this.history(uid, retryId);
      if (retry.starId !== id) fail("다른 별의 기록입니다.");
      if (retry.retired)
        return {
          star: this.detail(uid, id),
          bundleId: this.state.bundleId,
          hasConfirmed: star.signals.some((s) => s.type === "confirmed"),
          referenceTime: this.state.bundleId.endsWith("v1") ? 1500 : 1513.25,
          curve: curve(),
          retry,
          canSkip: false,
          periodLimits: { min: 0.5, max: 40, step: 0.0001 },
          readOnlyReason: "최신 데이터에서 더 이상 후보가 아닙니다",
        };
    }
    if (p.node.status === "unexplored") p.node.status = "in_progress";
    p.node.reopenedAt = null;
    this.touch();
    return {
      star: this.detail(uid, id),
      bundleId: this.state.bundleId,
      hasConfirmed: star.signals.some((s) => s.type === "confirmed"),
      referenceTime: this.state.bundleId.endsWith("v1") ? 1500 : 1513.25,
      curve: curve(),
      retry,
      canSkip: this.canSkip(uid, id),
      periodLimits: { min: 0.5, max: 40, step: 0.0001 },
      readOnlyReason: null,
    };
  }
  submit(uid: string, input: SubmissionInput): History {
    let analysisView: AnalysisViewState;
    try {
      analysisView = readAnalysisView(input.analysisView);
    } catch (error) {
      fail((error as Error).message);
    }
    if (!input.requestId) fail("요청 ID가 필요합니다.");
    const key = uid + ":submit:" + input.requestId;
    if (this.state.requests[key])
      return this.history(uid, String(this.state.requests[key]));
    const p = this.progress(uid, input.starId),
      star = this.star(input.starId);
    const retry = input.retryOf ? this.history(uid, input.retryOf) : null;
    if (retry?.retired)
      fail(
        "최신 데이터에서 더 이상 후보가 아닙니다.",
        409,
        "CANDIDATE_RETIRED",
      );
    if (retry && retry.starId !== input.starId)
      fail("다른 별의 재도전 기록입니다.");
    const removed = retry
      ? retry.restoreFallback
        ? Object.keys(p.matches)
        : retry.removedIds
      : Object.keys(p.matches);
    const available = star.signals.filter(
      (s) => s.discoverable && !s.retired && !removed.includes(s.id),
    );
    const h = this.emptyHistory(uid, input.starId);
    Object.assign(h.reproduction!, analysisView!);
    h.curveStep = removed.length;
    h.removedIds = [...removed];
    h.retryOf = retry?.id || null;
    if (input.noCandidate) {
      if (!available.length) fail("현재 탐색 가능한 신호를 모두 찾았습니다.");
      h.outcome = "none_wrong";
    } else {
      const period = Number(input.period),
        start = Number(input.phaseStart),
        end = Number(input.phaseEnd);
      if (
        !Number.isFinite(period) ||
        period <= 0 ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        start >= 1 ||
        end <= start ||
        end >= start + 1
      )
        fail("주기와 가려지는 구간을 확인해 주세요.");
      if (
        !["LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE"].includes(
          input.judgment || "",
        )
      )
        fail("판단을 선택해 주세요.");
      if (input.evidence?.some((e) => !EVIDENCE.includes(e)))
        fail("사용할 수 없는 근거입니다.");
      Object.assign(h, {
        period,
        originalPeriod: period,
        phaseStart: start,
        phaseEnd: end,
        epoch: h.referenceTime + (((start + end) / 2) % 1) * period,
        duration: (end - start) * period,
        judgment: input.judgment,
        evidence: input.evidence || [],
        memo: (input.memo || "").slice(0, 4000),
        viewport: input.viewport || h.viewport,
        foldedZoom: Math.max(1, Math.min(8, input.foldedZoom || 1)),
      });
      // Contract fixture matching only. Production matching is owned by the core backend.
      const matches = available
        .map((s) => ({ s, ratio: period / s.period }))
        .filter((x) => [1, 0.5, 2].some((r) => Math.abs(x.ratio - r) < 0.015));
      if (matches.length > 1) h.outcome = "ambiguous_match";
      else if (matches.length === 1) {
        const s = matches[0].s;
        h.signalId = s.id;
        h.reproduction!.versions.ai = s.ai.version;
        h.type = s.type;
        h.period = s.period;
        h.outcome =
          Math.abs(matches[0].ratio - 1) < 0.015
            ? "matched"
            : "matched_harmonic";
        h.snapshot = curve(
          period,
          s.depth / 100,
          ((((s.epoch - h.referenceTime) / period) % 1) + 1) % 1,
        ).map((row) => row.map(Math.fround));
        const already = !!p.achievements[s.id];
        const valid = s.type !== "unconfirmed" && h.judgment === correct(s);
        h.achievementResult =
          s.type === "unconfirmed"
            ? "unpublished"
            : h.judgment === "UNSURE"
              ? "judgment_unsure"
              : !valid
                ? "judgment_mismatch"
                : already
                  ? "already_recognized"
                  : "recognized";
        p.matches[s.id] = { judgment: h.judgment!, historyId: h.id };
        if (valid) {
          this.award(uid, star.id, s);
          if (already) h.outcome = "duplicate";
        }
      }
    }
    p.node.status = "in_progress";
    const remaining = star.signals.filter(
      (s) => !s.retired && !p.matches[s.id],
    );
    if (!remaining.some((s) => s.discoverable)) {
      p.node.status = "complete";
      p.node.completionReason = remaining.length
        ? "undiscoverable_only"
        : "all_found";
    }
    p.node.lastActivity = h.submittedAt;
    this.state.histories.push(h);
    this.state.requests[key] = h.id;
    this.advance(uid, star.id);
    this.touch();
    return this.history(uid, h.id);
  }
  publish(uid: string, historyId: string, active = true): Publication {
    const h = this.history(uid, historyId);
    if (!h.signalId || h.type !== "unconfirmed")
      fail("매칭된 미확정 분석만 공개할 수 있습니다.");
    let pub = this.state.publications.find((p) => p.historyId === h.id);
    let thread = this.state.posts.find(
      (p) => p.kind === "system_thread" && p.signalId === h.signalId,
    );
    if (active && (pub?.hidden || thread?.hidden))
      fail(
        "운영자가 숨긴 자료에는 공개할 수 없습니다. 개인 기록은 유지됩니다.",
        409,
        "CONTENT_HIDDEN",
      );
    if (!thread) {
      if (!active) fail("공개한 분석이 없습니다.");
      thread = {
        id: this.id("thread"),
        kind: "system_thread",
        memberId: null,
        starId: h.starId,
        signalId: h.signalId,
        title: "TIC " + h.starId + " · 신호 " + h.signalId!.split(":").at(-1),
        body: "같은 신호를 살펴본 분석과 토론을 모읍니다.",
        tag: "DISCUSSION",
        createdAt: now(),
        updatedAt: now(),
        hidden: false,
        deleted: false,
        attachments: [],
        sources: [],
      };
      this.state.posts.push(thread);
    }
    if (!pub) {
      pub = {
        id: this.id("analysis"),
        historyId: h.id,
        memberId: uid,
        starId: h.starId,
        signalId: h.signalId!,
        threadId: thread.id,
        publishedAt: now(),
        active,
        hidden: false,
      };
      this.state.publications.push(pub);
    } else {
      pub.active = active;
      if (active) pub.publishedAt = now();
    }
    if (active) {
      const s = this.star(h.starId).signals.find((s) => s.id === h.signalId)!;
      this.award(uid, h.starId, s);
    }
    this.touch();
    return clone(pub);
  }
  publicationDestinations(
    uid: string,
    starId: string,
  ): import("../shared/types").PublicationDestination[] {
    this.progress(uid, starId);
    const ids = new Set(
      this.state.histories
        .filter(
          (h) =>
            h.memberId === uid &&
            h.starId === starId &&
            h.type === "unconfirmed" &&
            h.signalId,
        )
        .map((h) => h.signalId!),
    );
    return [...ids].map((signalId) => {
      const thread = this.state.posts.find(
        (p) => p.kind === "system_thread" && p.signalId === signalId,
      );
      const unavailable = !!thread && !this.postVisible(thread);
      return {
        signalId,
        starId,
        status: unavailable ? "unavailable" : thread ? "existing" : "new",
        threadId: thread && !unavailable ? thread.id : null,
        title: unavailable
          ? "현재 공개할 수 없는 신호 스레드"
          : thread?.title ||
            "TIC " + starId + " · 신호 " + signalId.split(":").at(-1),
      };
    });
  }
  distribution(signalId: string, asOf = now()): Distribution {
    const signal =
      this.catalogue.flatMap((s) => s.signals).find((s) => s.id === signalId) ||
      fail("신호를 찾을 수 없습니다.", 404);
    if (signal.type !== "unconfirmed") {
      const first = new Map<string, History>();
      this.state.histories
        .filter((h) => h.signalId === signalId)
        .sort(
          (a, b) =>
            a.submittedAt.localeCompare(b.submittedAt) ||
            a.id.localeCompare(b.id),
        )
        .forEach((h) => {
          if (!first.has(h.memberId)) first.set(h.memberId, h);
        });
      const hs = [...first.values()];
      return {
        kind: "scored",
        total: hs.length,
        counts: blankCounts(),
        percent: hs.length
          ? (hs.filter((h) => h.judgment === correct(signal)).length /
              hs.length) *
            100
          : null,
        asOf,
      };
    }
    const latest = new Map<string, History>();
    for (const p of this.state.publications.filter(
      (p) => p.signalId === signalId && this.publicationVisible(p),
    )) {
      const h = this.state.histories.find((h) => h.id === p.historyId)!;
      const previous = latest.get(h.memberId);
      if (
        !previous ||
        h.submittedAt > previous.submittedAt ||
        (h.submittedAt === previous.submittedAt && h.id > previous.id)
      )
        latest.set(h.memberId, h);
    }
    const counts = blankCounts();
    latest.forEach((h) => {
      if (h.judgment) counts[h.judgment]++;
    });
    return { kind: "public", total: latest.size, counts, percent: null, asOf };
  }
  publicationVisible(p: Publication) {
    return (
      p.active &&
      !p.hidden &&
      !!this.state.posts.find(
        (t) => t.id === p.threadId && !t.hidden && !t.deleted,
      )
    );
  }
  postVisible(p: StoredPost) {
    return !p.hidden && !p.deleted;
  }
  getPost(id: string) {
    const p = this.state.posts.find((p) => p.id === id);
    if (!p || !this.postVisible(p))
      fail(
        "삭제되었거나 현재 볼 수 없는 글입니다.",
        404,
        "CONTENT_UNAVAILABLE",
      );
    return p;
  }
  postDTO(uid: string, p: StoredPost): Post {
    const reactions = this.state.reactions[p.id] || {};
    return {
      ...clone(p),
      author: p.memberId ? this.user(p.memberId).member.nickname : "SYSTEM",
      agree: Object.values(reactions).filter((v) => v === "agree").length,
      disagree: Object.values(reactions).filter((v) => v === "disagree").length,
      myReaction: reactions[uid] || null,
      commentCount: this.state.comments.filter(
        (c) => c.postId === p.id && !c.deleted && !c.hidden,
      ).length,
      followingAuthor:
        !!p.memberId && this.user(uid).follows.includes("member:" + p.memberId),
      followingStar:
        !!p.starId && this.user(uid).follows.includes("star:" + p.starId),
      canAnalyze: !!p.starId && !!this.user(uid).stars[p.starId],
    };
  }
  feed(
    uid: string,
    o: {
      q?: string;
      starId?: string;
      kind?: string;
      tag?: string;
      tab?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) {
    const u = this.user(uid);
    let posts = this.state.posts.filter((p) => this.postVisible(p));
    if (o.starId) {
      this.accessibleStar(o.starId);
      posts = posts.filter((p) => p.starId === o.starId);
    }
    if (o.q) {
      const q = o.q.toLowerCase();
      posts = posts.filter((p) =>
        (
          p.title +
          " " +
          p.body +
          " " +
          (p.memberId ? this.user(p.memberId).member.nickname : "SYSTEM") +
          " " +
          p.starId
        )
          .toLowerCase()
          .includes(q),
      );
    }
    if (o.kind === "free") posts = posts.filter((p) => p.starId === null);
    else if (o.kind === "star") posts = posts.filter((p) => p.starId !== null);
    else if (o.kind === "system_thread")
      posts = posts.filter((p) => p.kind === "system_thread");
    if (o.tag && o.tag !== "all") posts = posts.filter((p) => p.tag === o.tag);
    if (o.tab === "following")
      posts = posts.filter(
        (p) =>
          u.follows.includes("member:" + p.memberId) ||
          u.follows.includes("star:" + p.starId),
      );
    if (o.tab === "mine")
      posts = posts.filter(
        (p) =>
          p.memberId === uid ||
          this.state.publications.some(
            (a) =>
              a.memberId === uid &&
              a.threadId === p.id &&
              this.publicationVisible(a),
          ),
      );
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const score = (p: StoredPost) =>
      this.state.comments.filter(
        (c) =>
          c.postId === p.id && c.createdAt >= cutoff && !c.hidden && !c.deleted,
      ).length + Object.keys(this.state.reactions[p.id] || {}).length;
    if (o.tab === "hot")
      posts = posts
        .filter((p) => p.updatedAt >= cutoff)
        .sort(
          (a, b) =>
            score(b) - score(a) || b.createdAt.localeCompare(a.createdAt),
        );
    else posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      ...this.page(
        posts.map((p) => this.postDTO(uid, p)),
        o,
      ),
      hotRule: "최근 7일 댓글 수 + 현재 동의·비동의 수 · 동률은 최신 글 순",
    };
  }
  sourceCard(ref: SourceRef): import("../shared/types").SourceCard {
    try {
      if (ref.kind === "thread") {
        const p = this.getPost(ref.id);
        if (p.kind !== "system_thread") throw new Error();
        const signal = this.star(p.starId!).signals.find(
          (s) => s.id === p.signalId,
        )!;
        return {
          ...ref,
          available: true,
          title: p.title,
          starId: p.starId!,
          distribution: this.distribution(p.signalId!),
          signalSummary: {
            id: signal.id,
            period: signal.period,
            duration: signal.duration,
            depth: signal.depth,
            bundleId: this.state.bundleId,
          },
        };
      }
      const pub = this.state.publications.find((p) => p.id === ref.id);
      if (!pub || !this.publicationVisible(pub)) throw new Error();
      const h = this.history(pub.memberId, pub.historyId);
      return {
        ...ref,
        available: true,
        title: "공개 분석 출처",
        starId: pub.starId,
        author: this.user(pub.memberId).member.nickname,
        submittedAt: h.submittedAt,
        judgment: h.judgment,
        distribution: this.distribution(pub.signalId),
      };
    } catch {
      return { ...ref, available: false, title: "현재 볼 수 없는 출처입니다." };
    }
  }
  validateLinks(
    uid: string,
    starId: string | null,
    attachments: string[],
    sources: SourceRef[],
  ) {
    if ((attachments.length || sources.length) && !starId)
      fail("별을 선택해야 별 자료를 연결할 수 있습니다.");
    if (starId) this.accessibleStar(starId);
    for (const id of attachments) {
      const h = this.history(uid, id);
      if (h.starId !== starId)
        fail("같은 별의 본인 기록만 첨부할 수 있습니다.");
    }
    for (const ref of sources) {
      const card = this.sourceCard(ref);
      if (!card.available || card.starId !== starId)
        fail("같은 별의 공개 중인 출처만 연결할 수 있습니다.");
    }
  }
  savePost(
    uid: string,
    input: {
      title: string;
      body: string;
      tag: Tag;
      starId: string | null;
      attachments: string[];
      sources: SourceRef[];
    },
    id?: string,
  ) {
    this.user(uid);
    const title = String(input.title || "").trim(),
      body = String(input.body || "").trim();
    if (
      !title ||
      title.length > 120 ||
      !body ||
      body.length > 40000 ||
      !tags.includes(input.tag)
    )
      fail("제목·본문·목적 태그를 확인해 주세요.");
    this.validateLinks(
      uid,
      input.starId,
      input.attachments || [],
      input.sources || [],
    );
    let p: StoredPost;
    if (id) {
      p = this.getPost(id);
      if (p.memberId !== uid || p.kind !== "general")
        fail("본인의 일반 글만 수정할 수 있습니다.", 403);
    } else {
      p = {
        id: this.id("post"),
        kind: "general",
        memberId: uid,
        signalId: null,
        createdAt: now(),
        updatedAt: now(),
        hidden: false,
        deleted: false,
        ...input,
      };
      this.state.posts.push(p);
    }
    Object.assign(p, { ...input, title, body, updatedAt: now() });
    if (!id && p.starId)
      Object.values(this.state.users).forEach((u) => {
        if (u.member.id !== uid && u.follows.includes("star:" + p.starId))
          this.notify(
            u.member.id,
            "follow",
            "팔로우한 별에 새 글이 등록되었습니다.",
            "/community/posts/" + p.id,
          );
      });
    this.touch();
    return this.postDTO(uid, p);
  }
  deletePost(uid: string, id: string) {
    const p = this.getPost(id);
    if (p.memberId !== uid || p.kind !== "general")
      fail("본인의 일반 글만 삭제할 수 있습니다.", 403);
    p.deleted = true;
    this.touch();
    return { deleted: true };
  }
  postDetail(uid: string, id: string, returnStarId?: string) {
    const p = this.getPost(id),
      asOf = now();
    if (returnStarId !== undefined && p.starId !== returnStarId)
      fail(
        "게시글의 별이 변경되어 원래 글로 돌아갈 수 없습니다.",
        409,
        "RETURN_STAR_MISMATCH",
      );
    const analyses = this.state.publications
      .filter((a) => a.threadId === id && this.publicationVisible(a))
      .map((a) => ({
        publication: clone(a),
        author: {
          id: a.memberId,
          nickname: this.user(a.memberId).member.nickname,
        },
        history: this.publicHistory(a.memberId, a.historyId),
      }));
    return {
      post: this.postDTO(uid, p),
      comments: this.state.comments
        .filter((c) => c.postId === id && !c.deleted && !c.hidden)
        .map((c) => ({
          ...clone(c),
          author: this.user(c.memberId).member.nickname,
        })),
      analyses,
      distribution: p.signalId ? this.distribution(p.signalId, asOf) : null,
      signal: p.signalId
        ? clone(this.star(p.starId!).signals.find((s) => s.id === p.signalId))
        : null,
      attachments: p.attachments
        .map((id) => {
          const h = this.state.histories.find((h) => h.id === id);
          return h ? this.publicHistory(h.memberId, id) : null;
        })
        .filter(Boolean),
      sourceCards: p.sources.map((r) => this.sourceCard(r)),
    };
  }
  saveComment(
    uid: string,
    postId: string,
    input: { body: string; attachments: string[]; sources: SourceRef[] },
    id?: string,
  ) {
    const post = this.getPost(postId);
    const body = String(input.body || "").trim();
    if (!body || body.length > 10000) fail("댓글 내용을 확인해 주세요.");
    this.validateLinks(
      uid,
      post.starId,
      input.attachments || [],
      input.sources || [],
    );
    let c: StoredComment;
    if (id) {
      c =
        this.state.comments.find(
          (c) => c.id === id && c.postId === postId && !c.deleted && !c.hidden,
        ) || fail("댓글을 찾을 수 없습니다.", 404);
      if (c.memberId !== uid) fail("본인 댓글만 수정할 수 있습니다.", 403);
      Object.assign(c, { ...input, body, updatedAt: now() });
    } else {
      c = {
        id: this.id("comment"),
        postId,
        memberId: uid,
        body,
        attachments: input.attachments || [],
        sources: input.sources || [],
        createdAt: now(),
        updatedAt: now(),
        hidden: false,
        deleted: false,
      };
      this.state.comments.push(c);
      if (post.memberId && post.memberId !== uid)
        this.notify(
          post.memberId,
          "community",
          "내 글에 새 댓글이 등록되었습니다.",
          "/community/posts/" + postId,
        );
    }
    post.updatedAt = now();
    this.touch();
    return { ...clone(c), author: this.user(uid).member.nickname };
  }
  deleteComment(uid: string, id: string) {
    const c =
      this.state.comments.find((c) => c.id === id && !c.deleted) ||
      fail("댓글을 찾을 수 없습니다.", 404);
    this.getPost(c.postId);
    if (c.memberId !== uid) fail("본인 댓글만 삭제할 수 있습니다.", 403);
    c.deleted = true;
    this.touch();
    return { deleted: true };
  }
  react(uid: string, id: string, value: "agree" | "disagree" | null) {
    const p = this.getPost(id);
    if (p.kind !== "general")
      fail("공식 신호 판단은 공개 분석에서 집계합니다.");
    if (value !== null && value !== "agree" && value !== "disagree")
      fail("반응을 확인해 주세요.");
    const reactions = (this.state.reactions[id] ??= {});
    if (value) reactions[uid] = value;
    else delete reactions[uid];
    this.touch();
    return this.postDTO(uid, p);
  }
  reactors(uid: string, id: string, value: string) {
    this.getPost(id);
    this.user(uid);
    return Object.entries(this.state.reactions[id] || {})
      .filter(([, v]) => v === value)
      .map(([id]) => ({ id, nickname: this.user(id).member.nickname }));
  }
  reopen(id: string) {
    const star = this.star(id);
    star.signals.push({
      ...clone(star.signals[0]),
      id: id + ":reopen:" + this.id("signal"),
      type: "unconfirmed",
      period: 18.27,
      discoverable: true,
    });
    for (const [uid, u] of Object.entries(this.state.users)) {
      if (u.stars[id]) {
        u.stars[id].node.status = "in_progress";
        u.stars[id].node.completionReason = null;
        u.stars[id].node.reopenedAt = now();
        u.stars[id].node.lastActivity = now();
        this.notify(
          uid,
          "reopened",
          "이 별에 새로 찾을 수 있는 신호가 생겼습니다",
          "/analysis/" + id,
        );
      } else if (u.follows.includes("star:" + id))
        this.notify(
          uid,
          "reopened",
          "팔로우한 별에 새로 찾을 수 있는 신호가 생겼습니다",
          "/community/stars/" + id,
        );
    }
    this.touch();
  }
  seedPeers() {
    this.addUser("peer-jiwoong", "지웅");
    this.addUser("peer-sky", "별빛연구원", "google");
    const shared = ["900000099", "910000002", "910000005"];
    for (const uid of ["peer-jiwoong", "peer-sky"]) {
      for (const id of shared)
        this.unlock(uid, id, "achievement", TUTORIALS[0].id, null);
      for (const id of shared) {
        const signal = this.star(id).signals[0];
        const h = this.submit(uid, {
          starId: id,
          period: signal.period,
          phaseStart: 0.2,
          phaseEnd: 0.25,
          judgment: uid === "peer-sky" ? "UNSURE" : "LIKELY_PLANET",
          requestId: "seed:" + uid + id,
        });
        if (h.type === "unconfirmed") this.publish(uid, h.id);
      }
      this.user(uid).member.firstVisit = false;
    }
    this.savePost("peer-jiwoong", {
      title: "반복해서 어두워지는 구간을 함께 살펴봐요",
      body: "같은 별을 보더라도 어떤 구간을 선택했는지에 따라 해석이 달라질 수 있습니다.\n\n반복되는 신호의 간격과 모양을 비교해 보았습니다. 여러분은 어떤 근거를 살펴보셨나요?",
      tag: "DISCUSSION",
      starId: "900000099",
      attachments: [],
      sources: [],
    });
    this.savePost("peer-sky", {
      title: "처음 탐사를 시작하는 분들에게",
      body: "먼저 튜토리얼의 파란 번호를 따라가 보세요. 행성인지 판단하기 어려워도 모르겠음으로 기록할 수 있습니다.",
      tag: "INFORMATION",
      starId: null,
      attachments: [],
      sources: [],
    });
  }
  metrics(uid?: string): Metrics {
    const hs = this.state.histories.filter((h) => !uid || h.memberId === uid),
      users = uid ? [this.user(uid)] : Object.values(this.state.users),
      nodes = users.flatMap((u) =>
        Object.keys(u.stars).map((id) => this.dto(u.member.id, id)),
      );
    const achievements = users.flatMap((u) =>
      Object.values(u.stars).flatMap((p) => Object.values(p.achievements)),
    );
    const first = new Map<string, History>();
    hs.filter((h) => h.signalId && h.type !== "unconfirmed")
      .sort(
        (a, b) =>
          a.submittedAt.localeCompare(b.submittedAt) ||
          a.id.localeCompare(b.id),
      )
      .forEach((h) => {
        const key = h.memberId + ":" + h.signalId;
        if (!first.has(key)) first.set(key, h);
      });
    const scored = [...first.values()];
    const isCorrect = (h: History) =>
      h.judgment === (h.type === "fp" ? "UNLIKELY_PLANET" : "LIKELY_PLANET");
    const rate = (list: History[]) =>
      list.length ? (list.filter(isCorrect).length / list.length) * 100 : null;
    const starsWithSubmissions = new Set(
      hs.map((h) => h.memberId + ":" + h.starId),
    );
    const matched = hs.filter((h) => h.signalId);
    return {
      judgments: {
        LIKELY_PLANET: hs.filter((h) => h.judgment === "LIKELY_PLANET").length,
        UNLIKELY_PLANET: hs.filter((h) => h.judgment === "UNLIKELY_PLANET")
          .length,
        UNSURE: hs.filter((h) => h.judgment === "UNSURE").length,
      },
      found: nodes.length,
      started: nodes.filter((n) => n.status !== "unexplored").length,
      completed: nodes.filter((n) => n.status === "complete").length,
      achievements: achievements.length,
      types: {
        confirmed: achievements.filter((v) => v === "confirmed").length,
        fp: achievements.filter((v) => v === "fp").length,
        unconfirmed: achievements.filter((v) => v === "unconfirmed").length,
      },
      grades: Object.fromEntries(
        ["A", "S", "SS", "SSS"].map((g) => [
          g,
          nodes.filter((n) => n.grade === g).length,
        ]),
      ),
      agreement: rate(scored),
      likelyAgreement: rate(
        scored.filter((h) => h.judgment === "LIKELY_PLANET"),
      ),
      unlikelyAgreement: rate(
        scored.filter((h) => h.judgment === "UNLIKELY_PLANET"),
      ),
      firstAgreement: rate(scored),
      recovered: scored.filter(
        (h) =>
          !isCorrect(h) &&
          hs.some(
            (n) =>
              n.memberId === h.memberId &&
              n.signalId === h.signalId &&
              n.achievementResult === "recognized",
          ),
      ).length,
      attemptsPerStar: starsWithSubmissions.size
        ? hs.length / starsWithSubmissions.size
        : null,
      harmonicRatio: matched.length
        ? (matched.filter((h) => h.outcome === "matched_harmonic").length /
            matched.length) *
          100
        : null,
      evidenceAverage: hs.length
        ? hs.reduce((n, h) => n + h.evidence.length, 0) / hs.length
        : null,
      weekly: Array.from({ length: 8 }, (_, i) => {
        const start = new Date(Date.now() - (7 - i) * 7 * 86400000);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(+start + 7 * 86400000);
        return {
          week: start.toISOString().slice(0, 10),
          count: hs.filter(
            (h) =>
              h.submittedAt >= start.toISOString() &&
              h.submittedAt < end.toISOString(),
          ).length,
        };
      }),
      evidence: EVIDENCE.map((name) => ({
        name,
        count: hs.filter((h) => h.evidence.includes(name)).length,
        agreement: rate(scored.filter((h) => h.evidence.includes(name))),
      })),
      posts: this.state.posts.filter(
        (p) =>
          p.memberId && (!uid || p.memberId === uid) && this.postVisible(p),
      ).length,
      comments: this.state.comments.filter(
        (c) => (!uid || c.memberId === uid) && !c.deleted && !c.hidden,
      ).length,
      unpublished: nodes.reduce((n, s) => n + s.unpublishedCount, 0),
      activeDays: new Set(hs.map((h) => h.submittedAt.slice(0, 10))).size,
      nextGoal: hs.length
        ? "아직 공개하지 않은 분석을 돌아보세요."
        : "첫 번째 별에서 반복되는 빛을 찾아보세요.",
    };
  }
  statistics(uid: string): Statistics {
    const mine = this.metrics(uid),
      global = this.metrics();
    const active = new Set(
      this.state.histories
        .filter(
          (h) =>
            h.submittedAt >= new Date(Date.now() - 90 * 86400000).toISOString(),
        )
        .map((h) => h.memberId),
    );
    const metrics = [...active].map((id) => this.metrics(id));
    const median = (
      key:
        | "agreement"
        | "firstAgreement"
        | "attemptsPerStar"
        | "harmonicRatio"
        | "evidenceAverage",
    ) => {
      const values = metrics
        .map((m) => m[key])
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      return values.length
        ? (values[Math.floor((values.length - 1) / 2)] +
            values[Math.ceil((values.length - 1) / 2)]) /
            2
        : null;
    };
    const asOf = now();
    const publicJudgments: Distribution = {
      aggregate: true,
      kind: "public",
      total: 0,
      counts: blankCounts(),
      percent: null,
      asOf,
    };
    for (const id of new Set(this.state.publications.map((p) => p.signalId))) {
      const d = this.distribution(id, asOf);
      if (d.kind === "public") {
        publicJudgments.total += d.total;
        for (const j of Object.keys(d.counts) as Judgment[])
          publicJudgments.counts[j] += d.counts[j];
      }
    }
    const counts = new Map<string, number>();
    this.state.posts
      .filter((p) => p.starId && this.postVisible(p))
      .forEach((p) => counts.set(p.starId!, 1 + (counts.get(p.starId!) || 0)));
    return {
      mine,
      global,
      baseline: {
        asOf: new Date().toISOString().slice(0, 10) + "T00:00:00Z",
        population: "최근 90일 제출 회원 중앙값 · 일 1회",
        agreement: median("agreement"),
        firstAgreement: median("firstAgreement"),
        attemptsPerStar: median("attemptsPerStar"),
        harmonicRatio: median("harmonicRatio"),
        evidenceAverage: median("evidenceAverage"),
      },
      asOf: new Date(Math.floor(Date.now() / 600000) * 600000).toISOString(),
      refreshMinutes: 10,
      publicJudgments,
      discussedStars: [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => ({ id, count })),
      aiBands: ["approved", "review", "below", "not_evaluated"].map((name) => {
        const counts = blankCounts();
        this.state.histories
          .filter((h) => h.signalId)
          .forEach((h) => {
            const s = this.star(h.starId).signals.find(
              (s) => s.id === h.signalId,
            );
            if ((s?.ai.band || "not_evaluated") === name && h.judgment)
              counts[h.judgment]++;
          });
        return { name, counts };
      }),
      sectors: Array.from({ length: 5 }, (_, i) => ({
        sector: i + 1,
        completed: Object.values(this.state.users)
          .flatMap((u) => Object.values(u.stars))
          .filter(
            (p) =>
              p.node.status === "complete" &&
              this.star(p.node.id).sectors.includes(i + 1),
          ).length,
        total: Object.values(this.state.users)
          .flatMap((u) => Object.values(u.stars))
          .filter((p) => this.star(p.node.id).sectors.includes(i + 1)).length,
      })),
      challenge: {
        participants: this.quests(uid).challenge.participants,
        distribution: this.distribution(
          this.star(this.state.challengeId).signals[0].id,
          asOf,
        ),
      },
    };
  }
}
