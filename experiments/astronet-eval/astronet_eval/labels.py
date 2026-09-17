# -*- coding: utf-8 -*-
"""PC/EB/junk 라벨 목록과 TIC 단위 분리.

라벨 출처
- PC: NASA Exoplanet Archive `pscomppars` (tess-fixture `references.csv`, fetched_at 이 snapshot). tran_flag=1 이고
  주기·통과 중심·지속시간이 모두 있는 확인 행성만. TOI PC/APC·무라벨은 양성 정답으로 쓰지 않는다(Jira 43).
- EB: tess-fixture `targets.py` 의 role=eclipsing_binary 표본과 문헌 주기. epoch·duration 은 BLS 로 산출(convert 단계).
- junk: 합성 잡음 곡선의 BLS 최강 피크. 신호가 없음을 구성으로 보장.
- junk_unverified: 실제 곡선에서 PC/EB 를 제거한 잔차의 BLS 최강 피크. 미확인 신호일 수 있어 정답 집합 제외(in_truth=False).

분리는 TIC 단위: sha256(str(tic_id)) 첫 바이트 홀짝. 같은 별의 후보는 전부 한쪽에 간다.
"""

from __future__ import annotations

import csv
import hashlib
import re
from dataclasses import asdict, dataclass, fields
from pathlib import Path

BJD_OFFSET = 2457000.0            # BTJD = BJD - 2457000
PERCENT_TO_PPM = 1e4

LABELS_IN_TRUTH = ("PC", "EB", "junk")
LABELS_ALL = LABELS_IN_TRUTH + ("junk_unverified",)


@dataclass
class Candidate:
    candidate_id: str
    label: str                     # PC | EB | junk | junk_unverified
    in_truth: bool                 # 118 의 정답 집합에 포함되는가
    label_source: str
    label_snapshot: str            # 출처 조회 시각 또는 파일 해시
    tic_id: int
    target_key: str
    baseline_id: str               # <target>-real | <target>-noise<seed>
    split: str                     # calibration | evaluation
    training_overlap: str          # unknown | true | false
    source_name: str               # 행성 이름, 별 이름, noise seed 등
    period_days: float
    epoch_btjd: float | None       # None 이면 convert 단계에서 BLS 로 채움
    duration_hours: float | None
    depth_ppm: float | None
    geometry_source: str           # archive | bls_at_known_period | bls_strongest_peak
    notes: str = ""

    def as_row(self) -> dict:
        row = asdict(self)
        row["in_truth"] = "true" if self.in_truth else "false"
        for k in ("epoch_btjd", "duration_hours", "depth_ppm"):
            row[k] = "" if row[k] is None else repr(float(row[k]))
        return row


LABEL_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(Candidate))


def split_for_tic(tic_id: int) -> str:
    """결정적 분리. 재실행·순서 변경에도 같은 결과."""
    first = hashlib.sha256(str(int(tic_id)).encode("ascii")).digest()[0]
    return "calibration" if first % 2 == 0 else "evaluation"


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _float_or_none(value: str | None) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    return float(value)


def candidates_from_references(reference_rows: list[dict], targets_by_key: dict, *,
                               training_overlap: str = "unknown") -> tuple[list[Candidate], list[dict]]:
    """references.csv 행 → PC 후보. 제외된 행은 (행, 사유) 로 돌려준다."""
    out: list[Candidate] = []
    skipped: list[dict] = []
    for row in reference_rows:
        key = row.get("target_key", "")
        target = targets_by_key.get(key)
        if target is None:
            skipped.append({**row, "skip_reason": "unknown_target"})
            continue
        if not row.get("pl_name"):
            skipped.append({**row, "skip_reason": "no_planet_row"})          # 식쌍성 자리표시 행 등
            continue
        if str(row.get("tran_flag", "")).strip() != "1":
            skipped.append({**row, "skip_reason": "not_transiting"})
            continue
        period = _float_or_none(row.get("pl_orbper"))
        tranmid = _float_or_none(row.get("pl_tranmid"))
        trandur = _float_or_none(row.get("pl_trandur"))
        trandep = _float_or_none(row.get("pl_trandep"))
        if period is None or tranmid is None or trandur is None:
            skipped.append({**row, "skip_reason": "missing_period_epoch_or_duration"})
            continue
        if not (period > 0 and trandur > 0 and trandur / 24.0 < period):
            skipped.append({**row, "skip_reason": "invalid_geometry"})
            continue
        out.append(Candidate(
            candidate_id=f"{key}-pc-{slug(row['pl_name'])}", label="PC", in_truth=True,
            label_source="NASA Exoplanet Archive pscomppars", label_snapshot=row.get("fetched_at", ""),
            tic_id=target.tic_id, target_key=key, baseline_id=f"{key}-real", split=split_for_tic(target.tic_id),
            training_overlap=training_overlap, source_name=row["pl_name"], period_days=period,
            epoch_btjd=tranmid - BJD_OFFSET, duration_hours=trandur,
            depth_ppm=None if trandep is None else trandep * PERCENT_TO_PPM, geometry_source="archive",
            notes="" if trandep is not None else "depth missing in archive",
        ))
    return out, skipped


