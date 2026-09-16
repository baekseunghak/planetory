# -*- coding: utf-8 -*-
"""공식 MAST 제품 다운로드·검증·checksum 기록.

experiments/tess-bls/download_toi270.py 의 원자적 다운로드 방식을 일반화했다.
완료된 파일은 헤더(TICID·SECTOR)와 SHA-256 을 다시 확인한 뒤 캐시로 인정한다.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .targets import Target, iter_products

USER_AGENT = "ssafy-planetory-fixture/0.1"
FITS_BLOCK = 2880


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def primary_header(path: Path) -> dict[str, object]:
    """표준 라이브러리만으로 PRIMARY 헤더 카드를 읽는다."""
    values: dict[str, object] = {}
    with path.open("rb") as handle:
        while True:
            block = handle.read(FITS_BLOCK)
            if len(block) != FITS_BLOCK:
                raise ValueError("truncated FITS primary header")
            for offset in range(0, FITS_BLOCK, 80):
                card = block[offset:offset + 80].decode("ascii", "strict")
                key = card[:8].strip()
                if key == "END":
                    return values
                if card[8:10] != "= ":
                    continue
                raw = card[10:].split("/", 1)[0].strip()
                if raw in ("T", "F"):
                    values[key] = raw == "T"
                elif raw.startswith("'"):
                    values[key] = raw[1:].split("'", 1)[0].strip()
                else:
                    try:
                        values[key] = int(raw)
                    except ValueError:
                        values[key] = raw


def validate_product(path: Path, tic_id: int, sector: int) -> dict[str, object]:
    size = path.stat().st_size
    if not path.is_file() or size < FITS_BLOCK or size % FITS_BLOCK:
        raise ValueError("file size is not a complete FITS block sequence")
    header = primary_header(path)
    if header.get("SIMPLE") is not True:
        raise ValueError("missing FITS SIMPLE header")
    if int(header.get("TICID", -1)) != tic_id:
        raise ValueError(f"unexpected TICID: {header.get('TICID')}")
    if int(header.get("SECTOR", -1)) != sector:
        raise ValueError(f"unexpected SECTOR: {header.get('SECTOR')}")
    return header


def download_product(url: str, destination: Path, tic_id: int, sector: int,
                     expected_sha256: str | None = None, timeout: float = 120.0,
                     retries: int = 3, log=print) -> dict[str, object]:
    """제품 하나를 원자적으로 받고 검증 결과를 반환한다. 캐시 히트도 같은 형식으로 반환."""
    if destination.is_file() and destination.stat().st_size > 0:
        try:
            header = validate_product(destination, tic_id, sector)
            digest = sha256_of(destination)
            if expected_sha256 and digest != expected_sha256:
                raise ValueError(f"sha256 mismatch: {digest} != {expected_sha256}")
        except (OSError, ValueError) as exc:
            log(f"[invalid cache] {destination.name}: {exc}; downloading again")
        else:
            log(f"[cached] {destination.name} ({destination.stat().st_size:,} bytes)")
            return _record(destination, url, tic_id, sector, digest, header, cached=True)

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        log(f"[download {attempt}/{retries}] {destination.name}")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                expected_size = response.headers.get("Content-Length")
                with partial.open("wb") as output:
                    shutil.copyfileobj(response, output, length=1 << 20)
                    output.flush()
                    os.fsync(output.fileno())
            actual_size = partial.stat().st_size
            if expected_size is not None and actual_size != int(expected_size):
                raise RuntimeError(f"incomplete download: expected {int(expected_size):,}, got {actual_size:,}")
            header = validate_product(partial, tic_id, sector)
            digest = sha256_of(partial)
            if expected_sha256 and digest != expected_sha256:
                raise RuntimeError(f"sha256 mismatch after download: {digest} != {expected_sha256}")
            os.replace(partial, destination)
            log(f"[saved] {destination.name} ({actual_size:,} bytes) sha256={digest[:12]}")
            return _record(destination, url, tic_id, sector, digest, header, cached=False)
        except Exception as exc:  # noqa: BLE001 - 재시도 후 마지막 오류를 올린다
            last_error = exc
            partial.unlink(missing_ok=True)
            if attempt < retries:
                time.sleep(1.5 * attempt)
    raise RuntimeError(f"failed to download {destination.name}: {last_error}")


def _record(path: Path, url: str, tic_id: int, sector: int, digest: str,
            header: dict[str, object], cached: bool) -> dict[str, object]:
    return {
        "filename": path.name,
        "path": str(path),
        "source_uri": url,
        "tic_id": tic_id,
        "sector": sector,
        "size_bytes": path.stat().st_size,
        "sha256": digest,
        "procver": header.get("PROCVER"),
        "data_rel": header.get("DATA_REL"),
        "camera": header.get("CAMERA"),
        "ccd": header.get("CCD"),
        "cached": cached,
    }


def download_targets(targets: tuple[Target, ...], output_root: Path,
                     expected: dict[str, str] | None = None, log=print) -> list[dict[str, object]]:
    """표본 전체(또는 선택)를 output_root/<target.key>/ 아래에 받고 파일 기록 목록을 반환한다."""
    records: list[dict[str, object]] = []
    expected = expected or {}
    for target, sector, filename, url in iter_products(targets):
        destination = output_root / target.key / filename
        record = download_product(url, destination, target.tic_id, sector,
                                  expected_sha256=expected.get(filename), log=log)
        record.update({"target_key": target.key, "target_name": target.name, "role": target.role})
        records.append(record)
    return records


def load_expected_checksums(path: Path) -> dict[str, str]:
    """checksums.json(filename -> sha256) 을 읽는다. 없으면 빈 dict."""
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {row["filename"]: row["sha256"] for row in payload.get("files", [])}


def write_checksums(records: list[dict[str, object]], path: Path) -> bool:
    """받은 파일의 checksum 목록. 기존 파일이 있으면 filename 기준으로 병합한다. 이 파일은 Git에 커밋한다.

    파일 목록·해시가 기존과 같으면 파일을 다시 쓰지 않고 `updated_at` 도 유지한다(False 반환).
    그래야 같은 입력을 다시 받아도 추적 파일에 diff 가 생기지 않는다. 내용이 바뀌었을 때만 새로 쓴다(True 반환).
    """
    merged: dict[str, dict[str, object]] = {}
    existing: dict | None = None
    if path.is_file():
        existing = json.loads(path.read_text(encoding="utf-8"))
        for row in existing.get("files", []):
            merged[row["filename"]] = row
    keep = ("filename", "source_uri", "target_key", "target_name", "role", "tic_id", "sector",
            "size_bytes", "sha256", "procver", "data_rel", "camera", "ccd")
    for row in records:
        merged[row["filename"]] = {k: row.get(k) for k in keep}
    files = [merged[k] for k in sorted(merged)]
    if existing is not None and existing.get("files") == files:
        return False
    payload = {
        "schema": "planetory.fixture-checksums.v1",
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": files,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True
