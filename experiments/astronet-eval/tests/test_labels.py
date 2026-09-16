from pathlib import Path

import pytest

from astronet_eval import labels as lb
from tess_fixture.targets import TARGETS, TARGETS_BY_KEY


def _ref(**over):
    row = {"target_key": "toi270", "role": "multi_planet_m_dwarf", "tic_id": "TIC 259377017", "hostname": "TOI-270",
           "pl_name": "TOI-270 c", "pl_orbper": "5.66051", "pl_tranmid": "2458463.08056", "pl_trandur": "1.682",
           "pl_trandep": "0.3451844", "tran_flag": "1", "fetched_at": "2026-09-10T02:42:35+00:00"}
    row.update(over)
    return row


def test_split_is_deterministic_and_binary():
    for t in TARGETS:
        assert lb.split_for_tic(t.tic_id) == lb.split_for_tic(t.tic_id)
        assert lb.split_for_tic(t.tic_id) in ("calibration", "evaluation")
    assert lb.split_for_tic("259377017") == lb.split_for_tic(259377017)


def test_pc_candidate_parsing_and_units():
    cands, skipped = lb.candidates_from_references([_ref()], TARGETS_BY_KEY)
    assert not skipped and len(cands) == 1
    c = cands[0]
    assert c.label == "PC" and c.in_truth and c.candidate_id == "toi270-pc-toi-270-c"
    assert c.tic_id == 259377017 and c.baseline_id == "toi270-real" and c.geometry_source == "archive"
    assert c.epoch_btjd == pytest.approx(2458463.08056 - 2457000)
    assert c.duration_hours == 1.682 and c.depth_ppm == pytest.approx(3451.844)
    assert c.label_snapshot == "2026-09-10T02:42:35+00:00" and c.training_overlap == "unknown"


@pytest.mark.parametrize("over, reason", [
    ({"tran_flag": "0"}, "not_transiting"),
    ({"pl_name": ""}, "no_planet_row"),
    ({"pl_trandur": ""}, "missing_period_epoch_or_duration"),
    ({"pl_tranmid": ""}, "missing_period_epoch_or_duration"),
    ({"target_key": "nope"}, "unknown_target"),
    ({"pl_trandur": "200"}, "invalid_geometry"),          # 200h ≥ 5.66d
])
def test_reference_rows_are_skipped_with_reason(over, reason):
    cands, skipped = lb.candidates_from_references([_ref(**over)], TARGETS_BY_KEY)
    assert not cands and skipped[0]["skip_reason"] == reason


def test_missing_depth_is_allowed_but_noted():
    cands, _ = lb.candidates_from_references([_ref(pl_trandep="")], TARGETS_BY_KEY)
    assert cands[0].depth_ppm is None and "depth missing" in cands[0].notes


def test_eb_placeholder_for_cm_dra():
    ebs = lb.eb_placeholders(list(TARGETS), snapshot="targets.py sha256 abc")
    assert [e.target_key for e in ebs] == ["cm_dra"]
    e = ebs[0]
    assert e.label == "EB" and e.epoch_btjd is None and e.duration_hours is None
    assert e.period_days == pytest.approx(1.2683900573) and e.geometry_source == "bls_at_known_period"


def test_split_integrity_and_duplicate_ids():
    a, _ = lb.candidates_from_references([_ref()], TARGETS_BY_KEY)
    b, _ = lb.candidates_from_references([_ref(pl_name="TOI-270 b", pl_orbper="3.35992")], TARGETS_BY_KEY)
    lb.check_split_integrity(a + b)
    b[0].split = "evaluation" if a[0].split == "calibration" else "calibration"
    with pytest.raises(ValueError):
        lb.check_split_integrity(a + b)
    with pytest.raises(ValueError):
        lb.check_split_integrity(a + a)


def test_labels_csv_round_trip(tmp_path: Path):
    cands, _ = lb.candidates_from_references([_ref(), _ref(pl_name="TOI-270 b", pl_orbper="3.35992", pl_trandep="")], TARGETS_BY_KEY)
    cands += lb.eb_placeholders(list(TARGETS), snapshot="x")
    path = lb.write_labels(cands, tmp_path / "labels.csv")
    back = lb.read_labels(path)
    assert [c.as_row() for c in back] == [c.as_row() for c in cands]
    assert back[1].depth_ppm is None and back[2].epoch_btjd is None
    s = lb.summarize(back)
    assert s["n_candidates"] == 3 and s["n_tics"] == 2 and s["in_truth"] == 3
