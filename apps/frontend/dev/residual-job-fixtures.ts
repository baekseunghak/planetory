// 개발용 잔차 작업 응답(7.1·7.2절). 실제 계산은 하지 않는다.
//
// **상태를 시간이 아니라 조회 횟수로 전진시킨다.** 시계에 기대면 테스트가
// 느려지거나 흔들리고, 화면이 순서를 진짜로 그리는지 보이지 않는다.
//
// 캐시 키는 명세 그대로 목표 문맥이다. 요청 ID는 쓰지 않는다(7.1절).

/** 2.4절 순서. `FAILED`는 어느 단계에서든 갈 수 있다. */
const FLOW = [
  "QUEUED",
  "RESIDUAL_CALCULATING",
  "RESIDUAL_READY",
  "PERIODOGRAM_CALCULATING",
  "COMPLETED",
] as const;

export type ResidualTarget = {
  bundleId: string;
  removedCandidateIds: string[];
  residualModelVersion: string;
  periodogramConfigVersion: string;
};

export const RESIDUAL_FIXTURE_HEADER = "x-fixture-residual";
/** 클릭으로 만들 수 없는 상황만 헤더로 고른다. */
export type ResidualScenario =
  // 이 목표의 계산이 실패한다. 마지막 정상 곡선은 유지돼야 한다.
  | "fail"
  // 대기열이 찼다. 기다리는 안내다.
  | "queue-full"
  // 같은 회원의 다른 작업이 진행 중이다(D-4). 그쪽으로 데려가야 한다.
  | "other-job"
  // 판이 바뀌었다.
  | "bundle-changed";
const scenarios: ResidualScenario[] = [
  "fail",
  "queue-full",
  "other-job",
  "bundle-changed",
];
export const readResidualScenario = (value: unknown): ResidualScenario | null =>
  scenarios.find((item) => item === value) ?? null;

type Job = {
  jobId: string;
  ticId: string;
  target: ResidualTarget;
  key: string;
  /** 다음 조회에서 내놓을 단계. FLOW의 색인이다. */
  step: number;
  fail: boolean;
  attempt: number;
};

const cacheKey = (ticId: string, target: ResidualTarget) =>
  `tic:${ticId}:b${target.bundleId}:rm${[...target.removedCandidateIds]
    .sort()
    .join(
      ",",
    )}:${target.residualModelVersion}:${target.periodogramConfigVersion}`;

/** 완료된 목표. 같은 키를 다시 요청하면 계산하지 않고 그대로 돌려준다. */
const completed = new Set<string>();
/** 진행 중인 작업. 같은 키는 하나만 계산한다(SETNX). */
const running = new Map<string, Job>();
const byId = new Map<string, Job>();
let serial = 0;

export function resetResidualFixture(): void {
  completed.clear();
  running.clear();
  byId.clear();
  serial = 0;
}

const targetOf = (value: unknown): ResidualTarget | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = (value as { target?: unknown }).target;
  if (typeof row !== "object" || row === null) return null;
  const t = row as Record<string, unknown>;
  const ids = Array.isArray(t.removedCandidateIds)
    ? t.removedCandidateIds
    : null;
  if (
    typeof t.bundleId !== "string" ||
    !ids ||
    !ids.every((id) => typeof id === "string") ||
    typeof t.residualModelVersion !== "string" ||
    typeof t.periodogramConfigVersion !== "string"
  )
    return null;
  return {
    bundleId: t.bundleId,
    removedCandidateIds: ids as string[],
    residualModelVersion: t.residualModelVersion,
    periodogramConfigVersion: t.periodogramConfigVersion,
  };
};

const resultContext = (target: ResidualTarget) => ({
  bundleId: target.bundleId,
  curveStep: target.removedCandidateIds.length,
  removedCandidateIds: [...target.removedCandidateIds].sort(),
  residualModelVersion: target.residualModelVersion,
  periodogramConfigVersion: target.periodogramConfigVersion,
});

export type FixtureReply = { status: number; body: unknown };
const fail = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
) => ({
  status,
  body: { code, message: code, fieldErrors: [], ...extra },
});

