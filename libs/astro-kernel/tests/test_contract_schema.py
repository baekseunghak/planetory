"""`contracts/gold/transit-model.schema.json` 과 astro-kernel 파서가 같은 모델을 받아들이고 같은 모델을 거절하는지 확인한다.

Schema 는 필드·타입·단독 필드 범위만 표현한다. 필드 사이 규칙(duration/24 < period)은 커널만 검사하므로
invalid 예제의 `schema_rejects` 로 두 검사기의 역할을 구분한다.
"""
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from astro_kernel import transit_model as tm

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "contracts" / "gold"
SCHEMA = json.loads((CONTRACT / "transit-model.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA)


def _load(name):
    return json.loads((CONTRACT / "examples" / name).read_text(encoding="utf-8"))


def test_schema_itself_is_valid_draft_2020_12():
    Draft202012Validator.check_schema(SCHEMA)
    assert SCHEMA["$schema"] == "https://json-schema.org/draft/2020-12/schema"


def test_schema_enums_match_kernel_constants():
    props = SCHEMA["properties"]
    assert tuple(props["shape"]["enum"]) == tm.SUPPORTED_SHAPES
    assert tuple(props["baseline"]["properties"]["kind"]["enum"]) == tm.SUPPORTED_BASELINE_KINDS
    assert tuple(props["residual_model_version"]["enum"]) == tm.SUPPORTED_RESIDUAL_MODEL_VERSIONS
    assert tuple(props["parameters"]["required"]) == tm._PARAMETER_KEYS
    assert props["parameters"]["properties"]["depth_ppm"]["exclusiveMaximum"] == tm._PPM_PER_UNIT


def test_valid_examples_pass_schema_and_kernel():
    for obj in _load("transit-model.valid.json"):
        VALIDATOR.validate(obj)
        tm.parse_transit_model(obj)
    for obj in SCHEMA["examples"]:
        VALIDATOR.validate(obj)
        tm.parse_transit_model(obj)


def test_invalid_examples_split_between_schema_and_kernel():
    cases = _load("transit-model.invalid.json")
    assert any(not c["schema_rejects"] for c in cases), "커널만 잡는 규칙 예제가 하나는 있어야 한다"
    for c in cases:
        errors = list(VALIDATOR.iter_errors(c["model"]))
        assert bool(errors) == c["schema_rejects"], (c["case"], [e.message for e in errors])
        with pytest.raises(tm.TransitModelError) as info:
            tm.parse_transit_model(c["model"])
        assert info.value.code == c["expected_code"], c["case"]


def test_kernel_round_trip_output_always_passes_schema():
    for obj in _load("transit-model.valid.json"):
        VALIDATOR.validate(tm.parse_transit_model(obj).to_dict())
    minimal = tm.TransitModel(shape="box", period_days=2, epoch_btjd=1400, duration_hours=1, depth_ppm=1)
    VALIDATOR.validate(minimal.to_dict())


def test_removal_case_models_pass_schema():
    examples = Path(__file__).resolve().parents[1] / "examples"
    for name in ("removal_case.json", "bin_center_case.json"):
        for m in json.loads((examples / name).read_text(encoding="utf-8"))["models"]:
            VALIDATOR.validate(m)
