import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";

// #196 커서 목록 조회. **조건이 바뀌면 커서를 버린다** — 서버가 커서를
// 조건(크기 포함)에 묶어 두어 이어 쓰면 400이 온다. 자세한 것은
// docs/analysis-my-lists.md.

export type PagedState<T> =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      items: T[];
      /** 다음 쪽이 있으면 커서, 없으면 null. */
      nextCursor: string | null;
      /** 다음 쪽을 이어 읽는 중. 이미 보이는 것은 그대로 둔다. */
      loadingMore: boolean;
      moreError: string | null;
    };

/**
 * 권한·존재를 숨기는 응답. **이 뒤에는 이미 보여 준 것도 남기지 않는다.**
 *
 * 슬롯은 들어올 때의 공개 여부를 보지만, 목록 API가 **그 뒤에** 알려 주는
 * 철회까지 알지는 못한다. 이어 읽다 거절당하면 앞서 받은 항목이 이미 볼 수
 * 없게 된 내용일 수 있으므로 누적과 커서를 함께 버린다. 잠깐의 통신
 * 실패(5xx·네트워크)와는 다르다 — 그쪽은 보던 것을 지우지 않는다.
 */
const revoked = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error
    ? error.message
    : "목록을 불러오지 못했습니다.";

/**
 * 커서로 이어 읽는 목록.
 *
 * `key`가 바뀌면 **처음부터 다시 읽는다.** 필터를 바꾸면서 들고 있던 커서를
 * 보내면 서버가 400으로 거절하므로, 조건이 달라졌다는 신호를 받으면 쌓아 둔
 * 것을 버린다.
 *
 * 늦게 도착한 응답은 세대 번호로 버린다. 필터를 빠르게 바꾸면 옛 조건의
 * 응답이 나중에 올 수 있고, 그것을 그리면 화면이 조건과 어긋난다.
 */
export function usePagedList<T>(
  key: string,
  load: (
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  const [state, setState] = useState<PagedState<T>>({ phase: "loading" });
  const generation = useRef(0);
  // 렌더마다 최신 상태를 담아 둔다. 업데이터 안에서 부수효과를 내지 않기 위해서다.
  const latest = useRef<PagedState<T>>(state);
  latest.current = state;
  const controller = useRef<AbortController | null>(null);

  const first = useCallback(() => {
    controller.current?.abort();
    const mine = ++generation.current;
    const next = new AbortController();
    controller.current = next;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const page = await load(null, next.signal);
        if (next.signal.aborted || mine !== generation.current) return;
        setState({
          ...page,
          phase: "ready",
          loadingMore: false,
          moreError: null,
        });
      } catch (error) {
        if (next.signal.aborted || mine !== generation.current) return;
        setState({ phase: "error", message: message(error) });
      }
    })();
  }, [load]);

  useEffect(() => {
    first();
    return () => controller.current?.abort();
    // key가 바뀌면 조건이 달라진 것이다. 커서를 들고 가지 않는다.
  }, [key, first]);

  // **업데이터 안에서 요청하지 않는다.** React는 setState 업데이터를 두 번
  // 부를 수 있고(StrictMode), 그러면 같은 커서로 두 번 읽어 한 번 눌렀는데 두
  // 쪽이 붙는다. 현재 값은 ref로 보고 요청은 바깥에서 한 번만 보낸다.
  const more = useCallback(() => {
    const current = latest.current;
    if (current.phase !== "ready" || !current.nextCursor || current.loadingMore)
      return;
    const cursor = current.nextCursor;
    const mine = generation.current;
    const next = new AbortController();
    // 이어 읽기도 현재 요청으로 등록해 조건 변경·화면 이탈 시 함께 취소한다.
    controller.current = next;
    setState({ ...current, loadingMore: true, moreError: null });
    void (async () => {
      try {
        const page = await load(cursor, next.signal);
        if (next.signal.aborted || mine !== generation.current) return;
        setState((prior) =>
          prior.phase === "ready"
            ? {
                ...prior,
                // 이어 읽은 것은 **뒤에 붙인다.** 덮어쓰면 앞쪽이 사라진다.
                items: [...prior.items, ...page.items],
                nextCursor: page.nextCursor,
                loadingMore: false,
                moreError: null,
              }
            : prior,
        );
      } catch (error) {
        if (next.signal.aborted || mine !== generation.current) return;
        // 권한이 철회됐으면 쌓아 둔 것과 커서를 버린다. 남기면 볼 수 없게 된
        // 내용을 계속 보여 주게 된다.
        if (revoked(error))
          return setState({ phase: "error", message: message(error) });
        setState((prior) =>
          prior.phase === "ready"
            ? { ...prior, loadingMore: false, moreError: message(error) }
            : prior,
        );
      }
    })();
  }, [load]);

  return { state, reload: first, more };
}
