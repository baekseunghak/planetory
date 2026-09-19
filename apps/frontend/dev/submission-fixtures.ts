// Synthetic submission fixtures, version submission-fixture-187-v1.
// See docs/analysis-submission.md and 탐사 API 2.2·2.3·6.1~6.6.
//
// NOT a server reimplementation. It keeps the idempotency store and the checks a
// frontend can actually get wrong (요청 ID, 판, 곡선 단계, 종류별 필드, enum,
// 위상 규칙), and leaves 후보 매칭·성과 판정·격자 대조 to the real server (C10).
// State lives in this dev process only and resets when the server restarts.

export const SUBMISSION_FIXTURE_CSRF = "analysis-fixture-187";
// Dev-only trigger for the two cases that cannot arise from real state.
// The app never sends it; tests and manual checks set it on the request.
export const SUBMISSION_FIXTURE_HEADER = "x-fixture-submit";
export type SubmissionScenario =
  // 접수까지 끝난 뒤 응답만 끊는다. by-request로 복구하면 200.
  | "drop-saved"
  // 접수 전에 끊는다. by-request 404 뒤 같은 ID 재전송이 201이어야 한다.
  | "drop-unsaved"
  // 처리 중. POST와 첫 by-request가 409, 그다음 조회가 200.
  | "in-progress";
const scenarios: SubmissionScenario[] = [
  "drop-saved",
  "drop-unsaved",
  "in-progress",
];
export const readScenario = (value: unknown): SubmissionScenario | null =>
  scenarios.find((item) => item === value) ?? null;

export type SubmissionFixtureReply =
  | { kind: "json"; status: number; body: unknown; currentBundleId?: string }
  // 소켓을 끊어 응답 유실을 재현한다. 상태 코드가 없는 것이 요점이다.
  | { kind: "drop" };

type Stored = {
  ticId: string;
  fingerprint: string;
  result: Record<string, unknown>;
};
const accepted = new Map<string, Stored>();
// 남은 REQUEST_IN_PROGRESS 응답 횟수. 0이 되면 저장된 결과를 돌려준다.
const holding = new Map<string, { remaining: number }>();
let sequence = 7000;
export function resetSubmissionFixtures() {
  accepted.clear();
  holding.clear();
  sequence = 7000;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JUDGMENTS = ["LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE"];
const EVIDENCE = ["oddeven", "secondary", "ushape"];
const KINDS = ["candidate", "no_candidate", "skipped"];
const MEMO_MAX = 2000;

// 본문 일치는 서버가 해시로 판정한다(6.3절 1번). 키 순서를 정규화해 비교한다.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const json = (
  status: number,
  body: unknown,
  currentBundleId?: string,
): SubmissionFixtureReply => ({ kind: "json", status, body, currentBundleId });
const fail = (
  status: number,
  code: string,
  message: string,
  fieldErrors: { field: string; reason: string }[] = [],
  extra: Record<string, unknown> = {},
) => json(status, { code, message, fieldErrors, ...extra });
const invalid = (field: string, reason: string) =>
  fail(400, "VALIDATION_FAILED", "입력을 확인해 주세요.", [{ field, reason }]);

type ContextProbe = { status: number; body: unknown } | null;

const storedBundle = (stored: Stored) =>
  typeof stored.result.bundleId === "string"
    ? stored.result.bundleId
    : undefined;

/**
 * 6.2절 순서대로 검사하고 첫 실패에서 돌려준다. 제출 종류별 필드 유무를
 * 여기서 막는다. `no_candidate`에 이전 후보의 수치·판단·근거가 섞이면
 * 접수하지 않는 것이 이 티켓의 완료 조건이다.
 */
