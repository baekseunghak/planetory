"""Worker 회귀 검사: 계약 fixture 재생, 합성 곡선 계산, HTTP 경계 [S15P21C206-88]."""
import copy
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pytest

from derived_compute import compute
from derived_compute.compute import handle
from derived_compute.server import PATH, make_server

EXAMPLES = Path(__file__).resolve().parents[3] / "contracts" / "derived-compute" / "examples"
VALID = json.loads((EXAMPLES / "derived-compute.valid.json").read_text(encoding="utf-8"))
INVALID = json.loads((EXAMPLES / "derived-compute.invalid.json").read_text(encoding="utf-8"))
CALLS = {call["id"]: call for call in VALID["calls"]}
RUNTIME = {"worker_image": "test", "python": "x", "numpy": "x", "astropy": "x", "astro_kernel": "x"}
CORRELATION = ("schema_version", "operation", "job_id", "attempt", "publication_bundle_id", "tic_id",
               "removed_candidate_ids")


def call(name):
    return copy.deepcopy(CALLS[name])


def mutate(target, mutation):
    *parents, last = mutation["path"].split(".")
    for part in parents:
        target = target[int(part)] if isinstance(target, list) else target[part]
    op = mutation["operation"]
    if op == "set":
        target[last] = mutation["value"]
    elif op == "delete":
        del target[last]
    elif op == "reverse":
        target[last].reverse()
    elif op == "append-clone-first":
        target[last].append(copy.deepcopy(target[last][0]))
    else:
        raise AssertionError(op)


def test_contract_residual_matches_fixture():
    example = call("residual-success")
    response = handle(example["request"], RUNTIME)
    assert response["ok"] is True
    for key in CORRELATION:
        assert response[key] == example["response"][key]
    expected, actual = example["response"]["result"], response["result"]
    for key in ("residual_model_version", "n_input_points", "n_valid_input", "n_finite_residual"):
        assert actual[key] == expected[key]
    got = actual["residual_segments"][0]["flux"]
    want = expected["residual_segments"][0]["flux"]
    assert [v is None for v in got] == [v is None for v in want]
    np.testing.assert_allclose([v for v in got if v is not None], [v for v in want if v is not None],
                               rtol=1e-12, atol=0)


def test_all_null_segment_is_carried_not_rejected():
    # 계약 3.2절: 전부 null인 세그먼트는 거절하지 않고 전부 null로 돌려준다.
    example = call("residual-success")
    empty = dict(example["request"]["curve_segments"][0], segment_id="seg-1002", sector=15,
                 flux=[None] * 6)
    example["request"]["curve_segments"].append(empty)
    response = handle(example["request"], RUNTIME)
    assert response["ok"] is True, response.get("error")
    assert response["result"]["residual_segments"][1]["flux"] == [None] * 6
    assert response["result"]["n_input_points"] == 12
    assert response["result"]["n_valid_input"] == 5


@pytest.mark.parametrize("case", INVALID["request_cases"], ids=lambda c: c["id"])
def test_contract_invalid_requests(case):
    example = call(case.get("base_call", INVALID["base_call"]))
    mutate(example, case["mutation"])
    response = handle(example["request"], RUNTIME)
    assert response["ok"] is False and "result" not in response
    assert response["error"]["code"] == case["expected_error"]
    assert response["error"]["retryable"] is False


def test_contract_periodogram_too_few_points_is_bls_failure():
    # 계약 예제는 6점이라 BLS 최소 100점에 못 미친다. 오류 예제와 같은 envelope가 나와야 한다.
    response = handle(call("periodogram-success")["request"], RUNTIME)
    expected = next(e for e in INVALID["error_responses"] if e["id"] == "periodogram-insufficient-observations")
    assert response["error"]["code"] == expected["response"]["error"]["code"]
    assert response["error"]["stage"] == "PERIODOGRAM"
    for key in CORRELATION:
        assert response[key] == expected["response"][key]


def test_kernel_error_keeps_field_and_model_index():
    example = call("residual-success")
    example["request"]["removed_candidates"][1]["transit_model"]["parameters"]["depth_ppm"] = 0
    error = handle(example["request"], RUNTIME)["error"]
    assert error["code"] == "invalid_parameter" and error["model_index"] == 1
    assert error["field"].startswith("removed_candidates[1].transit_model")


def test_memory_error_is_reported(monkeypatch):
    def exhausted(*args, **kwargs):
        raise MemoryError

    monkeypatch.setattr(compute, "remove_transit_models", exhausted)
    response = handle(call("residual-success")["request"], RUNTIME)
    assert response["ok"] is False and response["error"]["code"] == "memory_exhausted"


