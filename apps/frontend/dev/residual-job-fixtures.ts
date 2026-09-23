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
  // 다시 시도해도 같은 실패다(`failure.retryable: false`).
  | "fail-permanent"
  // 잔차 계산 기반이 아직 연결되지 않았다. 다시 요청해도 같은 결과라
  // 503 본문이 `retryable: false`다(7.1절).
  | "unavailable"
  // 실행기를 시작하지 못했다. 같은 503이지만 **화면이 할 일이 반대**라
  // `retryable: true`다. 서버는 그 작업을 `START_FAILED`로 끝낸다.
  | "start-failed"
  // `retryable`을 싣지 않는 503. `S15P21C206-249` 전의 서버이며, 화면이
  // 필드를 읽기 시작했는데 서버가 아직 안 보내는 **배포 순서의 창**이다.
  // 88이 붙어 서버가 늘 필드를 실으면 지운다.
  | "unavailable-legacy"
  // 계산이 도는 동안 판이 바뀐다. 폴링 응답 헤더로만 드러난다(D-5).
  | "plate-changed"
  // 캐시를 건너뛰고 매번 새로 계산한다. **검사 전용**이다. 목표를 몰래
  // 바꿔 캐시를 피하면 서버가 돌려주는 문맥과 화면이 들고 있는 목표가
  // 달라져, 실제로는 일어날 수 없는 상태가 만들어진다.
  | "fresh"
  // 대기열이 찼다. 기다리는 안내다.
  | "queue-full"
  // 같은 회원의 다른 작업이 진행 중이다(D-4). 무엇이 막는지 알려야 한다.
  | "other-job"
  // 판이 바뀌었다.
  | "bundle-changed"
  // 계산 도중 작업이 사라진다(Redis 재시작). 7.1절로 다시 요청해야 한다.
  | "lose-job";
