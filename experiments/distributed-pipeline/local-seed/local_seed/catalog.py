"""시드 별 구성. 이 표가 정답표다.

TIC 은 실제 TIC 목록(약 20억 번 이하)과 겹치지 않게 99억 대를 쓴다. 신호 값은 계산 전에 정한 참값이며,
발견 가능 여부(discoverable)는 기대값이다. 생성할 때 astro-kernel 판정이 기대와 다르면 적재하지 않고 실패한다.

튜토리얼 의도(intent)는 ERD tutorial_stars 값과 같다: 1 deep_confirmed, 2 shallow_confirmed, 3 fp, 4 deep_fp, 5 multi_fp.
챌린지 대상은 미확정(pc)·AI 승인 신호를 둔다(운영 규칙 런북 5절, 챌린지 회차 런북 1절).

통과 모양(shape)은 곡선에 넣는 모양이다. Gold 후보 모델은 계약 1.0 이 box 만 지원하므로 모양과 관계없이 box 이며,
box 창 안의 평균 깊이가 depth_ppm 이 되도록 모양을 맞춘다. 튜토리얼·챌린지는 풀이가 확실하도록 box 로 두고,
일반 별은 실제 곡선처럼 U자(행성)·V자(스치는 식쌍성)로 넣어 box 모델로 빼도 가장자리가 남게 한다.
"""
from __future__ import annotations

from dataclasses import dataclass

# 시드 규칙이 바뀌면 올린다. 계산 버전에 들어가므로 새 bundle_version 과 새 판이 된다.
GENERATOR_VERSION = "local-seed-v1"
TIC_BASE = 9_900_000_000
# 외부 참조의 조회일. 레코드 checksum 에 들어가므로 실행 날짜가 아니라 고정값을 쓴다.
FETCHED_ON = "2026-09-23"


@dataclass(frozen=True)
class Signal:
    key: str                      # 정답표 이름(b, c …)
    period_days: float
    phase: float                  # 첫 통과 중심 = 관측 시작 + phase × period
    duration_hours: float
    depth_ppm: float
    disposition: str              # confirmed | fp | pc | none
    discoverable: bool            # 기대값
    ai: tuple[float, str] | None = None   # (score, verdict). 분석형(pc·none) 신호에만 둔다
    odd_even_ppm: float = 0.0     # 홀수 번째 통과는 +, 짝수 번째는 −만큼 깊다. 후보 모델에는 평균 깊이만 넣는다
    shape: str = "box"            # box | u | v. 곡선에 넣는 모양(후보 모델은 늘 box)
    note: str = ""


@dataclass(frozen=True)
class Star:
    number: int
    role: str                     # tutorial | challenge | pool
    sectors: tuple[int, ...]
    noise_ppm: float              # 10분 bin 한 점의 잡음
    tmag: float
    teff_k: float
    radius_rsun: float
    signals: tuple[Signal, ...]
    tutorial_seq: int | None = None
    tutorial_intent: str | None = None
    description: str = ""

    @property
    def tic_id(self) -> int:
        return TIC_BASE + self.number

    @property
    def label(self) -> str:
        return f"SYN-{self.number:02d}"


