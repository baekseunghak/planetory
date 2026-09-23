"""생성한 payload 가 정답표·Gold 계약과 맞는지 DB 없이 본다."""
import json
from pathlib import Path

import numpy as np
from astro_kernel import parse_transit_model, phase_distance_days
from jsonschema import Draft202012Validator

from local_seed.canonical import array_checksum, record_checksum
from local_seed.catalog import CATALOG, TIC_BASE
from local_seed.payload import BINNING_REVISION, build_star
from local_seed.real import FIXTURE

SCHEMA = json.loads((Path(__file__).resolve().parents[4] / "contracts" / "gold" / "transit-model.schema.json")
                    .read_text(encoding="utf-8"))
MANIFEST_KEYS = {"segment_ids", "array_checksums", "residual_model_version", "periodogram_config_version", "binning",
                 "period_grid", "fine_tune", "curve_steps"}


def star(payloads, label):
    return next(p for p in payloads if p["label"] == label)


def edge_to_core(payload, key):
    """통과 가장자리(지속시간의 0.3~0.5)와 가운데(0.2 이내)의 평균 깊이 비. box 면 1 에 가깝고 U자는 작다."""
    m = next(c for c in payload["candidates"] if c["key"] == key)["record"]["transit_model"]["parameters"]
    t = np.concatenate([s["start_btjd"] + (np.arange(s["n_points"]) + 0.5) * s["bin_minutes"] / 1440
                        for s in payload["segments"]])
    f = np.concatenate([[np.nan if v is None else v for v in s["flux"]] for s in payload["segments"]])
    d = np.abs(phase_distance_days(t, m["period_days"], m["epoch_btjd"])) / (m["duration_hours"] / 24)
    ok = np.isfinite(f)
    return (1 - np.mean(f[ok & (d > 0.3) & (d < 0.5)])) / (1 - np.mean(f[ok & (d < 0.2)]))


def test_same_input_gives_same_payload(payloads):
    again = build_star(CATALOG[0])
    assert again["bundle"]["bundle_version"] == payloads[0]["bundle"]["bundle_version"]
    assert again["bundle"]["payload_digest"] == payloads[0]["bundle"]["payload_digest"]


def test_roles_cover_tutorials_challenge_and_pool(payloads):
    tutorials = sorted((p["tutorial_seq"], p["tutorial_intent"]) for p in payloads if p["role"] == "tutorial")
    assert tutorials == [(1, "deep_confirmed"), (2, "shallow_confirmed"), (3, "fp"), (4, "deep_fp"), (5, "multi_fp")]
    (challenge,) = [p for p in payloads if p["role"] == "challenge"]
    assert [c["disposition"]["answer_class"] for c in challenge["candidates"]] == ["analysis"]
    assert challenge["candidates"][0]["ai"]["verdict"] == "approved"
    # 성과 발견은 튜토리얼·진행 회차 대상이 아닌 공개 별에서 고른다(AchievementRepository.pickUndiscoveredStar).
    assert sum(p["role"] == "pool" for p in payloads) >= 5
    assert all(p["tic_id"] > TIC_BASE for p in payloads if p["label"].startswith("SYN-"))
    assert len({p["tic_id"] for p in payloads}) == len(payloads)


def test_tutorial_answers_match_intent(payloads):
    by_intent = {p["tutorial_intent"]: p for p in payloads if p["role"] == "tutorial"}
    truth = {k: [c["disposition"]["planet_truth"] for c in p["candidates"]] for k, p in by_intent.items()}
    assert truth == {"deep_confirmed": ["planet"], "shallow_confirmed": ["planet"], "fp": ["not_planet"],
                     "deep_fp": ["not_planet"], "multi_fp": ["not_planet", "not_planet"]}
    assert by_intent["deep_fp"]["candidates"][0]["record"]["depth_ppm"] > 100_000


def test_gold_contract_shape(payloads):
    validator = Draft202012Validator(SCHEMA)
    for p in payloads:
        manifest = p["bundle"]["manifest"]
        assert MANIFEST_KEYS <= manifest.keys() and manifest["local_seed"]["payload_digest"] == p["bundle"]["payload_digest"]
        assert manifest["fine_tune"]["half_width_cells"] == 3 and manifest["period_grid"]["spacing"] == "log"
        pg = p["periodogram"]
        assert pg["n_periods"] == len(pg["power"]) == 5000 and None not in pg["power"]
        assert pg["period_max_days"] == max(40.0, 1.15 * max(c["record"]["period_days"] for c in p["candidates"]))
        assert array_checksum(pg["power"]) == pg["checksum"]
        for seg in p["segments"]:
            assert len(seg["flux"]) == seg["n_points"] <= 20_000
            assert array_checksum(seg["flux"]) == seg["checksum"]
        # 한 판의 세그먼트 revision 은 하나다(탐사 API 5.1절). 여럿이면 백엔드가 적재 계약 위반으로 500 을 낸다.
        assert len({seg["binning_revision"] for seg in p["segments"]}) == 1
        steps = [c["record"]["removal_step"] for c in p["candidates"]]
        assert steps == list(range(len(steps)))
        for c in p["candidates"]:
            model = c["record"]["transit_model"]
            assert not list(validator.iter_errors({**model, "candidate_id": "c-1"}))
            parse_transit_model(model)
            assert c["record"]["is_confirmed"] == (c["disposition"]["disposition"] == "confirmed")
        assert p["star"]["confirmed_count"] == sum(c["record"]["is_confirmed"] for c in p["candidates"])
        for kind, rows in p["records"].items():
            assert record_checksum(kind, rows) == manifest["record_checksums"][kind]
    assert {seg["binning_revision"] for p in payloads if p["label"].startswith("SYN-") for seg in p["segments"]} \
        == {BINNING_REVISION}


def test_undiscoverable_signal_is_kept_with_false(payloads):
    assert [c["record"]["discoverable"] for c in star(payloads, "SYN-10")["candidates"]] == [True, False]


def test_pool_transits_have_realistic_edges_and_tutorials_stay_box(payloads):
    # 실제 TOI-270 c 는 0.60 이다(README 비교표). 튜토리얼은 풀이가 확실하도록 box 다.
    assert edge_to_core(star(payloads, "SYN-01"), "b") > 0.95
    assert edge_to_core(star(payloads, "SYN-07"), "b") < 0.85
    assert edge_to_core(star(payloads, "SYN-12"), "b") < 0.85
    assert edge_to_core(star(payloads, "TOI-270"), "c") < 0.75
    shaped = {s.label for s in CATALOG if any(sig.shape != "box" for sig in s.signals)}
    assert all(not p["residual_peaks"] for p in payloads if p["label"] not in shaped)


def test_real_star_is_the_repository_example_unchanged(payloads):
    src = json.loads(FIXTURE.read_text(encoding="utf-8"))
    toi = star(payloads, "TOI-270")
    assert toi["tic_id"] == src["star"]["tic_id"] and toi["bundle"]["bundle_version"] == src["bundle"]["bundle_version"]
    assert toi["segments"][0]["checksum"] == src["checksums"]["segment:3:10m-v1:flux"]
    assert toi["periodogram"]["checksum"] == src["checksums"]["periodogram:power"]
    assert toi["bundle"]["manifest"]["record_checksums"] == src["bundle"]["manifest"]["record_checksums"]
    assert [c["disposition"]["planet_truth"] for c in toi["candidates"]] == ["planet"] * 3