function validate(
  body: Record<string, unknown>,
  context: Record<string, unknown>,
): SubmissionFixtureReply | null {
  const kind = body.submissionKind;
  if (typeof kind !== "string" || !KINDS.includes(kind))
    return invalid("submissionKind", "Unknown submission kind");

  const current = record(context.currentCurveContext);
  const sent = record(body.curveContext);
  if (!current) return fail(500, "FIXTURE_ERROR", "테스트 응답 오류입니다.");
  if (!sent) return invalid("curveContext", "Invalid input");
  // 2번: 판·계산 버전이 현재와 같아야 한다. 쓰기는 헤더가 아니라 409로 거절한다.
  if (
    sent.bundleId !== current.bundleId ||
    sent.residualModelVersion !== current.residualModelVersion ||
    sent.periodogramConfigVersion !== current.periodogramConfigVersion
  )
    return fail(
      409,
      "BUNDLE_CHANGED",
      "새 데이터 판을 다시 불러와 주세요.",
      [],
      { currentBundleId: current.bundleId },
    );
  // 3번: 제거 조합과 단계. 마지막 제출 단계와 같을 필요는 없다(EXP-09).
  const removed = sent.removedCandidateIds;
  const allowed = current.removedCandidateIds;
  if (
    !Array.isArray(removed) ||
    !Array.isArray(allowed) ||
    removed.some((item) => !allowed.includes(item)) ||
    new Set(removed).size !== removed.length ||
    sent.curveStep !== removed.length
  )
    return invalid("curveContext", "Invalid input");

  if (kind === "candidate") {
    const selection = record(body.selection);
    if (!selection) return invalid("selection", "Invalid input");
    // 4번: 주기·위상의 유한·순서 규칙.
    if (!finite(selection.periodDays) || selection.periodDays <= 0)
      return invalid("selection.periodDays", "Invalid input");
    const { phaseStart, phaseEnd } = selection;
    if (
      !finite(phaseStart) ||
      !finite(phaseEnd) ||
      phaseStart < 0 ||
      phaseStart >= 1 ||
      phaseEnd <= phaseStart ||
      phaseEnd >= phaseStart + 1
    )
      return invalid("selection.phaseEnd", "Invalid input");
    if (!(
      selection.sourcePeakGridIndex === null ||
      (Number.isSafeInteger(selection.sourcePeakGridIndex) &&
        (selection.sourcePeakGridIndex as number) >= 0)
    ))
      return invalid("selection.sourcePeakGridIndex", "Invalid input");
    // 5번 중 시간 최소·위상 최대. 봉우리별 duration 상한은 서버가 본다.
    const rules = record(context.selectionRules);
    const width = (phaseEnd as number) - (phaseStart as number);
    if (rules) {
      if (
        finite(rules.minWindowDays) &&
        width * (selection.periodDays as number) < rules.minWindowDays
      )
        return invalid("selection.phaseEnd", "Selected window is too short");
      if (finite(rules.phaseWidthMax) && width > rules.phaseWidthMax)
        return invalid("selection.phaseEnd", "Selected window is too wide");
    }
    // 8번: enum과 허용 목록. 중심 위치 등 그 외 근거 값은 400이다(POL-13).
    if (
      typeof body.userJudgment !== "string" ||
      !JUDGMENTS.includes(body.userJudgment)
    )
      return invalid("userJudgment", "Invalid input");
    const evidence = body.evidenceChecks ?? [];
    if (
      !Array.isArray(evidence) ||
      evidence.length > EVIDENCE.length ||
      new Set(evidence).size !== evidence.length ||
      evidence.some((item) => !EVIDENCE.includes(item as string))
    )
      return invalid("evidenceChecks", "Invalid input");
    const memo = body.memo ?? "";
    if (typeof memo !== "string" || Array.from(memo).length > MEMO_MAX)
      return invalid("memo", "Memo is too long");
  } else {
    // 6.5절: 특수 제출은 이 세 필드를 아예 갖지 않는다.
    for (const field of ["selection", "userJudgment", "evidenceChecks"])
      if (body[field] !== undefined)
        return invalid(field, `Not allowed for ${kind}`);
    const progress = record(context.progress);
    if (kind === "no_candidate" && progress?.stage === "completed")
      return fail(409, "STAR_ALREADY_COMPLETED", "이미 완료한 별입니다.");
    if (kind === "skipped" && !record(context.tutorial)?.skipAvailable)
      return fail(409, "SKIP_NOT_AVAILABLE", "지금은 건너뛸 수 없습니다.");
  }
  if (body.retryOfSubmissionId != null)
    return invalid("retryOfSubmissionId", "Not supported by this fixture");
  return null;
}

