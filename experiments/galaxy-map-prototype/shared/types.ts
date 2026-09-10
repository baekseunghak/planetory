export type Judgment = "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE";
export type SignalType = "confirmed" | "fp" | "unconfirmed";
export type ProgressStatus = "unexplored" | "in_progress" | "complete";
export type CompletionReason =
  | "all_found"
  | "undiscoverable_only"
  | "skipped"
  | null;
export interface Member {
  id: string;
  nickname: string;
  joinedAt: string;
  provider: "ssafy" | "google";
  firstVisit: boolean;
  settings: { publicStars: boolean; notifications: Record<string, boolean> };
}
export interface Signal {
  id: string;
  starId: string;
  type: SignalType;
  period: number;
  epoch: number;
  duration: number;
  depth: number;
  discoverable: boolean;
  retired?: boolean;
  ai: {
    score: number | null;
    status: "evaluated" | "insufficient_data" | "error" | "not_evaluated";
    band: "approved" | "review" | "below" | null;
    version: string;
  };
  source: { title: string; url: string; retrievedAt: string };
  sde: number;
  judgment?: Judgment;
}
export interface StarNode {
  id: string;
  name: string;
  x: number;
  y: number;
  generation: number;
  angle: number;
  status: ProgressStatus;
  completionReason: CompletionReason;
  planetCount: number;
  achievementCount: number;
  grade: string;
  typeCounts: Record<SignalType, number>;
  matchedCount: number;
  curveStep: number;
  unpublishedCount: number;
  hasFp: boolean;
  tutorial: number | null;
  challenge: boolean;
  reopenedAt: string | null;
  lastActivity: string;
  source: "tutorial" | "achievement" | "challenge";
  parentId: string | null;
  sourceAchievementId: string | null;
  foundAt: string;
}
export interface StarDetail extends StarNode {
  sectors: number[];
  magnitude: number;
  historyCount: number;
  knownSignals: Signal[];
  following: boolean;
  fixture: boolean;
}
export interface Quest {
  number: number;
  id: string;
  purpose: string;
  state: "locked" | "ready" | "in_progress" | "complete" | "skipped";
}
export interface Quests {
  tutorials: Quest[];
  challenge: {
    id: string;
    start: string;
    end: string;
    description: string;
    participants: number;
    unlocked: boolean;
    status: ProgressStatus;
  };
  reopened: StarNode[];
}
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface MapNode {
  id: string;
  x: number;
  y: number;
  count: number;
  counts: { planet: number; done: number; new: number };
  bounds: Bounds;
  star?: Pick<
    StarNode,
    | "id"
    | "name"
    | "x"
    | "y"
    | "status"
    | "planetCount"
    | "tutorial"
    | "challenge"
  >;
}
export interface MapTile {
  key: string;
  bounds: Bounds;
  nodes: StarNode[];
  version: number;
}
export interface MapManifest {
  bounds: Bounds;
  count: number;
  revision: number;
  overview: MapNode[];
  tileSize: number;
}
export type Outcome =
  | "matched"
  | "matched_harmonic"
  | "duplicate"
  | "not_matched"
  | "ambiguous_match"
  | "none_wrong"
  | "skipped";
export interface History {
  id: string;
  memberId: string;
  starId: string;
  signalId: string | null;
  submittedAt: string;
  bundleId: string;
  currentBundleId: string;
  curveStep: number;
  removedIds: string[];
  period: number | null;
  originalPeriod: number | null;
  phaseStart: number | null;
  phaseEnd: number | null;
  referenceTime: number;
  epoch: number | null;
  duration: number | null;
  judgment: Judgment | null;
  evidence: string[];
  memo: string;
  viewport: Viewport;
  foldedZoom: number;
  /** Absent on legacy records; never backfill immutable historical versions. */
  reproduction?: import("./analysis-contract").ReproductionState;
  outcome: Outcome;
  achievementResult:
    | "recognized"
    | "already_recognized"
    | "judgment_mismatch"
    | "judgment_unsure"
    | "unpublished"
    | "no_match"
    | "skipped";
  type: SignalType | null;
  answerViewed: boolean;
  retryOf: string | null;
  centroidDataStatus: "unavailable";
  snapshot: number[][] | null;
  publication?: Publication | null;
  signal?: Signal | null;
  retired: boolean;
  restoreFallback: boolean;
  hintAvailable: boolean;
  relabeled?: boolean;
}
export interface Publication {
  id: string;
  historyId: string;
  memberId: string;
  starId: string;
  signalId: string;
  threadId: string;
  publishedAt: string;
  active: boolean;
  hidden: boolean;
}
export interface Distribution {
  aggregate?: boolean;
  kind: "public" | "scored";
  total: number;
  counts: Record<Judgment, number>;
  percent: number | null;
  asOf: string;
}
export interface PublicAnalysis {
  publication: Publication;
  author: { id: string; nickname: string };
  history: PublicHistory;
}
export type PublicHistory = Omit<
  History,
  "answerViewed" | "retryOf" | "viewport"