const scenarios: ResidualScenario[] = [
  "fail",
  // 다시 시도해도 같은 실패. 7.2절 `failure.retryable: false`다.
  "fail-permanent",
  // 잔차 계산 기반이 아직 연결되지 않았다(`retryable: false`).
  "unavailable",
  // 실행기 시작 실패. 같은 503이지만 다시 요청하는 것이 맞다(`retryable: true`).
  "start-failed",
  // 249 전의 서버. 503에 `retryable`이 없다 — 화면은 참으로 읽어야 한다.
  "unavailable-legacy",
  // 계산이 도는 동안 판이 바뀐다. 폴링 응답 헤더로만 드러난다(D-5).
  "plate-changed",
  "fresh",
  "queue-full",
  "other-job",
  "bundle-changed",
  "lose-job",
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
  /** 다시 시도해도 같은 실패다. `failure.retryable: false`로 나간다. */
  permanent?: boolean;
  /** 폴링 응답에 다른 판을 실어 계산 도중 교체를 흉내 낸다. */
  plateChanged?: boolean;
  /** 다음 조회에서 사라진다. 한 목표당 한 번만이다. */
  lose: boolean;
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
/** 이미 한 번 사라진 목표. 다시 요청하면 정상으로 간다. */
const lostOnce = new Set<string>();
/**
 * 곡선을 내줄 수 있는 제거 조합. 계산이 끝나야 그 단계의 곡선이 생긴다
 * (5.2절). 곡선 조회에는 모델·설정 버전이 실리지 않으므로 별·판·조합만으로
 * 찾는다.
 */
const computedCurves = new Set<string>();
const curveKey = (ticId: string, bundleId: string, removed: string[]) =>
  `${ticId}:${bundleId}:${[...removed].sort().join(",")}`;
/** 그 조합의 곡선이 준비됐는가. 개발용 곡선 응답이 묻는다. */
export const residualCurveReady = (
  ticId: string,
  bundleId: string,
  removed: string[],
): boolean => computedCurves.has(curveKey(ticId, bundleId, removed));
const byId = new Map<string, Job>();
let serial = 0;

export function resetResidualFixture(): void {
  completed.clear();
  lostOnce.clear();
  computedCurves.clear();
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

export type FixtureReply = {
  status: number;
  body: unknown;
  /** D-5 현재 판 헤더. 주지 않으면 붙이지 않는다(= 모름). */
  headers?: Record<string, string>;
};
/**
 * 503 `DEPENDENCY_UNAVAILABLE`의 **정본 문구 두 개**를 비추는 값이다. 탐사 API
 * 7.1절이 두 문장을 그대로 적고 「위 두 문장이 정본이다. 백엔드 검사와 프론트
 * 개발용 응답이 같은 값을 들고 있으므로, 바꾸려면 이 줄과 양쪽을 한 번에
 * 바꾼다」고 못박았다(`S15P21C206-249`).
 *
 * 화면은 이 `message`를 사용자에게 **그대로** 보여 준다. 그래서 여기에 코드
 * 이름을 넣으면 화면 검사가 「실제로 무엇이 보이는지」를 한 번도 보지 못한다.
 * 실제로 그렇게 눈이 멀어, 재시도 버튼을 숨겨 놓고 문구로는 다시 시도하라고
 * 말하는 상태를 검사가 통과시켰다(`S15P21C206-147` 리뷰).
 */
export const DEPENDENCY_UNAVAILABLE_MESSAGE = {
  /** 계산 기반 미연결. 다시 요청해도 같은 결과다(`retryable: false`). */
  notConnected: "잔차 계산 기능이 아직 준비되지 않았습니다.",
  /**
   * 공통 기본 문구. `ErrorCode.DEPENDENCY_UNAVAILABLE`의 기본값과 같은 값이다.
   *
   * 두 곳이 쓴다 — **실행기 시작 실패**(`retryable: true`)가 이 문구를 쓰는 것이
   * 맞고, `S15P21C206-249` **전의 서버는 미연결에도** 이 문구로 답했다
   * (`unavailable-legacy`). 한쪽 이름을 붙이면 다른 쪽에서 거짓이 된다.
   */
  serverDefault: "일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
} as const;

const fail = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  // 문구를 주지 않은 실패는 코드 이름을 그대로 쓴다. 화면이 옮겨 보여 주는
  // 자리에만 실제 문장을 준다 — 나머지는 개발용 응답임이 드러나는 편이 낫다.
  message: string = code,
) => ({
  status,
  body: { code, message, fieldErrors: [], ...extra },
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
  // 같은 코드·같은 상태지만 `retryable`이 화면의 할 일을 가른다(7.1절).
  if (scenario === "unavailable")
    return fail(
      503,
      "DEPENDENCY_UNAVAILABLE",
      { retryable: false },
      DEPENDENCY_UNAVAILABLE_MESSAGE.notConnected,
    );
  if (scenario === "start-failed")
    return fail(
      503,
      "DEPENDENCY_UNAVAILABLE",
      { retryable: true },
      DEPENDENCY_UNAVAILABLE_MESSAGE.serverDefault,
    );
  // **필드를 싣지 않는다.** 249 전의 서버이고, 화면이 없는 값을 참으로 읽는지
  // 보는 것이 이 시나리오의 전부다.
  if (scenario === "unavailable-legacy")
    return fail(
      503,
      "DEPENDENCY_UNAVAILABLE",
      {},
      DEPENDENCY_UNAVAILABLE_MESSAGE.serverDefault,
    );
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
  // **시나리오가 있으면 캐시를 쓰지 않는다.** 「이렇게 굴어라」는 지시이지
  // 「저장된 것을 내놔라」가 아니다. 캐시가 지시를 덮으면 검사가 엉뚱한
  // 경로를 본다.
  if (completed.has(key) && scenario === null)
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
  if (existing && scenario === null)
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
    fail: scenario === "fail" || scenario === "fail-permanent",
    permanent: scenario === "fail-permanent",
    plateChanged: scenario === "plate-changed",
    lose: scenario === "lose-job" && !lostOnce.has(key),
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
  if (!job) return fail(404, "RESOURCE_NOT_FOUND");
  // 계산이 시작된 뒤 사라진다. 클라이언트는 같은 목표로 7.1절을 다시 부른다.
  if (job.lose && job.step >= 1) {
    byId.delete(job.jobId);
    running.delete(job.key);
    lostOnce.add(job.key);
    return fail(404, "RESOURCE_NOT_FOUND");
  }
  // 실패는 주기도 계산 직전에 낸다. 중간 단계 표시가 지워지지 않는지 본다.
  const failing = job.fail && job.step >= FLOW.length - 2;
  if (job.step < FLOW.length - 1 && !failing) job.step += 1;
  const status = failing ? "FAILED" : FLOW[job.step];
  // **돌려주는 그 응답에서** 캐시에 적는다. 다음 조회까지 미루면 완료를 본
  // 클라이언트가 같은 목표를 다시 요청했을 때 캐시가 없다.
  if (failing || status === "COMPLETED") {
    running.delete(job.key);
    if (!failing) {
      completed.add(job.key);
      // 이 조합의 곡선이 이제 존재한다.
      computedCurves.add(
        curveKey(
          job.ticId,
          job.target.bundleId,
          job.target.removedCandidateIds,
        ),
      );
    }
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
        ? {
            code: "RESIDUAL_FAILED",
            message: "잔차 계산에 실패했습니다.",
            // 실제 서버가 함께 준다. 화면이 재시도를 낼지 여기서 갈린다.
            retryable: job.permanent !== true,
          }
        : null,
      resultCurveContext:
        status === "COMPLETED" ? resultContext(job.target) : null,
      pollAfterSeconds: 0,
    },
    // D-5. 판이 바뀌면 조회 시점의 현재 판이 실린다. 평소에는 진입 때와
    // 같은 판이라 화면이 아무 일도 하지 않는다.
    headers: {
      "X-Current-Bundle": job.plateChanged
        ? "9007199254749999"
        : job.target.bundleId,
    },
  };
}
