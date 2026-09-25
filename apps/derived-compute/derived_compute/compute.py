"""온라인 잔차·주기도 계산 [S15P21C206-88].

요청 dict 하나를 받아 응답 envelope dict 하나를 돌려주는 순수 처리다. HTTP·환경 변수·DB·Redis를
알지 않는다. 필드·오류 코드의 정본은 `contracts/derived-compute/README.md`다.
"""
import math
import re

import numpy as np
from astro_kernel import TransitModelError, remove_transit_models, segment_times
from astro_kernel.bls import BlsError, bls_periodogram, period_grid

SCHEMA_VERSION = "1.0"

# 계약 3.4절. objective·oversample·dy는 bls_periodogram이 고정한다(likelihood, 10, 전역 MAD).
# 설정을 바꾸려면 새 버전을 더한다. 기존 행을 고치면 이미 공개한 원본 주기도와 어긋난다.
# provided-bls-1.0.0은 123 제공 해상도 규칙(astro_kernel.discoverability)의 이름이고 설정이 같다. 이름 확정 전까지
# 둘 다 받는다(262 인계). 커널 규칙과 같은지는 테스트가 본다.
PERIODOGRAM_CONFIGS = {
    "pg-log5000-v1": {"spacing": "log", "durations_hours": (1.2, 1.92, 2.88, 4.8)},
    "provided-bls-1.0.0": {"spacing": "log", "durations_hours": (1.2, 1.92, 2.88, 4.8)},
}

_CORRELATION = ("schema_version", "operation", "job_id", "attempt", "publication_bundle_id", "tic_id")
_ID = {
    "job_id": re.compile(r"rj-[1-9]\d*"),
    "publication_bundle_id": re.compile(r"b-[1-9]\d*"),
    "tic_id": re.compile(r"[1-9]\d*"),
}
_CANDIDATE_ID = re.compile(r"c-([1-9]\d*)")
_SEGMENT_ID = re.compile(r"seg-[1-9]\d*")


class RequestError(ValueError):
    def __init__(self, code, message, field=None):
        super().__init__(message)
        self.code = code
        self.field = field


def handle(request, runtime):
    """계약 요청 하나를 처리한다. 부분 결과는 없다: ok=true의 완전한 result 또는 ok=false의 error."""
    known = isinstance(request, dict)
    stage = "PERIODOGRAM" if known and request.get("operation") == "periodogram" else "RESIDUAL"
    envelope = {key: request[key] for key in _CORRELATION if known and key in request}
    envelope["removed_candidate_ids"] = _echo_ids(request) if known else []
    try:
        if not known:
            raise RequestError("invalid_operation_payload", "request must be a JSON object")
        _validate_common(request)
        result = _residual(request) if request["operation"] == "residual" else _periodogram(request)
        envelope.update(ok=True, runtime=runtime, result=result)
    except RequestError as error:
        envelope.update(ok=False, runtime=runtime, error=_error(stage, error.code, str(error), error.field))
    except TransitModelError as error:
        field = error.field
        if error.index is not None:
            field = f"removed_candidates[{error.index}].transit_model" + (f".{field}" if field else "")
        envelope.update(ok=False, runtime=runtime,
                        error=_error(stage, error.code, str(error), field, error.index))
    except BlsError as error:
        envelope.update(ok=False, runtime=runtime, error=_error(stage, error.code, str(error)))
    except MemoryError:
        # 컨테이너 OOM kill과 달리 스스로 멈춘 경우다. 부분 결과는 이미 버려졌다.
        envelope.update(ok=False, runtime=runtime,
                        error=_error(stage, "memory_exhausted", "memory limit reached during computation"))
    return envelope


def _error(stage, code, message, field=None, model_index=None):
    error = {"stage": stage, "code": code, "retryable": False, "message": message}
    if field is not None:
        error["field"] = field
    if model_index is not None:
        error["model_index"] = model_index
    return error


def _echo_ids(request):
    """오류 응답에도 요청의 제거 조합을 그대로 돌려준다. 모양이 틀렸으면 빈 목록이다."""
    if request.get("operation") == "periodogram":
        ids = request.get("removed_candidate_ids")
    else:
        candidates = request.get("removed_candidates")
        ids = [c.get("candidate_id") for c in candidates if isinstance(c, dict)] if isinstance(candidates, list) else None
    return list(ids) if isinstance(ids, list) and all(isinstance(i, str) for i in ids) else []


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _nonempty_text(value):
    return isinstance(value, str) and value != ""


