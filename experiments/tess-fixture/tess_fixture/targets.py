# -*- coding: utf-8 -*-
"""고정 표본 TIC 목록과 공식 MAST SPOC LC 제품 식별.

제품 파일명은 `tess<sector timestamp>-s<sector>-<TIC 16자리>-<pipeline id>-s_lc.fits` 형식이다.
Sector별 timestamp·pipeline id는 MAST 제품명에서 확인한 값만 등록하며, 등록되지 않은 Sector의
파일명은 만들지 않는다. 표본 선정 근거는 docs/data/tess-fixture-set.md 에 있다.
"""

from __future__ import annotations

from dataclasses import dataclass, field

MAST_DOWNLOAD_BASE = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"

# Sector -> (파일명 timestamp 접두, SPOC pipeline id).
# 2·3·4·5·8·16 은 기존 PoC 다운로더와 MAST HEAD 확인(2026-09-10), 1·6·7·9~13 은 MAST 공식 bulk download 스크립트
# `tesscurl_sector_<N>_lc.sh` 의 파일명에서 확인(2026-09-16, S15P21C206-108). 1년차 남반구 1~13 이 모두 있다.
SECTOR_PRODUCT_PREFIX: dict[int, tuple[str, str]] = {
    1: ("tess2018206045859", "0120"),
    2: ("tess2018234235059", "0121"),
    3: ("tess2018263035959", "0123"),
    4: ("tess2018292075959", "0124"),
    5: ("tess2018319095959", "0125"),
    6: ("tess2018349182500", "0126"),
    7: ("tess2019006130736", "0131"),
    8: ("tess2019032160000", "0136"),
    9: ("tess2019058134432", "0139"),
    10: ("tess2019085135100", "0140"),
    11: ("tess2019112060037", "0143"),
    12: ("tess2019140104343", "0144"),
    13: ("tess2019169103026", "0146"),
    16: ("tess2019253231442", "0152"),
}


@dataclass(frozen=True)
class Target:
    key: str                 # 디렉터리·CLI에서 쓰는 짧은 이름
    name: str                # 통용 이름
    tic_id: int
    role: str                # 표본에서 맡는 역할 (docs 표와 일치)
    sectors: tuple[int, ...]
    notes: str = ""
    # 표본 설명용 참고 주기. 정본은 references.csv(NASA Exoplanet Archive 조회 결과)다.
    reference_periods_days: tuple[float, ...] = field(default_factory=tuple)


TARGETS: tuple[Target, ...] = (
    Target("toi270", "TOI-270", 259377017, "multi_planet_m_dwarf", (3, 4, 5),
           "M형 왜성, 확인 행성 3개. 기존 PoC 재현 샘플",
           (3.35992, 5.66051, 11.38194)),
    Target("l98_59", "L 98-59", 307210830, "multi_planet_shallow", (2, 5, 8),
           "M형 왜성, 얕은 통과 행성 3개",
           (2.2531140, 3.6906764, 7.450729)),
    Target("cm_dra", "CM Draconis", 199574208, "eclipsing_binary", (16,),
           "식쌍성. 주극소·부극소 깊이가 비슷해 P/2 별칭이 강함",
           (1.2683900573,)),
    Target("wasp18", "WASP-18", 100100827, "deep_short_period", (2, 3),
           "매우 짧은 주기 뜨거운 목성. 깊이 약 1%",
           (0.94145,)),
    Target("wasp62", "WASP-62", 149603524, "deep_multi_sector", (2, 3, 4, 8),
           "CVZ 부근 뜨거운 목성. Sector 결합·경계 스트레스용. Sector 5 SPOC 2분 제품 없음(404)",
           (4.41194,)),
    Target("toi700", "TOI-700", 150428135, "shallow_earth_size_long_period", (3, 4, 5, 8),
           "지구 크기 행성 다수, 수백 ppm 깊이·장주기. 회수 한계 확인용",
           (9.9773, 16.0510, 37.4243)),
    Target("toi451", "TOI-451", 257605131, "young_active_star", (4, 5),
           "젊은 활동성 별(회전 변광)과 행성 3개. detrending 스트레스용",
           (1.8587, 9.1927, 16.365)),
    Target("pi_men", "pi Mensae", 261136679, "bright_star_shallow", (4, 8),
           "매우 밝은 별의 얕은 통과. 포화·계통 오차 사례",
           (6.2679,)),
    Target("hd21749", "HD 21749 (TOI-186)", 279741379, "long_period_shallow", (3, 4),
           "장주기(약 35.6일) 통과 1~2회 사례와 얕은 내행성. Sector 5 SPOC 2분 제품 없음(404)",
           (35.61, 7.79)),
)

# Explicit selection only: default fixture commands retain the original nine.
HOLDOUT_TARGETS: tuple[Target, ...] = (
    Target("holdout_268637577", "TIC 268637577", 268637577, "holdout", (3,)),
    Target("holdout_100102268", "TIC 100102268", 100102268, "holdout", (2, 3)),
    Target("holdout_219237079", "TIC 219237079", 219237079, "holdout", (3, 4, 5)),
    Target("holdout_358253008", "TIC 358253008", 358253008, "holdout", (2, 3, 4, 5)),
)
ALL_TARGETS = TARGETS + HOLDOUT_TARGETS
TARGETS_BY_KEY: dict[str, Target] = {t.key: t for t in ALL_TARGETS}


def product_filename(tic_id: int, sector: int) -> str:
    try:
        prefix, pipeline_id = SECTOR_PRODUCT_PREFIX[sector]
    except KeyError as exc:
        raise KeyError(f"Sector {sector}의 SPOC 제품 접두가 등록되지 않았다") from exc
    return f"{prefix}-s{sector:04d}-{tic_id:016d}-{pipeline_id}-s_lc.fits"


def product_url(tic_id: int, sector: int) -> str:
    return MAST_DOWNLOAD_BASE + product_filename(tic_id, sector)


def iter_products(targets=TARGETS):
    """(target, sector, filename, url) 순회."""
    for target in targets:
        for sector in target.sectors:
            yield target, sector, product_filename(target.tic_id, sector), product_url(target.tic_id, sector)


def select_targets(keys: list[str] | None) -> tuple[Target, ...]:
    if not keys:
        return TARGETS
    unknown = [k for k in keys if k not in TARGETS_BY_KEY]
    if unknown:
        raise KeyError(f"unknown target key(s): {unknown}. available: {sorted(TARGETS_BY_KEY)}")
    return tuple(TARGETS_BY_KEY[k] for k in keys)
