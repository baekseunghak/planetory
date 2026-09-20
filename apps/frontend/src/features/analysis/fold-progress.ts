import { useEffect, useState } from "react";

/** 표시 지연일 뿐이다. 세션과 각 핸들러는 후속 동작을 즉시 잠근다. */
export const PROGRESS_NOTICE_DELAY_MS = 1000;

/**
 * `active`가 이만큼 이어질 때만 true가 된다.
 *
 * 미세 조정 한 번의 접기는 이 PC에서 6~15ms라 상태를 그대로 화면에 옮기면
 * 끄는 동안 버튼과 안내가 프레임마다 깜빡인다. 짧은 재계산은 화면을 건드리지
 * 않고, 사람이 기다림을 느낄 만큼 길어질 때만 드러낸다.
 */
export function useSustained(
  active: boolean,
  delayMs = PROGRESS_NOTICE_DELAY_MS,
) {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!active) {
      setSustained(false);
      return;
    }
    const timer = window.setTimeout(() => setSustained(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && sustained;
}