def eb_placeholders(targets: list, *, snapshot: str, training_overlap: str = "unknown") -> list[Candidate]:
    """식쌍성 표본. 주기는 문헌값, epoch·duration 은 convert 단계에서 BLS 로 채운다."""
    out = []
    for target in targets:
        if target.role != "eclipsing_binary":
            continue
        for i, period in enumerate(target.reference_periods_days):
            out.append(Candidate(
                candidate_id=f"{target.key}-eb-{slug(target.name)}" + (f"-{i}" if i else ""), label="EB", in_truth=True,
                label_source="tess-fixture targets.py reference_periods_days (literature orbital period)", label_snapshot=snapshot,
                tic_id=target.tic_id, target_key=target.key, baseline_id=f"{target.key}-real",
                split=split_for_tic(target.tic_id), training_overlap=training_overlap, source_name=target.name,
                period_days=float(period), epoch_btjd=None, duration_hours=None, depth_ppm=None,
                geometry_source="bls_at_known_period", notes="epoch/duration/depth from BLS at the literature period",
            ))
    return out


def check_split_integrity(candidates: list[Candidate]) -> None:
    """같은 TIC 가 두 split 에 나타나면 실패."""
    by_tic: dict[int, set[str]] = {}
    for c in candidates:
        by_tic.setdefault(c.tic_id, set()).add(c.split)
    bad = {tic: sorted(s) for tic, s in by_tic.items() if len(s) > 1}
    if bad:
        raise ValueError(f"TIC 가 두 split 에 섞였다: {bad}")
    ids = [c.candidate_id for c in candidates]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"candidate_id 중복: {dup}")


def write_labels(candidates: list[Candidate], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=LABEL_COLUMNS)
        writer.writeheader()
        for c in candidates:
            writer.writerow(c.as_row())
    return path


def read_labels(path: Path) -> list[Candidate]:
    out = []
    with path.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            out.append(Candidate(
                candidate_id=row["candidate_id"], label=row["label"], in_truth=row["in_truth"] == "true",
                label_source=row["label_source"], label_snapshot=row["label_snapshot"], tic_id=int(row["tic_id"]),
                target_key=row["target_key"], baseline_id=row["baseline_id"], split=row["split"],
                training_overlap=row["training_overlap"], source_name=row["source_name"],
                period_days=float(row["period_days"]), epoch_btjd=_float_or_none(row["epoch_btjd"]),
                duration_hours=_float_or_none(row["duration_hours"]), depth_ppm=_float_or_none(row["depth_ppm"]),
                geometry_source=row["geometry_source"], notes=row.get("notes", ""),
            ))
    return out


def summarize(candidates: list[Candidate]) -> dict:
    counts: dict[str, dict[str, int]] = {}
    for c in candidates:
        counts.setdefault(c.label, {}).setdefault(c.split, 0)
        counts[c.label][c.split] += 1
    return {"n_candidates": len(candidates), "n_tics": len({c.tic_id for c in candidates}),
            "by_label_split": counts, "in_truth": sum(c.in_truth for c in candidates)}
