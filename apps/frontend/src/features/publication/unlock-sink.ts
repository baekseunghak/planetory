/**
 * 공개로 새로 인정된 성과가 연 별을 알릴 곳. **시네마 앱
 * (`src/cinema/shell/CinemaLayout.tsx`)만 값을 준다.** 셸은 그 별을 은하로
 * 돌아왔을 때 점화하고 새 별로 표시한다(분석 화면의 발견과 같다). 제공자가
 * 없는 develop 화면(`src/legacy`)은 값이 `null`이라 지금 동작 그대로다
 * (`../analysis/cinema-copy.ts`와 같은 방식).
 */
import { createContext, useContext } from "react";

export type PublicationUnlocks = (ticIds: readonly string[]) => void;

export const PublicationUnlockSink = createContext<PublicationUnlocks | null>(
  null,
);

/** 시네마 앱 안이면 알릴 곳, develop 화면이면 `null`. */
export function usePublicationUnlockSink(): PublicationUnlocks | null {
  return useContext(PublicationUnlockSink);
}