>;
export type Tag = "DISCUSSION" | "QUESTION" | "OBSERVATION" | "INFORMATION";
export interface SourceRef {
  kind: "thread" | "analysis";
  id: string;
}
export interface Post {
  id: string;
  kind: "general" | "system_thread";
  memberId: string | null;
  author: string;
  starId: string | null;
  signalId: string | null;
  title: string;
  body: string;
  tag: Tag;
  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  deleted: boolean;
  attachments: string[];
  sources: SourceRef[];
  agree: number;
  disagree: number;
  myReaction: "agree" | "disagree" | null;
  commentCount: number;
  followingAuthor: boolean;
  followingStar: boolean;
  canAnalyze: boolean;
}
export interface Comment {
  id: string;
  postId: string;
  memberId: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  attachments: string[];
  sources: SourceRef[];
  hidden: boolean;
  deleted: boolean;
}
export interface PostDetail {
  post: Post;
  comments: Comment[];
  analyses: PublicAnalysis[];
  distribution: Distribution | null;
  signal: Signal | null;
  attachments: History[];
  sourceCards: SourceCard[];
}
export interface SourceCard {
  kind: "thread" | "analysis";
  id: string;
  available: boolean;
  title: string;
  author?: string;
  starId?: string;
  distribution?: Distribution;
  signalSummary?: {
    id: string;
    period: number;
    duration: number;
    depth: number;
    bundleId: string;
  };
  submittedAt?: string;
  judgment?: Judgment | null;
}
export interface PublicationDestination {
  signalId: string;
  starId: string;
  status: "existing" | "new" | "unavailable";
  threadId: string | null;
  title: string;
}
export interface Notification {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
  read: boolean;
  target: string;
  unavailable: boolean;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface Profile {
  member: Pick<Member, "id" | "nickname" | "joinedAt">;
  own: boolean;
  publicStars: boolean;
  following: boolean;
  followers: number;
  followingCount: number;
  found: number;
  completed: number;
  signals: number;
  grades: Record<string, number>;
}
export interface Metrics {
  judgments: Record<Judgment, number>;
  found: number;
  started: number;
  completed: number;
  achievements: number;
  types: Record<SignalType, number>;
  grades: Record<string, number>;
  agreement: number | null;
  likelyAgreement: number | null;
  unlikelyAgreement: number | null;
  firstAgreement: number | null;
  recovered: number;
  attemptsPerStar: number | null;
  harmonicRatio: number | null;
  evidenceAverage: number | null;
  weekly: { week: string; count: number }[];
  evidence: { name: string; count: number; agreement: number | null }[];
  posts: number;
  comments: number;
  unpublished: number;
  activeDays: number;
  nextGoal: string;
}
export interface Statistics {
  mine: Metrics;
  global: Metrics;
  baseline: {
    asOf: string;
    population: string;
    agreement: number | null;
    firstAgreement: number | null;
    attemptsPerStar: number | null;
    harmonicRatio: number | null;
    evidenceAverage: number | null;
  };
  asOf: string;
  refreshMinutes: number;
  publicJudgments: Distribution;
  discussedStars: { id: string; count: number }[];
  aiBands: { name: string; counts: Record<Judgment, number> }[];
  sectors: { sector: number; completed: number; total: number }[];
  challenge: { participants: number; distribution: Distribution };
}
export interface ApiSession {
  member: Member | null;
  mode: "local-fixture" | "production";
}
export interface AnalysisContext {
  star: StarDetail;
  bundleId: string;
  hasConfirmed: boolean;
  referenceTime: number;
  curve: number[][];
  retry: History | null;
  canSkip: boolean;
  periodLimits: { min: number; max: number; step: number };
  readOnlyReason: string | null;
}
export const JUDGMENTS: Record<Judgment, string> = {
  LIKELY_PLANET: "행성 같음",
  UNLIKELY_PLANET: "아닌 것 같음",
  UNSURE: "모르겠음",
};
export const OUTCOMES: Record<Outcome, string> = {
  matched: "신호 찾음",
  matched_harmonic: "배수 주기 보정",
  duplicate: "기존 성과",
  not_matched: "신호 미일치",
  ambiguous_match: "여러 신호와 겹침",
  none_wrong: "신호 없음 판단 오류",
  skipped: "건너뛰기",
};
export const TYPES: Record<SignalType, string> = {
  confirmed: "확인된 행성",
  fp: "행성 아님",
  unconfirmed: "아직 확인 안 된 신호",
};
export const STATUSES: Record<ProgressStatus, string> = {
  unexplored: "미탐사",
  in_progress: "진행 중",
  complete: "탐색 완료",
};
export const TAGS: Record<Tag, string> = {
  DISCUSSION: "토론",
  QUESTION: "질문",
  OBSERVATION: "관측 기록",
  INFORMATION: "정보 공유",
};
export const EVIDENCE = ["홀짝 깊이", "2차 식", "V/U형", "품질 구간"];
