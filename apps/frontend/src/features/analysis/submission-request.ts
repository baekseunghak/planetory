// 요청 ID의 생성·보존 규칙. 개발 안내 「요청 ID 규칙」을 구현한다.
//
// 새 ID는 사용자가 본문을 바꿔 다시 제출할 때와 서버가 본문을 새로 만들라고
// 할 때(`BUNDLE_CHANGED`·`IDEMPOTENCY_CONFLICT`)만 만든다. 응답 유실·처리
// 중·by-request 404·타임아웃·새로고침은 모두 같은 ID를 유지한다.

// 로그아웃 시 초안 정리가 함께 지우도록 같은 접두사를 쓴다.
// 공용 파일(auth/session-draft-storage.ts)을 수정하지 않기 위한 선택이다.
import type { SubmissionKind } from "./submission-data.ts";

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

/**
 * 저장소에 남기는 제출 기록. 새로고침·재진입 뒤에도 **미해결 요청을 되살리기
 * 위해** 요청 ID만이 아니라 무엇을 어떤 상태로 보냈는지까지 적는다.
 *
 * `schema`는 모양의 판번호다. 읽을 때 이 값으로 갈라 읽으며, 모르는 판은
 * 손상으로 본다.
 */
export type PendingSubmission = {
  schema: 2;
  requestId: string;
  /** 이 ID로 보낸 본문의 지문. 본문이 바뀌면 이 ID를 쓰지 않는다. */
  fingerprint: string;
  /** 무엇을 보냈는지. 판 1에서 올라온 기록에는 없다. */
  kind: SubmissionKind | null;
  /**
   * 보낸 본문 그대로. 같은 ID로 **정확히 같은 본문**을 보내야
   * `IDEMPOTENCY_CONFLICT`가 되지 않으므로 다시 만들지 않고 들고 있는다.
   * 없으면(판 1에서 올라온 기록) 조회만 할 수 있다.
   */
  body: Record<string, unknown> | null;
  /**
   * `pending` 결과를 아직 모른다. **다른 본문에 이 자리를 내주지 않는다.**
   * `accepted` 접수가 확정됐다. 같은 본문을 다시 보낼 때 ID를 재사용하는
   * 용도로만 남는다.
   */
  state: "pending" | "accepted";
  /** 보낸 시각. 되살린 안내에서 언제 것인지 말하는 데 쓴다. */
  sentAt: string | null;
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
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      !UUID_V4.test(value.requestId) ||
      typeof value.fingerprint !== "string" ||
      !value.fingerprint
    )
      throw new Error("손상된 요청 기록");
    // 판 1에는 ID와 지문밖에 없다. 버리지 않고 올린다. ID가 살아 있으면
    // 접수 여부는 확인할 수 있고, 본문이 없으니 재전송만 못 한다. 성공한
    // 기록인지 아닌지도 적혀 있지 않으므로 확인이 필요한 쪽으로 읽는다.
    if (value.schema === 1)
      return {
        schema: 2,
        requestId: value.requestId,
        fingerprint: value.fingerprint,
        kind: null,
        body: null,
        state: "pending",
        sentAt: null,
      };
    if (
      value.schema !== 2 ||
      (value.state !== "pending" && value.state !== "accepted") ||
      (value.kind !== null && typeof value.kind !== "string") ||
      (value.body !== null && typeof value.body !== "object") ||
      (value.sentAt !== null && typeof value.sentAt !== "string")
    )
      throw new Error("손상된 요청 기록");
    return value as PendingSubmission;
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

export type Reservation =
  | {
      status: "reserved";
      requestId: string;
      /** 보존한 ID를 다시 쓰는가. 화면 문구와 복구 경로가 이 값으로 갈린다. */
      reused: boolean;
      /** 저장소에 남기지 못했다. 새로고침하면 ID를 잃는다. */
      volatile: boolean;
    }
  /**
   * 결과를 모르는 요청이 이미 있어 **보내지 않았다.** 다른 본문에 자리를
   * 내주면 그 요청의 복구 경로가 사라지고, 같은 일을 두 번 접수할 수 있다.
   */
  | { status: "blocked"; pending: PendingSubmission };

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
  sent: { kind: SubmissionKind; body: Record<string, unknown> },
  store: Store | null = sessionStore(),
): Reservation {
  const pending = readPendingSubmission(key, store);
  // 저장소가 없으면 읽기도 null이므로 여기서 재사용은 저장된 기록뿐이다.
  if (pending && pending.fingerprint === fingerprint)
    return {
      status: "reserved",
      requestId: pending.requestId,
      reused: true,
      volatile: false,
    };
  // 본문이 달라졌는데 앞선 요청의 결과를 모른다. 덮어쓰면 그 ID를 잃는다.
  if (pending && pending.state === "pending")
    return { status: "blocked", pending };
  const requestId = newRequestId();
  const record: PendingSubmission = {
    schema: 2,
    requestId,
    fingerprint,
    kind: sent.kind,
    body: sent.body,
    state: "pending",
    sentAt: new Date().toISOString(),
  };
  try {
    if (!store) throw new Error("저장소 없음");
    store.setItem(key, JSON.stringify(record));
    return { status: "reserved", requestId, reused: false, volatile: false };
  } catch {
    return { status: "reserved", requestId, reused: false, volatile: true };
  }
}

/**
 * 접수가 확정됐다고 기록한다. 지우지 않는 이유는 같은 본문을 다시 보낼 때
 * 같은 ID를 써야 서버가 새 행을 만들지 않고 저장된 결과를 재현하기 때문이다
 * (SUB-09). 확정된 기록은 다른 본문의 예약을 막지 않는다.
 */
export function markSubmissionAccepted(
  key: string,
  store: Store | null = sessionStore(),
): void {
  const pending = readPendingSubmission(key, store);
  if (!pending || pending.state === "accepted") return;
  try {
    store?.setItem(key, JSON.stringify({ ...pending, state: "accepted" }));
  } catch {
    /* 남기지 못해도 다음 예약이 막히기만 한다. 접수 자체는 끝났다. */
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