def synthetic(period=2.1, epoch=1683.9, depth_ppm=3000.0, n=1600):
    """10분 bin 1,600점(약 11일)에 box 통과를 넣은 곡선."""
    rng = np.random.default_rng(88)
    start, bin_minutes = 1683.35, 10.0
    t = start + (np.arange(n) + 0.5) * bin_minutes / 1440
    phase = np.abs((t - epoch + 0.5 * period) % period - 0.5 * period)
    flux = 1.0 + rng.normal(0, 3e-4, n)
    flux[phase < 1.0 / 24] *= 1 - depth_ppm * 1e-6
    flux = flux.tolist()
    flux[100:110] = [None] * 10
    model = {"candidate_id": "c-1", "shape": "box", "baseline": {"kind": "unity"},
             "residual_model_version": "box-divide-v0",
             "parameters": {"period_days": period, "epoch_btjd": epoch, "duration_hours": 2.0,
                            "depth_ppm": depth_ppm}}
    segment = {"segment_id": "seg-1", "sector": 14, "binning_revision": "10m-v1", "start_btjd": start,
               "bin_minutes": bin_minutes, "n_points": n, "flux": flux}
    return segment, model


def requests_for():
    segment, model = synthetic()
    residual = call("residual-success")["request"]
    residual.update(job_id="rj-5", curve_segments=[segment],
                    removed_candidates=[{"candidate_id": "c-1", "transit_model": model}])
    periodogram = call("periodogram-success")["request"]
    periodogram.update(job_id="rj-5", removed_candidate_ids=["c-1"],
                       period_grid={"min_days": 0.5, "max_days": 5.0, "count": 400, "spacing": "log"})
    return residual, periodogram


def run_both():
    residual, periodogram = requests_for()
    first = handle(residual, RUNTIME)
    assert first["ok"] is True, first.get("error")
    segment = dict(residual["curve_segments"][0], flux=first["result"]["residual_segments"][0]["flux"])
    periodogram["residual_segments"] = [segment]
    second = handle(periodogram, RUNTIME)
    assert second["ok"] is True, second.get("error")
    return first, second


def test_same_input_gives_identical_output():
    assert run_both() == run_both()


def test_removal_flattens_the_injected_peak():
    # 빈 조합은 계약상 거절이므로, 원본 주기도는 제거 전 flux를 주기도 단계에 그대로 넣어 얻는다.
    residual, periodogram = requests_for()
    periodogram["residual_segments"] = residual["curve_segments"]
    raw = handle(periodogram, RUNTIME)
    assert raw["ok"] is True, raw.get("error")
    _, removed = run_both()
    periods, raw_power = np.array(raw["result"]["period_days"]), np.array(raw["result"]["power"])
    best = periods[int(np.argmax(raw_power))]
    assert abs(best - 2.1) / 2.1 < 0.02
    near = np.abs(periods - 2.1) / 2.1 < 0.02
    assert np.max(np.array(removed["result"]["power"])[near]) < 0.2 * np.max(raw_power[near])
    assert raw["result"]["n_periods"] == len(raw["result"]["power"]) == 400


@pytest.fixture
def server():
    def start(concurrency=1, capture_dir=None):
        instance = make_server("127.0.0.1", 0, concurrency=concurrency, capture_dir=capture_dir)
        threading.Thread(target=instance.serve_forever, daemon=True).start()
        started.append(instance)
        return f"http://127.0.0.1:{instance.server_address[1]}"

    started = []
    yield start
    for instance in started:
        instance.shutdown()
        instance.server_close()


def post(base, body):
    request = urllib.request.Request(base + PATH, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_http_envelope_and_health(server):
    base = server()
    status, body = post(base, json.dumps(call("residual-success")["request"]).encode())
    assert status == 200 and body["ok"] is True and body["runtime"]["worker_image"] == "local"
    with urllib.request.urlopen(base + "/healthz", timeout=10) as response:
        assert response.status == 200
    assert post(base, b"{not json")[0] == 400
    assert post(base, b'{"flux": NaN}')[0] == 400


def test_http_busy_is_503(server):
    status, body = post(server(concurrency=0), json.dumps(call("residual-success")["request"]).encode())
    assert status == 503 and body == {"error": "busy"}


def test_capture_writes_request_response_pairs(server, tmp_path):
    base = server(capture_dir=tmp_path)
    request = call("residual-success")["request"]
    _, body = post(base, json.dumps(request).encode())
    hostile = dict(request, job_id="../../escape")
    post(base, json.dumps(hostile).encode())
    files = sorted(tmp_path.iterdir())
    assert len(files) == 2 and all(f.parent == tmp_path for f in files)
    first = json.loads(next(f for f in files if f.name.startswith("rj-78-")).read_text(encoding="utf-8"))
    assert first == {"request": request, "response": body}
    assert post(server(), json.dumps(request).encode())[0] == 200  # 끈 서버는 파일을 남기지 않는다
    assert len(list(tmp_path.iterdir())) == 2
