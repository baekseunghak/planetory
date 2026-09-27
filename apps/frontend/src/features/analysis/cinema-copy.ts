/**
 * 시네마 앱의 분석·결과 표현(문구·숫자·내부 번호 숨김). **시네마 앱
 * (`main-cinema.tsx`)만 값을 준다.** 제공자가 없는 develop 화면
 * (`src/legacy`)은 값이 `null`이라 지금 문구·동작 그대로다(`StrictCelebration`과
 * 같은 방식).
 *
 * 값은 `src/cinema/analysis/copy.tsx`가 만든다. 여기서는 타입만 가져오므로
 * 기존 화면 번들에 시네마 코드가 들어가지 않는다.
 */
import { createContext, useContext } from "react";
import type { CinemaAnalysisCopy } from "../../cinema/analysis/copy";

export type { CinemaAnalysisCopy };

export const CinemaCopy = createContext<CinemaAnalysisCopy | null>(null);

/** 시네마 앱 안이면 그 표현, develop 화면이면 `null`. */
export function useCinemaCopy(): CinemaAnalysisCopy | null {
  return useContext(CinemaCopy);
}