/** 7.1절 요청. */
export function requestResidualJobFixture(options: {
  ticId: string;
  body: unknown;
  scenario: ResidualScenario | null;
}): FixtureReply {
  const { ticId, body, scenario } = options;
  const target = targetOf(body);
  if (!target) return fail(400, "VALIDATION_FAILED");
  // 빈 배열은 원본이므로 작업이 아니다(7.1절).
  if (target.removedCandidateIds.length === 0)
    return fail(400, "VALIDATION_FAILED");
  if (scenario === "bundle-changed")
    return fail(409, "BUNDLE_CHANGED", { currentBundleId: "9007199254749999" });
  if (scenario === "queue-full")
    return fail(429, "RESIDUAL_QUEUE_FULL", { retryAfterSeconds: 12 });
  if (scenario === "other-job")
    return fail(429, "RESIDUAL_QUEUE_FULL", {
      retryAfterSeconds: 5,
      activeJobId: "rj-other",
    });

  const key = cacheKey(ticId, target);
  if (completed.has(key))
    return {
      status: 200,
      body: {
        jobId: null,
        status: "COMPLETED",
        cacheHit: true,
        resultCurveContext: resultContext(target),
      },
    };
  const existing = running.get(key);
  if (existing)
    // 같은 키는 하나만 계산한다. 그 작업의 상태를 그대로 돌려준다.
    return {
      status: 202,
      body: {
        jobId: existing.jobId,
        status: FLOW[existing.step],
        cacheHit: false,
        queuePosition: 1,
        estimatedSeconds: 20,
        pollAfterSeconds: 0,
      },
    };
  const job: Job = {
    jobId: `rj-${++serial}`,
    ticId,
    target,
    key,
    step: 0,
    fail: scenario === "fail",
    attempt: 1,
  };
  running.set(key, job);
  byId.set(job.jobId, job);
  return {
    status: 202,
    body: {
      jobId: job.jobId,
      status: "QUEUED",
      cacheHit: false,
      queuePosition: 3,
      estimatedSeconds: 40,
      // 개발 서버에서는 기다리지 않는다. 폴링 간격은 단위 검사가 본다.
      pollAfterSeconds: 0,
    },
  };
}

/** 7.2절 상태 조회. 부를 때마다 한 단계 전진한다. */
export function pollResidualJobFixture(jobId: string): FixtureReply {
  const job = byId.get(jobId);
  if (!job) return fail(404, "NOT_FOUND");
  // 실패는 주기도 계산 직전에 낸다. 중간 단계 표시가 지워지지 않는지 본다.
  const failing = job.fail && job.step >= FLOW.length - 2;
  if (job.step < FLOW.length - 1 && !failing) job.step += 1;
  const status = failing ? "FAILED" : FLOW[job.step];
  // **돌려주는 그 응답에서** 캐시에 적는다. 다음 조회까지 미루면 완료를 본
  // 클라이언트가 같은 목표를 다시 요청했을 때 캐시가 없다.
  if (failing || status === "COMPLETED") {
    running.delete(job.key);
    if (!failing) completed.add(job.key);
  }
  return {
    status: 200,
    body: {
      jobId: job.jobId,
      ticId: job.ticId,
      target: job.target,
      status,
      attempt: job.attempt,
      timeline: {
        queuedAt: "2026-09-20T00:00:00Z",
        residualStartedAt: job.step >= 1 ? "2026-09-20T00:00:01Z" : null,
        residualReadyAt: job.step >= 2 ? "2026-09-20T00:00:02Z" : null,
        periodogramStartedAt: job.step >= 3 ? "2026-09-20T00:00:03Z" : null,
        completedAt: status === "COMPLETED" ? "2026-09-20T00:00:04Z" : null,
      },
      failure: failing
        ? { code: "RESIDUAL_FAILED", message: "잔차 계산에 실패했습니다." }
        : null,
      resultCurveContext:
        status === "COMPLETED" ? resultContext(job.target) : null,
      pollAfterSeconds: 0,
    },
  };
}
