import type { Signal, Member, Judgment } from "../shared/types";
export const TUTORIALS = [
  {
    id: "259377017",
    number: 1,
    purpose: "뚜렷한 신호 · 봉우리와 구간",
    type: "confirmed",
    count: 1,
  },
  {
    id: "307210830",
    number: 2,
    purpose: "얕은 신호 · 곡선 확대",
    type: "confirmed",
    count: 1,
  },
  {
    id: "900000003",
    number: 3,
    purpose: "행성 아님 · 확인 도구",
    type: "fp",
    count: 1,
  },
  {
    id: "199574208",
    number: 4,
    purpose: "서로 가리는 쌍성",
    type: "fp",
    count: 1,
  },
  {
    id: "900000005",
    number: 5,
    purpose: "여러 신호 · 반복 탐색",
    type: "fp",
    count: 2,
  },
] as const;
export interface CatalogueStar {
  id: string;
  sectors: number[];
  magnitude: number;
  signals: Signal[];
}
export function curve(period = 3.6, depth = 0.004, phase = 0.3) {
  return Array.from({ length: 150 }, (_, i) => {
    const x = i / 149;
    const distance = Math.abs(((((x - phase + 0.5) % 1) + 1) % 1) - 0.5);
    return [
      x,
      1 - (distance < 0.035 ? depth : 0) + Math.sin(i * 13.23) * 0.0005,
      0.0004,
    ];
  });
}
export function catalogue(count = 600): CatalogueStar[] {
  const ids = [
    ...TUTORIALS.map((t) => t.id),
    "900000099",
    ...Array.from({ length: count }, (_, i) => String(910000000 + i)),
  ];
  return ids.map((id, i) => {
    const t = TUTORIALS.find((t) => t.id === id);
    const type =
      t?.type ||
      (i % 3 === 0 ? "confirmed" : i % 3 === 1 ? "fp" : "unconfirmed");
    return {
      id,
      sectors: [1, Math.max(2, (i % 20) + 2)],
      magnitude: 8 + (i % 60) / 10,
      signals: Array.from(
        { length: t?.count || (id === "900000099" ? 3 : 1 + (i % 5)) },
        (_, j) => ({
          id: id + ":s" + (j + 1),
          starId: id,
          type,
          period: Number((3.6 + j * 4.7 + (i % 7) * 0.15).toFixed(4)),
          epoch: 1500.8 + j,
          duration: 0.18,
          depth: Number((0.04 + ((i + j) % 15) * 0.02).toFixed(3)),
          discoverable: true,
          ai: {
            score: i % 17 === 0 ? null : 0.52 + (i % 45) / 100,
            status: i % 17 === 0 ? "not_evaluated" : "evaluated",
            band:
              i % 17 === 0
                ? null
                : i % 45 > 25
                  ? "approved"
                  : i % 45 > 10
                    ? "review"
                    : "below",
            version: "fixture-model-1",
          },
          source: {
            title: "로컬 검증용 합성 신호",
            url: "https://archive.stsci.edu/missions-and-data/tess",
            retrievedAt: "2026-09-09",
          },
          sde: 20 - j,
        }),
      ),
    };
  });
}
export function member(
  id: string,
  nickname: string,
  provider: "ssafy" | "google" = "ssafy",
): Member {
  return {
    id,
    nickname,
    provider,
    joinedAt: "2026-09-09T00:00:00Z",
    firstVisit: true,
    settings: {
      publicStars: true,
      notifications: {
        grade: true,
        reopened: true,
        challenge: true,
        follow: true,
        community: true,
        candidate: true,
        expert: true,
      },
    },
  };
}
export const correct = (s: Signal): Judgment =>
  s.type === "fp" ? "UNLIKELY_PLANET" : "LIKELY_PLANET";
