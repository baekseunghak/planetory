"""TESS SPOC 2분 Light Curve 목록 생성과 원자적 다운로드."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable

CONFIG_SCHEMA = "planetory.ingestion-config.v1"
SOURCE_LIST_SCHEMA = "planetory.tess-source-list.v1"
EVENT_SCHEMA = "planetory.download-event.v1"
RUN_SCHEMA = "planetory.download-run.v1"
USER_AGENT = "ssafy-planetory-ingestion/0.1"
FITS_BLOCK = 2880
RETRYABLE_HTTP = {429, 500, 502, 503, 504}
PRODUCT_RE = re.compile(
    r"^tess\d{13}-s(?P<sector>\d{4})-(?P<tic>\d{16})-(?P<pipeline>\d{4})-s_lc\.fits$"
)
CONTENT_RANGE_RE = re.compile(r"^bytes (?P<start>\d+)-(?P<end>\d+)/(?P<total>\d+)$")
UNSATISFIED_RANGE_RE = re.compile(r"^bytes \*/(?P<total>\d+)$")


class IntegrityError(RuntimeError):
    """받은 바이트가 원천 계약과 다르다."""


class RetryableDownloadError(RuntimeError):
    """부분 파일을 보존하고 같은 항목을 다시 받을 수 있다."""


class CapacityStop(RuntimeError):
    """75% 중단선 또는 임시 파일 상한에 도달했다."""


@dataclass(frozen=True)
class Product:
    sector: int
    tic_id: int
    filename: str
    mast_uri: str
    source_uri: str
    assigned_worker: int

    @classmethod
    def from_dict(cls, value: dict) -> "Product":
        product = cls(
            sector=int(value["sector"]),
            tic_id=int(value["tic_id"]),
            filename=str(value["filename"]),
            mast_uri=str(value["mast_uri"]),
            source_uri=str(value["source_uri"]),
            assigned_worker=int(value["assigned_worker"]),
        )
        mast_uri = _validate_product_identity(product.filename, product.source_uri, product.sector, product.tic_id)
        if product.mast_uri != mast_uri:
            raise ValueError(f"MAST URI mismatch: {product.mast_uri}")
        return product


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_worker(mast_uri: str, worker_count: int) -> int:
    if not 1 <= worker_count <= 5:
        raise ValueError("worker_count must be between 1 and 5")
    value = int.from_bytes(hashlib.sha256(mast_uri.encode("utf-8")).digest()[:8], "big")
    return value % worker_count + 1


def _validate_product_identity(filename: str, source_uri: str, sector: int, tic_id: int) -> str:
    match = PRODUCT_RE.fullmatch(filename)
    if not match:
        raise ValueError(f"unexpected SPOC LC filename: {filename}")
    if int(match.group("sector")) != sector or int(match.group("tic")) != tic_id:
        raise ValueError(f"filename identity mismatch: {filename}")
    parsed = urllib.parse.urlparse(source_uri)
    if (parsed.scheme, parsed.netloc, parsed.path) != (
        "https",
        "mast.stsci.edu",
        "/api/v0.1/Download/file/",
    ):
        raise ValueError(f"unexpected MAST download endpoint: {source_uri}")
    expected_mast_uri = "mast:TESS/product/" + filename
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    mast_values = query.get("uri", [])
    if set(query) != {"uri"} or mast_values != [expected_mast_uri]:
        raise ValueError(f"MAST URL does not identify {filename}")
    return expected_mast_uri


def parse_bulk_script(text: str, sector: int, worker_count: int) -> list[Product]:
    products: list[Product] = []
    seen: set[str] = set()
    for line_number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = shlex.split(line)
        if not parts or parts[0] != "curl" or "-o" not in parts:
            raise ValueError(f"sector {sector} line {line_number}: unsupported bulk command")
        output_index = parts.index("-o") + 1
        if output_index >= len(parts):
            raise ValueError(f"sector {sector} line {line_number}: missing output filename")
        filename = parts[output_index]
        urls = [part for part in parts if part.startswith("https://")]
        if len(urls) != 1:
            raise ValueError(f"sector {sector} line {line_number}: expected one HTTPS URL")
        match = PRODUCT_RE.fullmatch(filename)
        if not match:
            raise ValueError(f"sector {sector} line {line_number}: unexpected filename {filename}")
        tic_id = int(match.group("tic"))
        mast_uri = _validate_product_identity(filename, urls[0], sector, tic_id)
        if filename in seen:
            raise ValueError(f"sector {sector}: duplicate filename {filename}")
        seen.add(filename)
        products.append(Product(sector, tic_id, filename, mast_uri, urls[0], stable_worker(mast_uri, worker_count)))
    return products


def load_config(path: Path) -> dict:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schema") != CONFIG_SCHEMA:
        raise ValueError(f"unexpected config schema: {config.get('schema')!r}")
    sectors = config.get("sectors", [])
    if not sectors or len({int(row["sector"]) for row in sectors}) != len(sectors):
        raise ValueError("config sectors must be non-empty and unique")
    worker_count = int(config.get("worker_count", 0))
    if not 1 <= worker_count <= 5:
        raise ValueError("worker_count must be between 1 and 5")
    concurrency = int(config.get("download_concurrency", 1))
    if not 1 <= concurrency <= 4:
        raise ValueError("download_concurrency must be between 1 and 4")
    stop = float(config.get("disk_stop_fraction", 0))
    if not 0.5 <= stop <= 0.75:
        raise ValueError("disk_stop_fraction must be between 0.5 and 0.75")
    resume = float(config.get("disk_resume_fraction", 0))
    if not 0.5 <= resume < stop:
        raise ValueError("disk_resume_fraction must be at least 0.5 and below disk_stop_fraction")
    if int(config.get("max_part_bytes", 0)) <= FITS_BLOCK:
        raise ValueError("max_part_bytes must exceed one FITS block")
    if not 1 <= int(config.get("max_retries", 0)) <= 10:
        raise ValueError("max_retries must be between 1 and 10")
    if not 1 <= int(config.get("max_consecutive_failures", 0)) <= 100:
        raise ValueError("max_consecutive_failures must be between 1 and 100")
    retry_initial = int(config.get("retry_initial_seconds", 0))
    retry_max = int(config.get("retry_max_seconds", 0))
    if not 1 <= retry_initial <= retry_max <= 3600:
        raise ValueError("retry delay must satisfy 1 <= initial <= max <= 3600")
    return config


def fetch_bytes(url: str, timeout: float = 120.0) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _source_list_hash(products: list[Product]) -> str:
    digest = hashlib.sha256()
    for product in sorted(products, key=lambda item: (item.sector, item.filename)):
        digest.update(
            f"{product.sector}\t{product.tic_id}\t{product.filename}\t{product.mast_uri}\t{product.assigned_worker}\n".encode(
                "utf-8"
            )
        )
    return digest.hexdigest()


def build_source_list(
    config: dict,
    fetcher: Callable[[str], bytes] = fetch_bytes,
    retrieved_at: str | None = None,
) -> dict:
    worker_count = int(config["worker_count"])
    scripts, products = [], []
    retrieved_at = retrieved_at or utc_now()
    for row in sorted(config["sectors"], key=lambda value: int(value["sector"])):
        sector = int(row["sector"])
        url = str(row["bulk_script_url"])
        content = fetcher(url)
        parsed = parse_bulk_script(content.decode("utf-8"), sector, worker_count)
        expected = int(row["expected_count"])
        if len(parsed) != expected:
            raise ValueError(f"sector {sector}: expected {expected:,} products, got {len(parsed):,}")
        scripts.append(
            {
                "sector": sector,
                "source_uri": url,
                "retrieved_at": retrieved_at,
                "sha256": sha256_bytes(content),
                "product_count": len(parsed),
            }
        )
        products.extend(parsed)
    filenames = [item.filename for item in products]
    if len(filenames) != len(set(filenames)):
        raise ValueError("source list contains duplicate filenames across sectors")
    ordered = sorted(products, key=lambda item: (item.sector, item.filename))
    return {
        "schema": SOURCE_LIST_SCHEMA,
        "version": config["version"],
        "generated_at": retrieved_at,
        "worker_count": worker_count,
        "source_scripts": scripts,
        "product_count": len(ordered),
        "source_list_sha256": _source_list_hash(ordered),
        "products": [asdict(item) for item in ordered],
    }


def write_json_atomic(value: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    with partial.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(partial, path)


def load_source_list(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != SOURCE_LIST_SCHEMA:
        raise ValueError(f"unexpected source list schema: {value.get('schema')!r}")
    products = [Product.from_dict(row) for row in value.get("products", [])]
    if len(products) != int(value.get("product_count", -1)):
        raise ValueError("source list product_count mismatch")
    if _source_list_hash(products) != value.get("source_list_sha256"):
        raise ValueError("source list checksum mismatch")
    return value


def primary_header(path: Path) -> dict[str, object]:
    values: dict[str, object] = {}
    with path.open("rb") as handle:
        while True:
            block = handle.read(FITS_BLOCK)
            if len(block) != FITS_BLOCK:
                raise IntegrityError("truncated FITS primary header")
            for offset in range(0, FITS_BLOCK, 80):
                card = block[offset : offset + 80].decode("ascii", "strict")
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


def validate_fits(path: Path, product: Product) -> dict[str, object]:
    size = path.stat().st_size
    if not path.is_file() or size < FITS_BLOCK or size % FITS_BLOCK:
        raise IntegrityError("file size is not a complete FITS block sequence")
    header = primary_header(path)
    if header.get("SIMPLE") is not True:
        raise IntegrityError("missing FITS SIMPLE header")
    if int(header.get("TICID", -1)) != product.tic_id:
        raise IntegrityError(f"unexpected TICID: {header.get('TICID')}")
    if int(header.get("SECTOR", -1)) != product.sector:
        raise IntegrityError(f"unexpected SECTOR: {header.get('SECTOR')}")
    if not str(header.get("PROCVER", "")).strip():
        raise IntegrityError("missing FITS PROCVER")
    return header


def input_snapshot_id(sector: int, digest: str, procver: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("sha256 must be 64 lowercase hex characters")
    if not procver.strip():
        raise ValueError("PROCVER must be non-empty")
    return f"lc:spoc:s{sector:04d}:sha256:{digest}:procver:{procver.strip()}"


def ensure_capacity(path: Path, stop_fraction: float, incoming_bytes: int = 0) -> None:
    usage = shutil.disk_usage(path)
    projected = usage.used + max(0, incoming_bytes)
    if projected / usage.total >= stop_fraction:
        raise CapacityStop(
            f"disk stop line reached: projected={projected} total={usage.total} limit={stop_fraction:.2%}"
        )


def _retry_delay(error: Exception, attempt: int, now: Callable[[], datetime]) -> float:
    if isinstance(error, urllib.error.HTTPError):
        retry_after = error.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                try:
                    parsed = parsedate_to_datetime(retry_after)
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    return max(0.0, (parsed - now()).total_seconds())
                except (TypeError, ValueError, OverflowError):
                    pass
    return min(60.0, float(2 ** (attempt - 1)))


def _sleep_with_progress(
    seconds: float,
    sleep: Callable[[float], None],
    progress: Callable[[], None],
    interval: float = 30.0,
) -> None:
    remaining = max(0.0, seconds)
    if remaining == 0:
        progress()
        sleep(0.0)
        return
    while remaining > 0:
        progress()
        duration = min(interval, remaining)
        sleep(duration)
        remaining -= duration


def _response_layout(response, requested_offset: int) -> tuple[str, int | None]:
    status = int(getattr(response, "status", response.getcode()))
    if status == 206:
        content_range = response.headers.get("Content-Range", "")
        match = CONTENT_RANGE_RE.fullmatch(content_range)
        if not match or int(match.group("start")) != requested_offset:
            raise IntegrityError(f"unexpected Content-Range: {content_range!r}")
        return ("ab" if requested_offset else "wb"), int(match.group("total"))
    if status == 200:
        length = response.headers.get("Content-Length")
        return "wb", int(length) if length is not None else None
    raise IntegrityError(f"unexpected HTTP status: {status}")


def _validated_record(
    product: Product,
    path: Path,
    digest: str,
    header: dict[str, object],
    *,
    cached: bool,
    resumed_from: int,
    bytes_transferred: int,
    attempts: int = 0,
    http_retries: dict[str, int] | None = None,
    error_retries: dict[str, int] | None = None,
) -> dict:
    procver = str(header["PROCVER"]).strip()
    return {
        "schema": EVENT_SCHEMA,
        "status": "VALIDATED",
        "recorded_at": utc_now(),
        **asdict(product),
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "sha256": digest,
        "procver": procver,
        "input_snapshot_id": input_snapshot_id(product.sector, digest, procver),
        "cached": cached,
        "resumed_from": resumed_from,
        "bytes_transferred": bytes_transferred,
        "attempts": attempts,
        "http_retries": http_retries or {},
        "error_retries": error_retries or {},
    }


def download_product(
    product: Product,
    destination: Path,
    *,
    expected_sha256: str | None = None,
    timeout: float = 120.0,
    retries: int = 5,
    max_part_bytes: int = 64 << 20,
    disk_stop_fraction: float = 0.75,
    opener: Callable = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    log: Callable[[str], None] = print,
    progress: Callable[[], None] = lambda: None,
) -> dict:
    if destination.is_file() and destination.stat().st_size:
        try:
            header = validate_fits(destination, product)
            digest = sha256_file(destination)
            if expected_sha256 and digest != expected_sha256:
                raise IntegrityError(f"sha256 mismatch: {digest} != {expected_sha256}")
        except (OSError, IntegrityError) as error:
            log(f"[invalid cache] {product.filename}: {error}")
        else:
            return _validated_record(
                product, destination, digest, header, cached=True, resumed_from=0, bytes_transferred=0
            )

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    last_error: Exception | None = None
    total_transferred = 0
    http_retries: dict[str, int] = {}
    error_retries: dict[str, int] = {}
    first_offset = partial.stat().st_size if partial.is_file() else 0
    if first_offset > max_part_bytes:
        log(f"[invalid partial] {product.filename}: {first_offset} > {max_part_bytes}; restarting")
        partial.unlink()
        first_offset = 0

    for attempt in range(1, retries + 1):
        progress()
        offset = partial.stat().st_size if partial.is_file() else 0
        ensure_capacity(destination.parent, disk_stop_fraction)
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(product.source_uri, headers=headers)
        try:
            log(f"[download {attempt}/{retries}] {product.filename} offset={offset}")
            with opener(request, timeout=timeout) as response:
                mode, expected_total = _response_layout(response, offset)
                if expected_total is not None and expected_total > max_part_bytes:
                    raise CapacityStop(f"remote file exceeds part limit: {expected_total} > {max_part_bytes}")
                if mode == "wb":
                    offset = 0
                with partial.open(mode) as output:
                    while True:
                        chunk = response.read(1 << 20)
                        if not chunk:
                            break
                        output.write(chunk)
                        total_transferred += len(chunk)
                        progress()
                        current = output.tell()
                        if current > max_part_bytes:
                            raise CapacityStop(f"partial file exceeds limit: {current} > {max_part_bytes}")
                        ensure_capacity(destination.parent, disk_stop_fraction, len(chunk))
                    output.flush()
                    os.fsync(output.fileno())
            actual_size = partial.stat().st_size
            if expected_total is not None and actual_size != expected_total:
                if actual_size > expected_total:
                    partial.unlink(missing_ok=True)
                    raise IntegrityError(f"download exceeded expected size: {actual_size} > {expected_total}")
                raise RetryableDownloadError(f"incomplete download: {actual_size} < {expected_total}")
            header = validate_fits(partial, product)
            digest = sha256_file(partial)
            if expected_sha256 and digest != expected_sha256:
                partial.unlink(missing_ok=True)
                raise IntegrityError(f"sha256 mismatch: {digest} != {expected_sha256}")
            os.replace(partial, destination)
            return _validated_record(
                product,
                destination,
                digest,
                header,
                cached=False,
                resumed_from=first_offset,
                bytes_transferred=total_transferred,
                attempts=attempt,
                http_retries=http_retries,
                error_retries=error_retries,
            )
        except CapacityStop:
            raise
        except urllib.error.HTTPError as error:
            error.close()
            if error.code == 416 and partial.is_file():
                match = UNSATISFIED_RANGE_RE.fullmatch(error.headers.get("Content-Range", ""))
                if match and int(match.group("total")) == partial.stat().st_size:
                    try:
                        header = validate_fits(partial, product)
                        digest = sha256_file(partial)
                        if expected_sha256 and digest != expected_sha256:
                            raise IntegrityError(f"sha256 mismatch: {digest} != {expected_sha256}")
                        os.replace(partial, destination)
                        return _validated_record(
                            product,
                            destination,
                            digest,
                            header,
                            cached=False,
                            resumed_from=first_offset,
                            bytes_transferred=total_transferred,
                            attempts=attempt,
                            http_retries=http_retries,
                            error_retries=error_retries,
                        )
                    except IntegrityError:
                        partial.unlink(missing_ok=True)
                else:
                    partial.unlink(missing_ok=True)
            if error.code not in RETRYABLE_HTTP and error.code != 416:
                raise RuntimeError(f"non-retryable HTTP {error.code} for {product.filename}") from error
            key = str(error.code)
            http_retries[key] = http_retries.get(key, 0) + 1
            last_error = error
        except IntegrityError as error:
            partial.unlink(missing_ok=True)
            key = type(error).__name__
            error_retries[key] = error_retries.get(key, 0) + 1
            last_error = error
        except Exception as error:  # 연결 중단은 .part를 보존해 다음 시도에서 Range로 재개한다.
            key = type(error).__name__
            error_retries[key] = error_retries.get(key, 0) + 1
            last_error = error
        if attempt < retries:
            delay = _retry_delay(last_error or RuntimeError("retry"), attempt, now)
            log(f"[retry] {product.filename} attempt={attempt} delay={delay:g}s error={type(last_error).__name__}")
            _sleep_with_progress(delay, sleep, progress)
    raise RuntimeError(f"failed to download {product.filename}: {last_error}")


def load_checksums(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    checksums = {str(row["filename"]): str(row["sha256"]) for row in payload.get("files", [])}
    if any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in checksums.values()):
        raise ValueError("checksum file contains an invalid SHA-256")
    return checksums


def repair_event_log(path: Path) -> bool:
    """프로세스 강제 종료로 마지막 JSON 한 줄만 찢어진 경우 안전하게 제거한다."""
    if not path.is_file() or path.stat().st_size == 0:
        return False
    with path.open("r+b") as handle:
        data = handle.read()
        if data.endswith(b"\n"):
            return False
        last_newline = data.rfind(b"\n")
        tail = data[last_newline + 1 :]
        try:
            value = json.loads(tail.decode("utf-8"))
            if value.get("schema") != EVENT_SCHEMA or "filename" not in value:
                raise ValueError("invalid final event")
            handle.seek(0, os.SEEK_END)
            handle.write(b"\n")
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError):
            handle.truncate(last_newline + 1)
        handle.flush()
        os.fsync(handle.fileno())
    return True


def append_event(path: Path, event: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o640)
    try:
        written = 0
        while written < len(encoded):
            written += os.write(descriptor, encoded[written:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def select_products(
    source_list: dict,
    *,
    worker_slot: int | None,
    sectors: set[int] | None = None,
    checksums: dict[str, str] | None = None,
    checksums_only: bool = False,
    limit: int | None = None,
) -> list[Product]:
    checksums = checksums or {}
    products = [Product.from_dict(row) for row in source_list["products"]]
    if worker_slot is not None:
        worker_count = int(source_list["worker_count"])
        if not 1 <= worker_slot <= worker_count:
            raise ValueError(f"worker_slot must be between 1 and {worker_count}")
        products = [item for item in products if item.assigned_worker == worker_slot]
    if sectors:
        unknown = sectors - {int(row["sector"]) for row in source_list["products"]}
        if unknown:
            raise ValueError(f"source list does not contain sectors: {sorted(unknown)}")
        products = [item for item in products if item.sector in sectors]
    if checksums_only:
        products = [item for item in products if item.filename in checksums]
    if limit is not None:
        if limit < 1:
            raise ValueError("limit must be positive")
        products = products[:limit]
    return products


def run_download(
    source_list: dict,
    output_root: Path,
    events_path: Path,
    *,
    worker_slot: int | None,
    sectors: set[int] | None = None,
    checksums: dict[str, str] | None = None,
    checksums_only: bool = False,
    limit: int | None = None,
    retries: int = 5,
    max_part_bytes: int = 64 << 20,
    disk_stop_fraction: float = 0.75,
    max_consecutive_failures: int = 10,
    concurrency: int = 1,
    downloader: Callable = download_product,
    progress: Callable[[], None] = lambda: None,
) -> tuple[dict, int]:
    if not 1 <= concurrency <= 4:
        raise ValueError("concurrency must be between 1 and 4")
    checksums = checksums or {}
    products = select_products(
        source_list,
        worker_slot=worker_slot,
        sectors=sectors,
        checksums=checksums,
        checksums_only=checksums_only,
        limit=limit,
    )

    run_id = str(uuid.uuid4())
    started_at = utc_now()
    repair_event_log(events_path)
    validated = cached = downloaded = failed = 0
    consecutive_failures = 0
    failures: list[dict[str, str]] = []
    stopped_capacity = False
    stopped_circuit = False
    progress()

    def execute(indexed_product: tuple[int, Product]) -> dict:
        index, product = indexed_product
        destination = output_root / f"sector={product.sector:04d}" / product.filename
        try:
            event = downloader(
                product,
                destination,
                expected_sha256=checksums.get(product.filename),
                retries=retries,
                max_part_bytes=max_part_bytes,
                disk_stop_fraction=disk_stop_fraction,
                progress=progress,
            )
            event.update({"run_id": run_id, "sequence": index})
        except CapacityStop as error:
            event = {
                "schema": EVENT_SCHEMA,
                "status": "STOPPED_CAPACITY",
                "recorded_at": utc_now(),
                "run_id": run_id,
                "sequence": index,
                **asdict(product),
                "error": str(error),
            }
        except Exception as error:
            event = {
                "schema": EVENT_SCHEMA,
                "status": "FAILED",
                "recorded_at": utc_now(),
                "run_id": run_id,
                "sequence": index,
                **asdict(product),
                "error_type": type(error).__name__,
                "error": str(error)[:1000],
            }
        return event

    processed = 0
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="tess-download") as pool:
        for start in range(0, len(products), concurrency):
            indexed = list(enumerate(products[start : start + concurrency], start + 1))
            for event in pool.map(execute, indexed):
                processed += 1
                append_event(events_path, event)
                progress()
                if event["status"] == "VALIDATED":
                    validated += 1
                    if event["cached"]:
                        cached += 1
                    else:
                        downloaded += 1
                    if not stopped_circuit:
                        consecutive_failures = 0
                elif event["status"] == "STOPPED_CAPACITY":
                    stopped_capacity = True
                    failures.append({"filename": event["filename"], "error": event["error"]})
                else:
                    failed += 1
                    consecutive_failures += 1
                    failures.append({"filename": event["filename"], "error": event["error"]})
                    if consecutive_failures >= max_consecutive_failures:
                        stopped_circuit = True
            if stopped_capacity or stopped_circuit:
                break

    summary = {
        "schema": RUN_SCHEMA,
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": utc_now(),
        "source_list_sha256": source_list["source_list_sha256"],
        "worker_slot": worker_slot,
        "selected": len(products),
        "processed": processed,
        "concurrency": concurrency,
        "validated": validated,
        "downloaded": downloaded,
        "cached": cached,
        "failed": failed,
        "stopped_capacity": stopped_capacity,
        "stopped_circuit": stopped_circuit,
        "consecutive_failures": consecutive_failures,
        "events_path": str(events_path),
        "failures": failures,
    }
    return summary, 2 if stopped_capacity else (3 if stopped_circuit else (1 if failed else 0))


def audit_download(
    source_list: dict,
    output_root: Path,
    events_path: Path,
    *,
    worker_slot: int | None,
    sectors: set[int] | None = None,
    checksums: dict[str, str] | None = None,
    checksums_only: bool = False,
    limit: int | None = None,
    progress: Callable[[], None] = lambda: None,
) -> tuple[dict, int]:
    checksums = checksums or {}
    products = select_products(
        source_list,
        worker_slot=worker_slot,
        sectors=sectors,
        checksums=checksums,
        checksums_only=checksums_only,
        limit=limit,
    )
    latest: dict[str, dict] = {}
    if events_path.is_file():
        for line_number, line in enumerate(events_path.read_text(encoding="utf-8").splitlines(), 1):
            try:
                event = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid event JSON at line {line_number}") from error
            if event.get("schema") != EVENT_SCHEMA or "filename" not in event:
                raise ValueError(f"invalid event at line {line_number}")
            latest[str(event["filename"])] = event

    errors: list[dict[str, str]] = []
    total_bytes = 0
    progress()
    for product in products:
        progress()
        event = latest.get(product.filename)
        if not event or event.get("status") != "VALIDATED":
            errors.append({"filename": product.filename, "error": "latest event is not VALIDATED"})
            continue
        path = output_root / f"sector={product.sector:04d}" / product.filename
        partial = path.with_name(path.name + ".part")
        try:
            if partial.exists():
                raise IntegrityError(f"partial file remains: {partial}")
            header = validate_fits(path, product)
            digest = sha256_file(path)
            if digest != event.get("sha256"):
                raise IntegrityError(f"event checksum mismatch: {digest} != {event.get('sha256')}")
            if checksums.get(product.filename) and digest != checksums[product.filename]:
                raise IntegrityError(f"fixed checksum mismatch: {digest} != {checksums[product.filename]}")
            expected_snapshot = input_snapshot_id(product.sector, digest, str(header["PROCVER"]))
            if expected_snapshot != event.get("input_snapshot_id"):
                raise IntegrityError("input_snapshot_id mismatch")
            total_bytes += path.stat().st_size
        except (OSError, IntegrityError, ValueError) as error:
            errors.append({"filename": product.filename, "error": str(error)})
    summary = {
        "schema": "planetory.download-audit.v1",
        "audited_at": utc_now(),
        "source_list_sha256": source_list["source_list_sha256"],
        "worker_slot": worker_slot,
        "sectors": sorted(sectors) if sectors else None,
        "expected": len(products),
        "validated": len(products) - len(errors),
        "total_bytes": total_bytes,
        "errors": errors,
    }
    return summary, 1 if errors else 0
