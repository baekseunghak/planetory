/**
 * Cinema app wording for shared feature screens (community, my page,
 * profiles, settings, quests, star search and list). Only the cinema shell
 * provides `true` (src/cinema/shell/CinemaRoot.tsx); the develop screens
 * (production default, src/legacy) have no provider, read `false` and keep
 * their copy exactly (the `StrictCelebration` pattern).
 *
 * Glossary: 나의 은하 (never 별지도) · 미탐사 / 탐사 중 / 탐사 완료 (never
 * 탐색) · 분석 결과 · Planetory 공식 (never SYSTEM) · "~습니다" · no English
 * labels (섹터, 밝기 등급) · dates without seconds.
 */
import { createContext, useContext } from "react";

export const CinemaWording = createContext(false);

/** True inside the cinema app. */
export function useCinemaWording(): boolean {
  return useContext(CinemaWording);
}

export const CINEMA_PROGRESS = {
  unexplored: "미탐사",
  in_progress: "탐사 중",
  completed: "탐사 완료",
} as const;

/** The official author, instead of the API's "SYSTEM". */
export const CINEMA_OFFICIAL = "Planetory 공식";

const dateTime = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Seoul",
});

/** "2026년 9월 18일 오전 10:00": no seconds. Invalid input comes back as is. */
export function cinemaDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime())
    ? dateTime.format(date)
    : String(value);
}
