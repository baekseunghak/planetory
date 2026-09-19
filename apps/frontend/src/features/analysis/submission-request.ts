// 요청 ID의 생성·보존 규칙. 개발 안내 「요청 ID 규칙」을 구현한다.
//
// 새 ID는 사용자가 본문을 바꿔 다시 제출할 때와 서버가 본문을 새로 만들라고
// 할 때(`BUNDLE_CHANGED`·`IDEMPOTENCY_CONFLICT`)만 만든다. 응답 유실·처리
// 중·by-request 404·타임아웃·새로고침은 모두 같은 ID를 유지한다.

// 로그아웃 시 초안 정리가 함께 지우도록 같은 접두사를 쓴다.
// 공용 파일(auth/session-draft-storage.ts)을 수정하지 않기 위한 선택이다.
const PREFIX = "planetory:analysis-draft:";

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
// 저장소 접근 자체가 던질 수 있다(비공개 모드, 차단된 사이트 데이터).
export function sessionStore(): Store | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
export const submissionStorageKey = (memberId: string, ticId: string) =>
  `${PREFIX}${JSON.stringify([memberId, ticId, "submission"])}`;

export type PendingSubmission = {
  schema: 1;
  requestId: string;
  /** 이 ID로 보낸 본문의 지문. 본문이 바뀌면 이 ID를 쓰지 않는다. */
  fingerprint: string;
};

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const newRequestId = (): string => crypto.randomUUID();

/**
 * 본문 지문. 키 순서와 무관하게 같은 본문이면 같은 값이 나온다.
 *
 * `requestId`는 뺀다. 지금 정하려는 것이 그 값이기 때문이다.
 *
 * 개발용 응답에도 같은 계산이 있지만 **일부러 공유하지 않는다.** 한쪽 구현이
 * 틀려도 양쪽이 같이 틀리면 검사가 통과해 버린다. 서버 자리의 계산과 클라이언트의
 * 계산은 따로 두어야 어긋남이 드러난다.
 */
export function submissionFingerprint(input: unknown): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([key, item]) => key !== "requestId" && item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    // 유한하지 않은 수는 JSON이 null로 만든다. 서로 다른 본문이 같은 지문을
    // 갖지 않도록 구분해서 적는다.
    if (typeof value === "number" && !Number.isFinite(value))
      return `"#${String(value)}"`;
    return JSON.stringify(value) ?? "null";
  };
  return canonical(input);
}

export function readPendingSubmission(
  key: string,
  store: Store | null = sessionStore(),
): PendingSubmission | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingSubmission;
    if (
      !value ||
      value.schema !== 1 ||
      typeof value.requestId !== "string" ||
      !UUID_V4.test(value.requestId) ||
      typeof value.fingerprint !== "string" ||
      !value.fingerprint
    )
      throw new Error("손상된 요청 기록");
    return value;
  } catch {
    // 읽을 수 없는 기록은 없는 것으로 본다. 이 경우 새 ID가 만들어지므로
    // 같은 본문을 두 번 접수할 수 있지만, 손상된 ID로 남의 결과를 받아오는
    // 것보다는 낫다. 서버가 400을 주면 본문 자체가 문제인 것이다.
    try {
      store.removeItem(key);
    } catch {
      /* 지우지 못해도 아래에서 새 기록으로 덮어쓴다. */
    }
    return null;
  }
}

export type ReservedRequest = {
  requestId: string;
  /** 보존한 ID를 다시 쓰는가. 화면 문구와 복구 경로가 이 값으로 갈린다. */
  reused: boolean;
  /** 저장소에 남기지 못했다. 새로고침하면 ID를 잃는다. */
  volatile: boolean;
};

/**
 * 이 본문으로 보낼 요청 ID를 정한다. 저장된 ID의 지문이 같으면 그대로 쓰고,
 * 다르면 사용자가 본문을 바꾼 것이므로 새로 만든다.
 *
 * 저장에 실패해도 제출을 막지 않는다. ID는 이번 시도에서 유효하고, 잃는 것은
 * 새로고침 뒤의 복구뿐이다. 그 사실을 `volatile`로 알린다.
 */
export function reserveRequestId(
  key: string,
  fingerprint: string,
  store: Store | null = sessionStore(),
): ReservedRequest {
  const pending = readPendingSubmission(key, store);
  // 저장소가 없으면 읽기도 null이므로 여기서 재사용은 저장된 기록뿐이다.
  if (pending && pending.fingerprint === fingerprint)
    return { requestId: pending.requestId, reused: true, volatile: false };
  const requestId = newRequestId();
  const record: PendingSubmission = { schema: 1, requestId, fingerprint };
  try {
    if (!store) throw new Error("저장소 없음");
    store.setItem(key, JSON.stringify(record));
    return { requestId, reused: false, volatile: false };
  } catch {
    return { requestId, reused: false, volatile: true };
  }
}

/**
 * 보존한 ID를 버린다. **서버가 본문을 새로 만들라고 한 경우에만** 부른다
 * (`BUNDLE_CHANGED`·`IDEMPOTENCY_CONFLICT`·접근 거절). 결과를 모르는 상태에서
 * 부르면 다음 제출이 새 ID를 만들어 중복 접수가 된다.
 */
export function releaseRequestId(
  key: string,
  store: Store | null = sessionStore(),
): void {
  try {
    store?.removeItem(key);
  } catch {
    /* 지우지 못해도 다음 예약이 새 지문으로 덮어쓴다. */
  }
}