/** 6.4절 `submissionResult`. 매칭·성과는 합성 고정값이며 계산 결과가 아니다. */
function buildResult(
  ticId: string,
  body: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const id = sequence++;
  const kind = body.submissionKind as string;
  const bundle = record(context.bundle) ?? {};
  const reference = finite(bundle.foldReferenceTimeBtjd)
    ? bundle.foldReferenceTimeBtjd
    : 0;
  const selection = record(body.selection);
  const period = finite(selection?.periodDays) ? selection!.periodDays : 0;
  const start = finite(selection?.phaseStart) ? selection!.phaseStart : 0;
  const end = finite(selection?.phaseEnd) ? selection!.phaseEnd : 0;
  const center = (start + end) / 2;
  const derived = selection
    ? {
        foldReferenceTimeBtjd: reference,
        phaseCenter: center - Math.floor(center),
        epochBtjd: reference + (center - Math.floor(center)) * period,
        durationHours: (end - start) * period * 24,
        sourcePeakSuggestedDurationHours:
          selection.sourcePeakGridIndex === null ? null : 2,
        durationLimitHours: selection.sourcePeakGridIndex === null ? null : 6,
        centroidDataStatus: "unavailable",
      }
    : null;
  const matchStatus =
    kind === "no_candidate"
      ? "none_wrong"
      : kind === "skipped"
        ? "skipped"
        : "not_matched";
  return {
    submissionId: `sub-${id}`,
    historyId: `h-${id}`,
    requestId: body.requestId,
    ticId,
    bundleId: record(context.currentCurveContext)?.bundleId,
    ruleVersion: context.ruleVersion ?? "rule-fixture-187",
    submittedAt: "2026-09-19T02:30:00Z",
    submissionKind: kind,
    curveContext: body.curveContext,
    original: selection
      ? {
          ...selection,
          userJudgment: body.userJudgment,
          evidenceChecks: body.evidenceChecks ?? [],
          memo: body.memo ?? "",
          viewState: body.viewState ?? null,
        }
      : null,
    serverDerived: derived,
    // 미매칭은 signal·통계를 주지 않는다(AT-14·75). 결과 해설은 A06-2 범위다.
    match: { status: matchStatus, candidateId: null },
    signal: null,
    judgment:
      kind === "candidate"
        ? { value: body.userJudgment, evaluation: "NOT_APPLICABLE" }
        : null,
    skyVersion: "u-187:1",
    achievement: {
      // ERD achievement_result CHECK 그대로. 미매칭이라 성과 판정 자체가 없다.
      result: "none",
      newlyRecognized: false,
      unlockedStars: [],
      star: { count: 0, grade: null, byType: null },
    },
    progress: {
      stage: kind === "skipped" ? "completed" : "in_progress",
      completionReason: kind === "skipped" ? "skipped" : null,
      reopenPending: false,
      currentCurveStep: record(body.curveContext)?.curveStep ?? 0,
      matchedCandidateIds:
        record(context.currentCurveContext)?.removedCandidateIds ?? [],
      remainingDiscoverableCount: 1,
    },
    publication: { state: "NOT_ELIGIBLE", publicAnalysisId: null },
    judgmentStatistics: null,
    detail: {
      available: kind !== "skipped",
      targetKind: kind === "skipped" ? null : "CURRENT_CURVE_HINT",
      answerViewed: false,
    },
    tutorial: context.tutorial ?? { seq: null, skipAvailable: false },
    nextActions: kind === "skipped" ? ["GO_HOME"] : ["NEXT_CURVE", "LATER"],
  };
}