def _validate_common(request):
    if request.get("schema_version") != SCHEMA_VERSION:
        raise RequestError("unsupported_schema_version", f"schema_version must be {SCHEMA_VERSION}", "schema_version")
    if request.get("operation") not in ("residual", "periodogram"):
        raise RequestError("unsupported_operation", "operation must be residual or periodogram", "operation")
    for key, pattern in _ID.items():
        if not (isinstance(request.get(key), str) and pattern.fullmatch(request[key])):
            raise RequestError("invalid_operation_payload", f"invalid {key}", key)
    attempt = request.get("attempt")
    if type(attempt) is not int or attempt < 1:
        raise RequestError("invalid_operation_payload", "attempt must be an integer >= 1", "attempt")
    if not _finite(request.get("fold_reference_time_btjd")):
        raise RequestError("invalid_operation_payload", "fold_reference_time_btjd must be finite",
                           "fold_reference_time_btjd")
    for key in ("residual_model_version", "periodogram_config_version"):
        if not _nonempty_text(request.get(key)):
            raise RequestError("invalid_operation_payload", f"{key} required", key)
    # residual에서도 검사한다. 주기도 단계에서 거절될 요청의 잔차를 계산하지 않는다.
    if request["periodogram_config_version"] not in PERIODOGRAM_CONFIGS:
        raise RequestError("unsupported_periodogram_config_version",
                           f"unknown periodogram_config_version {request['periodogram_config_version']!r}",
                           "periodogram_config_version")


def _payload_keys(request, required, forbidden):
    for key in required:
        if key not in request:
            raise RequestError("invalid_operation_payload", f"{key} required", key)
    for key in forbidden:
        if key in request:
            raise RequestError("invalid_operation_payload", f"{key} not allowed for {request['operation']}", key)


def _check_ids(ids, field):
    """제거 조합은 c- 뒤 정수의 오름차순·중복 없음이다. 빈 목록은 거절한다(계약 3.2절, !211 합의)."""
    if not ids:
        raise RequestError("invalid_operation_payload", "removal combination must not be empty", field)
    numbers = []
    for index, value in enumerate(ids):
        match = isinstance(value, str) and _CANDIDATE_ID.fullmatch(value)
        if not match:
            raise RequestError("invalid_operation_payload", "invalid candidate_id", f"{field}[{index}]")
        numbers.append(int(match.group(1)))
    if len(set(numbers)) != len(numbers):
        raise RequestError("duplicate_candidate_id", "candidate ids must be unique", field)
    if numbers != sorted(numbers):
        raise RequestError("invalid_removed_candidate_order", "candidate ids must be ascending", field)


def _segments(segments, field):
    if not isinstance(segments, list) or not segments:
        raise RequestError("invalid_operation_payload", f"{field} must be a non-empty list", field)
    parsed = []
    for index, segment in enumerate(segments):
        where = f"{field}[{index}]"
        if not isinstance(segment, dict):
            raise RequestError("invalid_operation_payload", "segment must be an object", where)
        if not (isinstance(segment.get("segment_id"), str) and _SEGMENT_ID.fullmatch(segment["segment_id"])):
            raise RequestError("invalid_operation_payload", "invalid segment_id", f"{where}.segment_id")
        n_points, flux = segment.get("n_points"), segment.get("flux")
        if type(n_points) is not int or n_points <= 0 or not isinstance(flux, list) or len(flux) != n_points:
            raise RequestError("flux_length_mismatch", "flux length must equal n_points", f"{where}.flux")
        if not all(value is None or _finite(value) for value in flux):
            raise RequestError("invalid_operation_payload", "flux values must be finite or null", f"{where}.flux")
        if (type(segment.get("sector")) is not int or segment["sector"] <= 0
                or not _nonempty_text(segment.get("binning_revision"))
                or not _finite(segment.get("start_btjd"))
                or not _finite(segment.get("bin_minutes")) or segment["bin_minutes"] <= 0):
            raise RequestError("invalid_operation_payload", "invalid segment metadata", where)
        # null ↔ NaN 변환은 이 어댑터에서만 한다.
        values = np.array([np.nan if value is None else value for value in flux], dtype=np.float64)
        # 113 결정: Gold start_btjd는 첫 bin 시작이다. bin 중심으로 옮기는 주체는 이 어댑터 하나다.
        times = segment_times(segment["start_btjd"] + segment["bin_minutes"] / 2880,
                              segment["bin_minutes"], n_points)
        parsed.append((segment["segment_id"], times, values))
    return parsed


