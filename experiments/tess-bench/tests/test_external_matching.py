from copy import deepcopy

import numpy as np
import pytest

from tess_bench.external_matching import disposition, match_source, normalize_epoch, snapshot_proposal


def signal(**kwargs):
    return dict(tic_id="123", period_days=2.0, epoch_btjd=1.0, duration_hours=2.0,
                time_system="BTJD-TDB", **kwargs)


TIMES = np.arange(0, 10, 1 / 720)


def test_same_tic_multiple_planets_not_cross_joined_and_inputs_unchanged():
    a = signal(candidate_id="a", ai_score=.1)
    b = signal(candidate_id="b")
    b["period_days"] = 3.0
    x, y = signal(external_id="x"), {**b, "external_id": "y"}
    original = deepcopy([a, b, x, y])
    result = match_source([a, b], [x, y], TIMES)
    assert [(r["status"], r["matched_candidate_id"]) for r in result["rows"]] == [
        ("direct_match", "a"), ("direct_match", "b")]
    assert [a, b, x, y] == original
    assert result["approved"] is False


@pytest.mark.parametrize("many_internal", [True, False])
def test_many_to_one_and_one_to_many_are_ambiguous(many_internal):
    internal = [signal(candidate_id="a")]
    external = [signal(external_id="x")]
    if many_internal:
        internal.append(signal(candidate_id="b"))
    else:
        external.append(signal(external_id="y"))
    result = match_source(internal, external, TIMES)
    assert all(r["status"] == "ambiguous_match" and r["matched_candidate_id"] is None for r in result["rows"])


def test_epoch_integer_cycles_are_equivalent():
    ext = signal(external_id="x")
    ext["epoch_btjd"] += 200
    assert match_source([signal(candidate_id="a")], [ext], TIMES)["rows"][0]["status"] == "direct_match"


@pytest.mark.parametrize("factor", [.5, 2.0, 4.0])
def test_harmonics_do_not_attach_label(factor):
    ext = signal(external_id="x")
    ext["period_days"] *= factor
    row = match_source([signal(candidate_id="a")], [ext], TIMES)["rows"][0]
    assert row["status"] == "possible_alias"
    assert row["matched_candidate_id"] is None


def test_no_observed_transit_is_not_direct():
    result = match_source([signal(candidate_id="a")], [signal(external_id="x")], [.1, .2, .3])
    assert result["rows"][0]["status"] == "external_only"
    assert result["evidence"][0]["observed_jaccard"] is None


@pytest.mark.parametrize("system", ["BJD", "JD", "", None])
def test_unknown_time_standard_fails_closed(system):
    with pytest.raises(ValueError):
        normalize_epoch(2457001, system)
    ext = signal(external_id="x")
    ext["time_system"] = system
    assert match_source([signal(candidate_id="a")], [ext], TIMES)["rows"][0]["status"] == "invalid_external"


def test_explicit_epoch_conversion():
    assert normalize_epoch(2457001, "BJD-TDB") == 1
    assert normalize_epoch(1, "BTJD-TDB") == 1


@pytest.mark.parametrize("value", [float("nan"), 0, -1])
def test_invalid_duration(value):
    ext = signal(external_id="x")
    ext["duration_hours"] = value
    assert match_source([signal(candidate_id="a")], [ext], TIMES)["rows"][0]["status"] == "invalid_external"


def test_different_tic_and_offset_not_matched():
    ext = signal(external_id="x")
    ext["tic_id"] = "456"
    assert match_source([signal(candidate_id="a")], [ext], TIMES)["rows"][0]["status"] == "external_only"
    ext["tic_id"], ext["epoch_btjd"] = "123", 1.5
    assert match_source([signal(candidate_id="a")], [ext], TIMES)["rows"][0]["status"] == "external_only"


@pytest.mark.parametrize("labels,truth,conflict", [
    (["KP", "CP"], "planet", False), (["FP", "FA"], "not_planet", False),
    (["PC", "APC"], None, False), (["CP", "FP"], None, True),
    (["CP", "PC"], None, True), (["unknown"], None, True), ([], None, False),
])
def test_tfopwg_labels_and_conflicts(labels, truth, conflict):
    result = disposition(labels)
    assert result["planet_truth"] == truth
    assert result["source_conflict"] == conflict


def test_failed_partial_and_same_snapshot_preserve_previous():
    previous = {"source": "toi", "scope": "9tics", "sha256": "a" * 64}
    incoming = {**previous, "sha256": "b" * 64}
    for complete, validated in [(False, True), (True, False), (False, False)]:
        result = snapshot_proposal(previous, incoming, complete=complete, validated=validated)
        assert result == {"action": "retain_previous", "current": previous}
        assert result["current"] is not previous
    assert snapshot_proposal(previous, previous, complete=True, validated=True)["action"] == "unchanged"
    result = snapshot_proposal(previous, incoming, complete=True, validated=True)
    assert result["action"] == "review_new_snapshot" and result["current"] == previous


def test_snapshot_scope_cannot_be_silently_replaced():
    previous = {"source": "toi", "scope": "9tics", "sha256": "a" * 64}
    with pytest.raises(ValueError, match="scope"):
        snapshot_proposal(previous, {**previous, "scope": "subset"}, complete=True, validated=True)