export function submissionFixtureResponse(options: {
  method: string;
  url: URL;
  csrf: unknown;
  scenario: SubmissionScenario | null;
  body: unknown;
  /** 분석 진입 응답을 그대로 쓴다. 403·404·503 접근 거절을 함께 재사용한다. */
  contextFor: (ticId: string) => ContextProbe;
}): SubmissionFixtureReply | null {
  const { method, url, csrf, scenario, body, contextFor } = options;
  const byRequest = /^\/v1\/submissions\/by-request\/([^/]+)$/.exec(
    url.pathname,
  );
  if (byRequest && method === "GET") {
    const requestId = byRequest[1];
    const held = holding.get(requestId);
    if (held && held.remaining > 0) {
      held.remaining -= 1;
      return fail(409, "REQUEST_IN_PROGRESS", "같은 요청을 처리하고 있습니다.");
    }
    const stored = accepted.get(requestId);
    // 404는 미접수를 뜻하지만, 프론트는 이를 단정하지 않고 같은 ID로 재전송한다.
    return stored
      ? json(200, stored.result, storedBundle(stored))
      : fail(404, "SUBMISSION_NOT_FOUND", "접수 기록이 없습니다.");
  }

  const post = /^\/v1\/stars\/([^/]+)\/submissions$/.exec(url.pathname);
  if (!post) return null;
  if (method !== "POST")
    return fail(405, "METHOD_NOT_ALLOWED", "지원하지 않는 요청입니다.");
  if (csrf !== SUBMISSION_FIXTURE_CSRF)
    return fail(403, "CSRF_TOKEN_INVALID", "인증 정보를 확인해 주세요.");

  const ticId = post[1];
  const probe = contextFor(ticId);
  if (!probe) return fail(404, "STAR_NOT_PUBLISHED", "이 별을 볼 수 없습니다.");
  // 1번: 인증·published·별 열림. 진입 응답의 거절을 그대로 쓴다.
  if (probe.status !== 200) return json(probe.status, probe.body);
  const context = record(probe.body);
  if (!context) return fail(500, "FIXTURE_ERROR", "테스트 응답 오류입니다.");
  const reply = submit(ticId, context, { scenario, body });
  // 이 별의 현재 판을 응답 헤더에 실어야 프론트가 판 교체로 오인하지 않는다.
  const bundleId = record(context.currentCurveContext)?.bundleId;
  return reply.kind === "json" && typeof bundleId === "string"
    ? { ...reply, currentBundleId: reply.currentBundleId ?? bundleId }
    : reply;
}

function submit(
  ticId: string,
  context: Record<string, unknown>,
  options: { scenario: SubmissionScenario | null; body: unknown },
): SubmissionFixtureReply {
  const { scenario, body } = options;
  const input = record(body);
  if (!input) return invalid("body", "Invalid input");

  const requestId = input.requestId;
  if (typeof requestId !== "string" || !UUID_V4.test(requestId))
    return invalid("requestId", "Invalid input");

  // 6.3절 1번: 저장된 행을 먼저 본다. 본문이 같으면 재현, 다르면 거절한다.
  const fingerprint = canonical(input);
  const stored = accepted.get(requestId);
  if (stored)
    return stored.fingerprint === fingerprint
      ? json(200, stored.result, storedBundle(stored))
      : fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 번호로 다른 내용을 보냈습니다.",
        );
  const held = holding.get(requestId);
  if (held && held.remaining > 0) {
    held.remaining -= 1;
    return fail(409, "REQUEST_IN_PROGRESS", "같은 요청을 처리하고 있습니다.");
  }

  const rejected = validate(input, context);
  if (rejected) return rejected;

  const result = buildResult(ticId, input, context);
  if (scenario === "drop-unsaved") return { kind: "drop" };
  if (scenario === "in-progress") {
    // 한 번만 처리 중으로 답하고, 그동안 접수는 끝난 것으로 둔다.
    holding.set(requestId, { remaining: 1 });
    accepted.set(requestId, { ticId, fingerprint, result });
    return fail(409, "REQUEST_IN_PROGRESS", "같은 요청을 처리하고 있습니다.");
  }
  accepted.set(requestId, { ticId, fingerprint, result });
  if (scenario === "drop-saved") return { kind: "drop" };
  return json(201, result);
}