CATALOG: tuple[Star, ...] = (
    Star(1, "tutorial", (14,), 600, 10.8, 5850, 1.05, tutorial_seq=1, tutorial_intent="deep_confirmed",
         description="깊은 확정 행성 하나",
         signals=(Signal("b", 3.2474, 0.21, 2.9, 11500, "confirmed", True),)),
    Star(2, "tutorial", (15, 16), 380, 9.6, 5320, 0.86, tutorial_seq=2, tutorial_intent="shallow_confirmed",
         description="얕은 확정 행성 하나, 두 섹터",
         signals=(Signal("b", 5.8126, 0.37, 2.4, 1150, "confirmed", True),)),
    Star(3, "tutorial", (17,), 700, 11.2, 6100, 1.30, tutorial_seq=3, tutorial_intent="fp",
         description="식쌍성 오검출. 홀짝 통과 깊이가 다르다",
         signals=(Signal("b", 4.4117, 0.12, 3.1, 6400, "fp", True, odd_even_ppm=300,
                         note="홀수 6,700 ppm / 짝수 6,100 ppm"),)),
    Star(4, "tutorial", (18,), 900, 12.1, 4900, 0.78, tutorial_seq=4, tutorial_intent="deep_fp",
         description="행성이라기엔 너무 깊은 오검출",
         signals=(Signal("b", 1.8791, 0.44, 2.6, 180000, "fp", True),)),
    Star(5, "tutorial", (19, 20), 650, 11.0, 5600, 1.12, tutorial_seq=5, tutorial_intent="multi_fp",
         description="같은 주기의 1차·2차 식. 둘 다 오검출",
         signals=(Signal("b", 2.7336, 0.18, 2.2, 9000, "fp", True, note="1차 식"),
                  Signal("c", 2.7336, 0.68, 2.2, 3200, "fp", True, note="2차 식, b 와 위상 0.5 차이"))),
    Star(6, "challenge", (21, 22), 450, 10.1, 5150, 0.82,
         description="챌린지 대상. 미확정 신호, AI 승인",
         signals=(Signal("b", 9.8716, 0.33, 3.4, 2100, "pc", True, ai=(0.91, "approved")),)),
    Star(7, "pool", (23,), 520, 10.4, 5480, 0.95, description="확정 행성 둘, U자 통과",
         signals=(Signal("b", 2.1543, 0.52, 1.9, 3000, "confirmed", True, shape="u"),
                  Signal("c", 7.3302, 0.29, 3.0, 1800, "confirmed", True, shape="u"))),
    Star(8, "pool", (24, 25), 400, 9.9, 4700, 0.70, description="미확정 신호, AI 보류, U자 통과",
         signals=(Signal("b", 5.5021, 0.61, 2.3, 1200, "pc", True, ai=(0.62, "hold"), shape="u"),)),
    Star(9, "pool", (26,), 800, 11.7, 6400, 1.60, description="스치는 식쌍성 오검출, V자 식",
         signals=(Signal("b", 1.2268, 0.07, 2.1, 25000, "fp", True, shape="v"),)),
    Star(10, "pool", (27,), 450, 10.0, 5700, 1.00, description="확정 행성 둘 중 하나는 너무 얕아 찾을 수 없다, U자 통과",
         signals=(Signal("b", 3.8810, 0.40, 2.5, 4500, "confirmed", True, shape="u"),
                  Signal("c", 11.9170, 0.15, 3.8, 180, "confirmed", False, shape="u",
                         note="발견 불가(undiscoverable)"))),
    Star(11, "pool", (28, 29), 420, 9.8, 5250, 0.88, description="신호 셋: 확정 둘, 미확정 하나, U자 통과",
         signals=(Signal("b", 1.6302, 0.25, 1.5, 2400, "confirmed", True, shape="u"),
                  Signal("c", 5.2179, 0.71, 2.2, 1500, "confirmed", True, shape="u"),
                  Signal("d", 12.3301, 0.46, 3.6, 1900, "pc", True, ai=(0.83, "approved"), shape="u"))),
    Star(12, "pool", (30,), 550, 10.6, 5900, 1.10, description="외부 라벨 없는 신호(none), AI 미평가, U자 통과",
         signals=(Signal("b", 6.7820, 0.55, 2.8, 1700, "none", True, shape="u"),)),
    Star(13, "pool", (31, 32), 480, 10.3, 5050, 0.80, description="긴 주기 미확정 신호, AI 승인, U자 통과",
         signals=(Signal("b", 16.4410, 0.30, 4.2, 2600, "pc", True, ai=(0.88, "approved"), shape="u"),)),
    Star(14, "pool", (40, 43), 600, 10.9, 5500, 0.98, description="떨어진 두 섹터의 확정 행성, U자 통과",
         signals=(Signal("b", 4.1011, 0.63, 2.6, 5000, "confirmed", True, shape="u"),)),
)
