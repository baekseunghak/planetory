# -*- coding: utf-8 -*-
"""Planetory 공용 천문 계산 커널.

Spark 배치(Silver 반복 탐색)와 EC2 온라인 Worker(사용자 잔차 계산)가 같은 수식을 쓰도록
순수 함수만 둔다. 파일·DB·네트워크·큐를 다루지 않는다.
"""

from astro_kernel.transit_model import (
    DEFAULT_RESIDUAL_MODEL_VERSION,
    SUPPORTED_BASELINE_KINDS,
    SUPPORTED_RESIDUAL_MODEL_VERSIONS,
    SUPPORTED_SHAPES,
    RemovalResult,
    TransitModel,
    TransitModelError,
    combined_model_flux,
    model_flux,
    parse_transit_model,
    parse_transit_models,
    phase_distance_days,
    remove_transit_models,
    segment_times,
)

__all__ = [
    "DEFAULT_RESIDUAL_MODEL_VERSION",
    "SUPPORTED_BASELINE_KINDS",
    "SUPPORTED_RESIDUAL_MODEL_VERSIONS",
    "SUPPORTED_SHAPES",
    "RemovalResult",
    "TransitModel",
    "TransitModelError",
    "combined_model_flux",
    "model_flux",
    "parse_transit_model",
    "parse_transit_models",
    "phase_distance_days",
    "remove_transit_models",
    "segment_times",
]
