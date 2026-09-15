# -*- coding: utf-8 -*-
"""고정 transit 모델 생성과 잔차 제거 (Jira S15P21C206-121, 계획 ID D14-1).

계약 요약 (v0 초안. 최종 규약은 D06 `S15P21C206-113` 에서 승인한다)
- 입력 모델은 Gold `candidates.transit_model` JSONB 와 같은 형식의 dict 다. 단위는 ERD 열 이름과
  같다: period_days(일), epoch_btjd(BTJD), duration_hours(시간), depth_ppm(ppm).
- 모델은 **고정**이다. 재적합(joint_refit)·baseline 재정규화를 하지 않는다. v0 의 baseline 은
  `unity`(곡선이 이미 1 로 정규화됨) 하나만 지원한다.
- 잔차 = flux / (모델들의 곱). 곱하는 순서는 모델 정렬 키로 고정하므로 같은 모델 집합이면 입력 순서와
  무관하게 같은 환경에서 비트 단위로 같은 결과가 나온다.
- 빈 모델 목록이면 flux 를 float64 로 복사해 그대로 돌려준다.
- 시각(time)은 모두 유한해야 한다. 비유한 시각은 계산 전에 `invalid_time` 으로 실패한다(v0 초안 정책).
  flux 의 NaN(빈 bin·결측)은 결과에서도 NaN 이며 점을 지우거나 채우지 않는다.
- 유효한 flux 위치에서 계산 결과가 새로 NaN·Inf 가 되면 `numerical_failure`, 결합 모델이 0 이하면
  `nonpositive_model` 로 실패한다. 부분 결과를 내지 않는다.
- 호출자는 중복 없는 모델 목록을 넘긴다. 같은 후보를 두 번 넣으면 두 번 나눈다(중복 검사는 소비자 책임).
- 해상도(2분 원본·10분 비닝 등)는 함수가 알지 못하고 호출자가 시각 배열로 준다.

이 모듈은 numpy 외 의존성이 없고 파일·DB·네트워크를 다루지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

SUPPORTED_SHAPES: tuple[str, ...] = ("box",)
SUPPORTED_BASELINE_KINDS: tuple[str, ...] = ("unity",)
SUPPORTED_RESIDUAL_MODEL_VERSIONS: tuple[str, ...] = ("box-divide-v0",)
DEFAULT_RESIDUAL_MODEL_VERSION = "box-divide-v0"

_PARAMETER_KEYS: tuple[str, ...] = ("period_days", "epoch_btjd", "duration_hours", "depth_ppm")
_PPM_PER_UNIT = 1e6           # depth = depth_ppm / 1e6 (정확히 표현되는 정수로 나눠 500000 ppm → 0.5 가 정확함)
_HOURS_PER_DAY = 24.0
_MINUTES_PER_DAY = 1440.0


class TransitModelError(ValueError):
    """계약 위반. `code` 는 소비자가 상태 매핑에 쓰는 고정 문자열이다.

    code 목록
    - invalid_type: 모델·parameters 가 dict 가 아님, candidate_id 가 문자열이 아님, 배열을 숫자로 바꿀 수 없음,
      model_flux 등에 TransitModel/dict 가 아닌 것이 옴
    - unsupported_shape: shape 누락 또는 지원하지 않는 값
    - missing_parameter / unknown_parameter: 필수 파라미터 누락 / 계약에 없는 키
    - invalid_parameter: 숫자가 아니거나 유한하지 않거나 범위 밖(period·duration ≤ 0, duration ≥ period,
      depth_ppm ≤ 0 또는 ≥ 1,000,000)
    - unsupported_baseline: baseline.kind 가 지원 목록에 없음
    - unsupported_version / version_mismatch: residual_model_version 이 지원 목록에 없음 / 모델 사이 또는 요청값과 다름
    - shape_mismatch: time·flux 가 1차원이 아니거나 길이가 다름
    - invalid_time: time 에 NaN·Inf 가 있음 (v0 초안: 시각은 유효해야 한다)
    - nonpositive_model: 유효 flux 위치에서 결합 모델이 0 이하 (개별 모델은 > 0 이어도 여러 모델의 곱이 underflow 하면 발생 가능)
    - numerical_failure: 유효 flux 위치에서 결합 모델 또는 잔차가 새로 NaN·Inf 가 됨
    - invalid_argument: segment_times 등 스칼라 인자가 범위 밖이거나 숫자가 아님
    """

    def __init__(self, code: str, message: str, *, index: int | None = None, field: str | None = None):
        self.code = code
        self.index = index
        self.field = field
        where = "" if index is None else f"models[{index}]"
        if field is not None:
            where = f"{where}.{field}" if where else field
        super().__init__(f"[{code}] {where + ': ' if where else ''}{message}")


# --------------------------------------------------------------------------- 모델 값 검증 (JSON·객체 공통)

def _as_finite_float(value: Any, *, index: int | None, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise TransitModelError("invalid_parameter", f"숫자가 아님: {value!r}", index=index, field=field)
    out = float(value)
    if not np.isfinite(out):
        raise TransitModelError("invalid_parameter", f"유한하지 않음: {value!r}", index=index, field=field)
    return out


def _validate_model_values(shape: Any, period: Any, epoch: Any, duration: Any, depth_ppm: Any,
                           baseline_kind: Any, version: Any, candidate_id: Any, *, index: int | None) -> None:
    """shape·수치 범위·baseline·version·candidate_id 규칙. parse 와 TransitModel 생성이 같은 함수를 쓴다."""
    if shape not in SUPPORTED_SHAPES:
        raise TransitModelError("unsupported_shape", f"{shape!r} (지원: {SUPPORTED_SHAPES})", index=index, field="shape")
    p = _as_finite_float(period, index=index, field="parameters.period_days")
    _as_finite_float(epoch, index=index, field="parameters.epoch_btjd")
    d = _as_finite_float(duration, index=index, field="parameters.duration_hours")
    dp = _as_finite_float(depth_ppm, index=index, field="parameters.depth_ppm")
    if p <= 0:
        raise TransitModelError("invalid_parameter", f"period_days 는 0 보다 커야 함: {p}", index=index, field="parameters.period_days")
    if d <= 0:
        raise TransitModelError("invalid_parameter", f"duration_hours 는 0 보다 커야 함: {d}", index=index, field="parameters.duration_hours")
    if d / _HOURS_PER_DAY >= p:
        raise TransitModelError("invalid_parameter", f"duration({d}h) 이 period({p}d) 이상", index=index, field="parameters.duration_hours")
    if not (0 < dp < _PPM_PER_UNIT):
        raise TransitModelError("invalid_parameter", f"depth_ppm 은 0 < depth_ppm < 1,000,000 이어야 함(모델이 0 이하가 됨): {dp}",
                                index=index, field="parameters.depth_ppm")
    if baseline_kind not in SUPPORTED_BASELINE_KINDS:
        raise TransitModelError("unsupported_baseline", f"{baseline_kind!r} (지원: {SUPPORTED_BASELINE_KINDS})", index=index, field="baseline.kind")
    if version not in SUPPORTED_RESIDUAL_MODEL_VERSIONS:
        raise TransitModelError("unsupported_version", f"{version!r} (지원: {SUPPORTED_RESIDUAL_MODEL_VERSIONS})",
                                index=index, field="residual_model_version")
    if candidate_id is not None and not isinstance(candidate_id, str):
        raise TransitModelError("invalid_type", "candidate_id 는 문자열이어야 함", index=index, field="candidate_id")


@dataclass(frozen=True)
class TransitModel:
    """검증을 마친 고정 transit 모델. 값은 ERD 단위 그대로 보관한다.

    직접 생성해도 `__post_init__` 이 JSON 파싱과 같은 규칙으로 검증하므로 불량 값은 객체가 되지 못한다.
    """

    shape: str
    period_days: float
    epoch_btjd: float
    duration_hours: float
    depth_ppm: float
    baseline_kind: str = "unity"
    residual_model_version: str = DEFAULT_RESIDUAL_MODEL_VERSION
    candidate_id: str | None = None

    def __post_init__(self) -> None:
        _validate_model_values(self.shape, self.period_days, self.epoch_btjd, self.duration_hours, self.depth_ppm,
                               self.baseline_kind, self.residual_model_version, self.candidate_id, index=None)
        # 정수로 들어온 값도 float 로 통일한다 (frozen 이므로 object.__setattr__ 사용)
        for name in ("period_days", "epoch_btjd", "duration_hours", "depth_ppm"):
            object.__setattr__(self, name, float(getattr(self, name)))

    @property
    def depth(self) -> float:
        """상대 밝기 감소량 (0 < depth < 1). depth_ppm / 1e6."""
        return self.depth_ppm / _PPM_PER_UNIT

    @property
    def duration_days(self) -> float:
        return self.duration_hours / _HOURS_PER_DAY

    @property
    def sort_key(self) -> tuple:
        """결합 순서를 고정하는 키. 같은 집합이면 입력 순서와 무관하게 같은 곱셈 순서가 된다."""
        return (self.period_days, self.epoch_btjd, self.duration_hours, self.depth_ppm,
                self.shape, self.candidate_id or "")

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "shape": self.shape,
            "parameters": {
                "period_days": self.period_days,
                "epoch_btjd": self.epoch_btjd,
                "duration_hours": self.duration_hours,
                "depth_ppm": self.depth_ppm,
            },
            "baseline": {"kind": self.baseline_kind},
            "residual_model_version": self.residual_model_version,
        }
        if self.candidate_id is not None:
            out["candidate_id"] = self.candidate_id
        return out


@dataclass(frozen=True)
class RemovalResult:
    """`remove_transit_models` 의 출력. 배열 길이는 모두 입력 time 과 같다.

    성공한 결과에서는 항상 n_finite_residual == n_valid_input 이다(유효 flux 위치에서 새 NaN·Inf 가 생기면
    결과를 내지 않고 실패하기 때문). 두 값을 모두 두는 이유는 소비자가 이 불변량을 자기 쪽에서 재확인할 수 있게 하려는 것이다.
    """

    flux_residual: np.ndarray          # float64. flux / model_flux. 입력 flux 가 NaN 인 위치는 NaN
    model_flux: np.ndarray             # float64. 제거에 쓴 결합 모델(모든 점에서 유한, > 0)
    models: tuple[TransitModel, ...]   # 실제로 곱한 순서(정렬 후)
    residual_model_version: str
    n_points: int                      # 입력 길이
    n_valid_input: int                 # flux 가 유한한 입력 점 수 (time 은 전부 유한해야 하므로 flux 만 센다)
    n_finite_residual: int             # 결과가 유한한 점 수


# --------------------------------------------------------------------------- JSON 파싱

def parse_transit_model(obj: Mapping[str, Any] | TransitModel, *, index: int | None = None) -> TransitModel:
    """`transit_model` JSON(dict) 하나를 검증해 TransitModel 로 만든다. 이미 TransitModel 이면 그대로 돌려준다.

    필수: shape, parameters{period_days, epoch_btjd, duration_hours, depth_ppm}.
    선택: baseline{kind} (기본 unity), residual_model_version (기본 DEFAULT), candidate_id (문자열).
    구조(dict·키) 검사는 여기서, 값 규칙은 TransitModel 생성 시 `_validate_model_values` 가 맡는다.
    """
    if isinstance(obj, TransitModel):
        return obj
    if not isinstance(obj, Mapping):
        raise TransitModelError("invalid_type", f"dict 가 아님: {type(obj).__name__}", index=index)

    shape = obj.get("shape")
    if shape not in SUPPORTED_SHAPES:
        raise TransitModelError("unsupported_shape", f"{shape!r} (지원: {SUPPORTED_SHAPES})", index=index, field="shape")

    params = obj.get("parameters")
    if not isinstance(params, Mapping):
        raise TransitModelError("invalid_type", "parameters 가 dict 가 아님", index=index, field="parameters")
    missing = [k for k in _PARAMETER_KEYS if k not in params]
    if missing:
        raise TransitModelError("missing_parameter", f"누락 {missing}", index=index, field="parameters")
    unknown = sorted(set(params) - set(_PARAMETER_KEYS))
    if unknown:
        raise TransitModelError("unknown_parameter", f"계약에 없는 키 {unknown}", index=index, field="parameters")

    baseline = obj.get("baseline", {"kind": "unity"})
    if not isinstance(baseline, Mapping):
        raise TransitModelError("unsupported_baseline", f"baseline 은 {{'kind': ...}} dict 여야 함: {baseline!r}",
                                index=index, field="baseline")
    baseline_kind = baseline.get("kind")
    version = obj.get("residual_model_version", DEFAULT_RESIDUAL_MODEL_VERSION)
    candidate_id = obj.get("candidate_id")

    # 값 규칙은 생성자와 공유한다. index 를 메시지에 넣기 위해 먼저 같은 함수로 검사한다.
    _validate_model_values(shape, params["period_days"], params["epoch_btjd"], params["duration_hours"],
                           params["depth_ppm"], baseline_kind, version, candidate_id, index=index)
    return TransitModel(shape=str(shape), period_days=float(params["period_days"]), epoch_btjd=float(params["epoch_btjd"]),
                        duration_hours=float(params["duration_hours"]), depth_ppm=float(params["depth_ppm"]),
                        baseline_kind=str(baseline_kind), residual_model_version=str(version), candidate_id=candidate_id)


def parse_transit_models(objs: Iterable[Mapping[str, Any] | TransitModel]) -> tuple[TransitModel, ...]:
    """목록을 검증한다. 순서는 입력 순서다(정렬은 결합 단계에서)."""
    return tuple(parse_transit_model(obj, index=i) for i, obj in enumerate(objs))


# --------------------------------------------------------------------------- 배열 입력

def _as_1d_float64(values: Any, *, name: str) -> np.ndarray:
    try:
        arr = np.asarray(values, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise TransitModelError("invalid_type", f"{name} 을 float64 배열로 바꿀 수 없음: {exc}") from None
    if arr.ndim != 1:
        raise TransitModelError("shape_mismatch", f"{name} 은 1차원이어야 함 (ndim={arr.ndim})")
    return arr


def _as_time_array(values: Any) -> np.ndarray:
    """시각 배열. v0 초안: 모든 시각이 유한해야 한다. 비유한 시각은 계산 전에 실패한다."""
    t = _as_1d_float64(values, name="time")
    bad = ~np.isfinite(t)
    if bad.any():
        idx = np.flatnonzero(bad)
        raise TransitModelError("invalid_time", f"time 에 비유한 값 {idx.size}개 (첫 위치 {int(idx[0])})", field="time")
    return t


# --------------------------------------------------------------------------- 모델 곡선

def phase_distance_days(time_btjd: Any, period_days: float, epoch_btjd: float) -> np.ndarray:
    """각 시각에서 가장 가까운 통과 중심까지의 거리(일). 범위 [-P/2, P/2). PoC `phase_distance` 와 같은 수식.

    time 은 유한해야 한다(`invalid_time`).
    """
    t = _as_time_array(time_btjd)
    return (t - float(epoch_btjd) + 0.5 * period_days) % period_days - 0.5 * period_days


def model_flux(time_btjd: Any, model: TransitModel | Mapping[str, Any]) -> np.ndarray:
    """box 모델 곡선. 통과 중 1 - depth, 밖 1. 모든 값이 유한하고 0 < 값 ≤ 1.

    통과 경계는 |phase distance| < duration/2 (엄격 부등호). dict 를 주면 검증해서 쓴다.
    """
    m = parse_transit_model(model)
    t = _as_time_array(time_btjd)
    dist = phase_distance_days(t, m.period_days, m.epoch_btjd)
    out = np.ones_like(t)
    out[np.abs(dist) < 0.5 * m.duration_days] = 1.0 - m.depth
    return out


def combined_model_flux(time_btjd: Any, models: Iterable[TransitModel | Mapping[str, Any]]) -> np.ndarray:
    """모델들의 곱. 정렬 키 순서로 곱해 입력 순서와 무관하게 같은 결과를 낸다. 빈 목록이면 전부 1.

    개별 모델은 (0, 1] 이지만 여러 모델의 곱은 underflow 로 0 이나 비정규 수가 될 수 있다.
    그 검사는 `remove_transit_models` 가 유효 flux 위치에 대해 수행한다.
    """
    t = _as_time_array(time_btjd)
    parsed = parse_transit_models(models)
    out = np.ones_like(t)
    for m in sorted(parsed, key=lambda m: m.sort_key):
        out *= model_flux(t, m)
    return out


# --------------------------------------------------------------------------- 잔차 제거

def _resolve_version(models: Sequence[TransitModel], requested: str | None) -> str:
    versions = {m.residual_model_version for m in models}
    if len(versions) > 1:
        raise TransitModelError("version_mismatch", f"모델 사이 residual_model_version 이 다름: {sorted(versions)}",
                                field="residual_model_version")
    version = requested if requested is not None else (next(iter(versions)) if versions else DEFAULT_RESIDUAL_MODEL_VERSION)
    if version not in SUPPORTED_RESIDUAL_MODEL_VERSIONS:
        raise TransitModelError("unsupported_version", f"{version!r} (지원: {SUPPORTED_RESIDUAL_MODEL_VERSIONS})",
                                field="residual_model_version")
    if versions and version not in versions:
        raise TransitModelError("version_mismatch", f"요청 {version!r} 과 모델 {sorted(versions)} 이 다름",
                                field="residual_model_version")
    return version


def remove_transit_models(time_btjd: Any, flux: Any,
                          models: Iterable[Mapping[str, Any] | TransitModel] = (),
                          *, residual_model_version: str | None = None) -> RemovalResult:
    """고정 모델들을 곡선에서 나눠 제거한 잔차를 만든다.

    - time_btjd: 유한한 1차원 시각 배열(BTJD). 해상도는 임의(2분 원본, 10분·확대 비닝 bin 시각 등).
    - flux: time 과 길이가 같은 1차원 배열. NaN 은 결측(빈 bin)이며 결과에서도 NaN 으로 남는다.
    - models: transit_model JSON(dict) 또는 TransitModel 의 목록. 중복 없이 넘긴다. 비어 있으면 flux 복사본을 돌려준다.
    - residual_model_version: 지정하면 모델들의 버전과 일치해야 한다. 지정하지 않으면 모델 버전(없으면 기본값).

    불변량: 빈 목록 → flux 와 값이 같은 float64 배열. 같은 모델 집합 → 순서와 무관하게 같은 값(같은 환경에서 비트 동일).
    유효 flux 위치에서 새 NaN·Inf 가 생기면 결과 대신 실패한다. 결측을 채우거나 삭제하지 않는다.
    """
    t = _as_time_array(time_btjd)
    f = _as_1d_float64(flux, name="flux")
    if t.shape != f.shape:
        raise TransitModelError("shape_mismatch", f"time 길이 {t.shape[0]} 와 flux 길이 {f.shape[0]} 가 다름")

    if np.isinf(f).any():
        # NaN 은 결측(빈 bin)이지만 ±Inf 는 결측이 아니라 계산 실패 값이다. 그대로 나누면 Inf 가 전파된다.
        raise TransitModelError("numerical_failure", f"flux 에 Inf {int(np.isinf(f).sum())}개 (결측은 NaN 으로 표현한다)", field="flux")

    parsed = parse_transit_models(models)
    version = _resolve_version(parsed, residual_model_version)
    ordered = tuple(sorted(parsed, key=lambda m: m.sort_key))
    valid = np.isfinite(f)                      # Inf 는 위에서 걸렀으므로 NaN 만 결측이다
    n_valid = int(valid.sum())

    if not ordered:
        return RemovalResult(flux_residual=f.copy(), model_flux=np.ones_like(t), models=ordered,
                             residual_model_version=version, n_points=int(t.shape[0]),
                             n_valid_input=n_valid, n_finite_residual=n_valid)

    model = combined_model_flux(t, ordered)
    model_valid = model[valid]
    if not np.isfinite(model_valid).all():
        raise TransitModelError("numerical_failure", "유효 flux 위치에서 결합 모델이 NaN·Inf")
    if np.any(model_valid <= 0):
        raise TransitModelError("nonpositive_model", "유효 flux 위치에서 결합 모델이 0 이하(곱셈 underflow 포함)라 나눌 수 없음")
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        residual = f / model
    if not np.isfinite(residual[valid]).all():
        raise TransitModelError("numerical_failure", "유효 flux 위치에서 잔차가 새로 NaN·Inf 가 됨")
    return RemovalResult(flux_residual=residual, model_flux=model, models=ordered, residual_model_version=version,
                         n_points=int(t.shape[0]), n_valid_input=n_valid, n_finite_residual=int(np.isfinite(residual).sum()))


# --------------------------------------------------------------------------- Gold 세그먼트 시각

def segment_times(start_btjd: float, bin_minutes: float, n_points: int) -> np.ndarray:
    """Gold `light_curve_segments` 의 i 번째 점 시각 = start_btjd + i × bin_minutes / 1440 (ERD 시각 복원식).

    ERD 는 `start_btjd` 를 첫 bin 의 **시작** 시각으로 정의한다. 이 함수는 그 식을 그대로 구현하며,
    모델을 bin 중심에서 평가할지는 D06 의 별도 결정 사항이다(이 함수는 바꾸지 않는다).
    """
    def _scalar(value: Any, field: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise TransitModelError("invalid_argument", f"{field} 가 숫자가 아님: {value!r}", field=field)
        out = float(value)
        if not np.isfinite(out):
            raise TransitModelError("invalid_argument", f"{field} 가 유한하지 않음: {value}", field=field)
        return out

    start = _scalar(start_btjd, "start_btjd")
    step_min = _scalar(bin_minutes, "bin_minutes")
    if step_min <= 0:
        raise TransitModelError("invalid_argument", f"bin_minutes 는 0 보다 커야 함: {step_min}", field="bin_minutes")
    if isinstance(n_points, bool) or not isinstance(n_points, (int, np.integer)) or n_points <= 0:
        raise TransitModelError("invalid_argument", f"n_points 는 양의 정수여야 함: {n_points!r}", field="n_points")
    return start + np.arange(int(n_points), dtype=np.float64) * (step_min / _MINUTES_PER_DAY)