def _json_flux(values):
    return [float(value) if math.isfinite(value) else None for value in values.tolist()]


def _residual(request):
    _payload_keys(request, ("curve_segments", "removed_candidates"), ("residual_segments", "period_grid"))
    candidates = request["removed_candidates"]
    if not isinstance(candidates, list):
        raise RequestError("invalid_operation_payload", "removed_candidates must be a list", "removed_candidates")
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict) or not isinstance(candidate.get("transit_model"), dict):
            raise RequestError("invalid_operation_payload", "candidate needs transit_model",
                               f"removed_candidates[{index}]")
    _check_ids([candidate.get("candidate_id") for candidate in candidates], "removed_candidates")
    for index, candidate in enumerate(candidates):
        if candidate["transit_model"].get("candidate_id") != candidate["candidate_id"]:
            raise RequestError("invalid_operation_payload", "transit_model.candidate_id must match candidate_id",
                               f"removed_candidates[{index}].transit_model.candidate_id")
    models = [candidate["transit_model"] for candidate in candidates]
    segments = _segments(request["curve_segments"], "curve_segments")

    out, n_input, n_valid, n_finite = [], 0, 0, 0
    for segment_id, times, values in segments:
        removed = remove_transit_models(times, values, models,
                                        residual_model_version=request["residual_model_version"])
        out.append({"segment_id": segment_id, "n_points": removed.n_points,
                    "flux": _json_flux(removed.flux_residual)})
        n_input += removed.n_points
        n_valid += removed.n_valid_input
        n_finite += removed.n_finite_residual
    return {"residual_model_version": request["residual_model_version"], "residual_segments": out,
            "n_input_points": n_input, "n_valid_input": n_valid, "n_finite_residual": n_finite}


def _periodogram(request):
    _payload_keys(request, ("residual_segments", "removed_candidate_ids", "period_grid"),
                  ("curve_segments", "removed_candidates"))
    if not isinstance(request["removed_candidate_ids"], list):
        raise RequestError("invalid_operation_payload", "removed_candidate_ids must be a list",
                           "removed_candidate_ids")
    _check_ids(request["removed_candidate_ids"], "removed_candidate_ids")
    config = PERIODOGRAM_CONFIGS[request["periodogram_config_version"]]
    grid = request["period_grid"]
    if not isinstance(grid, dict) or grid.get("spacing") != config["spacing"]:
        raise RequestError("invalid_period_grid", f"spacing must be {config['spacing']}", "period_grid.spacing")
    if not _finite(grid.get("min_days")) or not _finite(grid.get("max_days")) or type(grid.get("count")) is not int:
        raise RequestError("invalid_period_grid", "min_days, max_days and integer count required", "period_grid")
    try:
        periods = period_grid(grid["min_days"], grid["max_days"], grid["count"], spacing=grid["spacing"])
    except BlsError as error:
        raise RequestError("invalid_period_grid", str(error), "period_grid") from error
    segments = _segments(request["residual_segments"], "residual_segments")

    # 원본 주기도와 같은 축: 세그먼트를 이어 붙이고 시각순으로 안정 정렬한다(discoverability.provided_arrays).
    times = np.concatenate([t for _, t, _ in segments])
    values = np.concatenate([f for _, _, f in segments])
    order = np.argsort(times, kind="stable")
    result = bls_periodogram(times[order], values[order], periods, durations_hours=config["durations_hours"],
                             config_version=request["periodogram_config_version"])
    return {"periodogram_config_version": request["periodogram_config_version"], "n_periods": len(periods),
            "period_days": [float(p) for p in result.periods], "power": [float(p) for p in result.power]}
