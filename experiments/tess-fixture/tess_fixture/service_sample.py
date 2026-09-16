# -*- coding: utf-8 -*-
"""서비스 범위용 대표 표본(fixture 9별과 구분) 다운로드·checksum (Jira S15P21C206-108, 계획 ID D02-1).

fixture 표본은 특정 목적(다중 행성·식쌍성·활동성 별 등)으로 고른 9별이라 서비스 표본으로 쓸 수 없다.
이 모듈은 설정 파일(`configs/service_sample_v1.json`)에 적힌 Sector·TIC 목록을 41 의 `download_product` 로 받고,
별도 checksum 파일(`service_sample_checksums.json`)과 실행 manifest 를 남긴다. 표본 선정 규칙은 설정 파일과
docs/data/tess-service-scope-v1.md 에 있다. 원본 FITS 는 `sample_service/` 아래에 두며 Git 에 넣지 않는다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .download import download_product, load_expected_checksums, write_checksums
from .targets import MAST_DOWNLOAD_BASE

SCHEMA = "planetory.service-sample.v1"


@dataclass(frozen=True)
class SampleMember:
    tic_id: int
    sector: int
    group: str            # random | planet_host
    note: str = ""


@dataclass(frozen=True)
class SampleConfig:
    sample_id: str
    version: str
    sectors: dict[int, tuple[str, str]]     # sector -> (파일명 timestamp 접두, pipeline id)
    members: tuple[SampleMember, ...]
    selection: dict
    raw: dict

    def filename(self, member: SampleMember) -> str:
        prefix, pipeline_id = self.sectors[member.sector]
        return f"{prefix}-s{member.sector:04d}-{member.tic_id:016d}-{pipeline_id}-s_lc.fits"

    def url(self, member: SampleMember) -> str:
        return MAST_DOWNLOAD_BASE + self.filename(member)


def load_sample_config(path: Path) -> SampleConfig:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    if cfg.get("schema") != SCHEMA:
        raise ValueError(f"unexpected schema {cfg.get('schema')!r} (expected {SCHEMA})")
    sectors = {int(k): (v["prefix"], v["pipeline_id"]) for k, v in cfg["sectors"].items()}
    members = []
    seen = set()
    for m in cfg["members"]:
        key = (int(m["tic_id"]), int(m["sector"]))
        if key in seen:
            raise ValueError(f"duplicate member {key}")
        if key[1] not in sectors:
            raise ValueError(f"sector {key[1]} has no product prefix in config")
        seen.add(key)
        members.append(SampleMember(tic_id=key[0], sector=key[1], group=m["group"], note=m.get("note", "")))
    excluded = {int(t) for t in cfg["selection"].get("excluded_tic_ids", [])}
    clash = sorted({m.tic_id for m in members} & excluded)
    if clash:
        raise ValueError(f"members overlap excluded (fixture) TICs: {clash}")
    return SampleConfig(sample_id=cfg["sample_id"], version=cfg["version"], sectors=sectors, members=tuple(members),
                        selection=cfg["selection"], raw=cfg)


def download_sample(config: SampleConfig, output_root: Path, checksums_path: Path, log=print) -> list[dict]:
    """표본 전체를 output_root/<tic_id>/ 아래에 받고 checksum 파일을 병합·갱신한다. 기록 목록을 돌려준다."""
    expected = load_expected_checksums(checksums_path)
    records: list[dict] = []
    for i, member in enumerate(config.members, 1):
        filename = config.filename(member)
        destination = output_root / str(member.tic_id) / filename
        log(f"[{i}/{len(config.members)}] TIC {member.tic_id} s{member.sector:02d} ({member.group})")
        record = download_product(config.url(member), destination, member.tic_id, member.sector,
                                  expected_sha256=expected.get(filename), log=log)
        record.update({"target_key": str(member.tic_id), "target_name": f"TIC {member.tic_id}", "role": member.group,
                       "sample_id": config.sample_id, "sample_version": config.version, "note": member.note})
        records.append(record)
    write_checksums(records, checksums_path)
    return records


def summarize(records: list[dict]) -> dict:
    sizes = [int(r["size_bytes"]) for r in records]
    groups: dict[str, int] = {}
    for r in records:
        groups[r["role"]] = groups.get(r["role"], 0) + 1
    return {"n_files": len(records), "n_tics": len({r["tic_id"] for r in records}), "by_group": groups,
            "total_bytes": sum(sizes), "mean_bytes": (sum(sizes) // len(sizes)) if sizes else 0,
            "min_bytes": min(sizes) if sizes else 0, "max_bytes": max(sizes) if sizes else 0,
            "cache_hits": sum(bool(r.get("cached")) for r in records),
            "procver": sorted({str(r.get("procver")) for r in records})}
