from copy import deepcopy

import numpy as np
import pytest

from astro_kernel.external_catalog import build_snapshot, join_catalog, code_snapshot, normalize_export_row


def delivery(rows=None, **overrides):
    args = dict(source="toi", scope=["123"], rows=rows if rows is not None else [dict(
        tic_id="123", external_id="1.01", period_days=2.0, epoch_btjd=1.0,
        duration_hours=2.0, time_system="BTJD-TDB", raw_disposition="CP")],
        raw_sha256="a"*64, retrieved_at="2026-09-22T00:00:00Z",
        source_uri="https://example.org/catalog", source_table="toi",
        time_evidence="fixture:explicit-TDB", complete=True, validated=True)
    args.update(overrides)
    return build_snapshot(**args)


def catalog():
    return dict(catalog_ready=True, tic_id=123, bundle_id=10, candidates=[dict(
        candidate_id=100, tic_id=123, updated_bundle_id=10, status="active",
        period_days=2.0, epoch_btjd=1.0, duration_hours=2.0)])


def run(d=None, c=None, previous=None, **kwargs):
    return join_catalog(c or catalog(), d or {"toi": delivery()}, np.arange(0, 10, .01),
                        required_sources=kwargs.get("sources", ["toi"]),
                        approval=kwargs.get("approval", "fixture-only"), previous=previous)


def test_confirmed_preserves_model_and_inputs():
    c, d = catalog(), {"toi": delivery()}
    before = deepcopy((c, d))
    result = run(d, c)
    assert result["status"] == "ready" and result["publishable"] is False
    row = result["rows"][0]
    assert (row["disposition"], row["planet_truth"], row["is_confirmed"]) == ("confirmed", "planet", True)
    assert "applied_at" not in row
    assert row["representative_model"]["period_days"] == 2.0
    assert (c, d) == before


def test_retry_does_not_change_provenance_or_history():
    first = run()
    retry = run({"toi": delivery(retrieved_at="2026-09-23T00:00:00Z")}, previous=first)
    assert retry["status"] == "ready"
    assert retry["rows"] == first["rows"]
    assert retry["changes"] == retry["history"] == []


@pytest.mark.parametrize("label,expected", [("KP", "confirmed"), ("FP", "fp"), ("FA", "fp"), ("PC", "pc"), ("APC", "pc"), ("", "none"), (None, "none")])
def test_labels(label, expected):
    rows = delivery()["snapshot"]["rows"]
    rows[0]["raw_disposition"] = label
    result = run({"toi": delivery(rows)})
    assert result["rows"][0]["disposition"] == expected
    if expected == "none":
        assert result["rows"][0]["source_refs"]["absence_evidence"][0]["reason"] == "missing_field"


@pytest.mark.parametrize("complete,validated", [(False, True), (True, False), (1, True), (True, "true")])
def test_source_failure_retains_previous(complete, validated):
    old = run()
    result = run({"toi": delivery(complete=complete, validated=validated)}, previous=old)
    assert result["status"] == "hold" and not result["changes"]
    assert result["retained_previous"] == old


def test_row_disappears_only_with_complete_scope_evidence():
    old = run()
    new = run({"toi": delivery([], raw_sha256="b"*64)}, previous=old)
    assert new["rows"][0]["disposition"] == "none"
    assert new["rows"][0]["source_refs"]["absence_evidence"][0]["reason"] == "unmatched"
    assert {r["field"] for r in new["history"]} == {"disposition", "planet_truth"}
    assert not run({"toi": delivery([], raw_sha256="b"*64)}, previous=new)["history"]


def test_duplicate_source_does_not_erase_other_diagnostics():
    rows = delivery()["snapshot"]["rows"]
    bad = delivery(rows + rows)
    good = delivery(source="archive")
    result = run({"toi": bad, "archive": good}, sources=["toi", "archive"])
    assert result["status"] == "hold"
    assert "archive" in result["joins"] and not result["rows"]
    assert bad["reasons"] == ["duplicate_external_key"]


@pytest.mark.parametrize("system", ["BJD", "BTJD", "JD", "unverified"])
def test_unknown_times_are_never_absence(system):
    rows = delivery()["snapshot"]["rows"]
    rows[0]["time_system"] = system
    result = run({"toi": delivery(rows)})
    assert result["status"] == "hold" and result["rows"] == []


def test_ambiguity_and_alias_hold():
    rows = delivery()["snapshot"]["rows"]
    extra = dict(rows[0], external_id="1.02")
    assert run({"toi": delivery(rows+[extra])})["status"] == "hold"
    rows[0]["period_days"] = 4.0
    assert run({"toi": delivery(rows)})["joins"]["toi"]["rows"][0]["status"] == "possible_alias"


def test_conflict_unknown_and_missing_label():
    rows = delivery()["snapshot"]["rows"]
    for label, status in [("PC", "hold"), ("unknown", "hold"), ("", "ready")]:
        rows[0]["raw_disposition"] = label
        result = run({"toi": delivery(), "archive": delivery(rows, source="archive")}, sources=["toi", "archive"])
        assert result["status"] == status
        if status == "ready":
            assert result["rows"][0]["source_refs"]["decision_reason"] == "partial_labels"


def test_tamper_and_diagnostic_ids_rejected():
    d = delivery()
    d["snapshot"]["rows"][0]["raw_disposition"] = "FP"
    with pytest.raises(ValueError, match="integrity"):
        run({"toi": d})
    c = catalog()
    c["candidates"][0]["candidate_id"] = "diagnostic:1"
    with pytest.raises(ValueError, match="bigint"):
        run(c=c)


def test_unready_catalog_and_missing_approval_hold():
    c = catalog()
    c["catalog_ready"] = False
    assert run(c=c)["status"] == "hold"
    assert run(approval=None)["status"] == "hold"


def test_recursive_code_hash(tmp_path):
    (tmp_path / "sub").mkdir()
    module = tmp_path / "sub" / "module.py"
    module.write_text("x=1\n")
    before = code_snapshot(tmp_path)
    module.write_text("x=2\n")
    assert before["sub/module.py"] != code_snapshot(tmp_path)["sub/module.py"]


def test_archive_normalization_does_not_manufacture_tfopwg_label():
    raw = dict(tic_id="TIC 123", pl_name="fixture b", pl_orbper="2",
               pl_tranmid="2457001", pl_trandur="2", pl_tranmid_systemref="BJD-TDB", tran_flag="1")
    result = normalize_export_row("nea_pscomppars", raw)
    assert result["row"]["epoch_btjd"] == 1
    assert result["row"]["raw_disposition"] is None
    raw["pl_tranmid_systemref"] = "BJD"
    assert normalize_export_row("nea_pscomppars", raw)["status"] == "hold"
    raw["tran_flag"] = "0"
    assert normalize_export_row("nea_pscomppars", raw)["status"] == "excluded"


def test_actual_122_api_with_fixture_allocations():
    from astro_kernel.candidate_catalog import build_candidate_catalog
    from astro_kernel.iteration import ITERATION_VERSION
    peak = dict(peak_id="fixture", step=0, period_days=2., epoch_btjd=1.,
                duration_hours=2., depth_ppm=1000., snr=10., sde=8., bls_power=100.,
                n_transits=5, original_snr=10., validated_on_original=True)
    iteration = dict(iteration_version=ITERATION_VERSION, complete=True, status="ok",
        termination="no_quality_peak", time_start_btjd=0., time_end_btjd=10., accepted=[peak],
        input_snapshot_id="fixture", preprocessing_version="silver-v1",
        iteration_config_sha256="fixture", qa_failed_step=-1)
    c = build_candidate_catalog(iteration, tic_id=123, bundle_id=10,
        new_candidate_ids={"fixture": 100}, identity_approval="synthetic-only")
    result = run(c=c)
    assert result["status"] == "ready"
    assert result["external_references"][0]["candidate_id"] == 100


@pytest.mark.parametrize("value", [0., -1., float("nan"), float("inf"), True])
def test_invalid_ephemeris_holds(value):
    rows = delivery()["snapshot"]["rows"]
    rows[0]["duration_hours"] = value
    assert delivery(rows)["status"] == "hold"


def test_reverse_ambiguity():
    c = catalog()
    c["candidates"].append(dict(c["candidates"][0], candidate_id=101))
    assert run(c=c)["status"] == "hold"


def test_unknown_source_and_changed_scope_hold():
    assert run({"wrong": delivery()})["status"] == "hold"
    old = run()
    assert run({"toi": delivery(scope=["123", "456"])}, previous=old)["status"] == "hold"


def test_label_transition_and_return_are_real_history():
    first = run()
    rows = delivery()["snapshot"]["rows"]
    rows[0]["raw_disposition"] = "FP"
    second = run({"toi": delivery(rows, raw_sha256="b"*64)}, previous=first)
    third = run(previous=second)
    assert second["rows"][0]["planet_truth"] == "not_planet"
    assert third["rows"][0]["planet_truth"] == "planet"
    assert len(second["history"]) == len(third["history"]) == 2


def test_unresolved_rows_preserve_valid_diagnostics_but_never_publish():
    old = run()
    d = delivery(held_rows=[dict(tic_id="123", external_id="unknown", reason="unverified_time_standard")])
    assert d["status"] == "ready"  # The snapshot preserves both kinds of rows.
    result = run({"toi": d}, previous=old)
    assert result["status"] == "hold"
    assert result["joins"]["toi"]["rows"][0]["status"] == "direct_match"
    assert result["retained_previous"] == old
    assert not result["rows"] and not result["reference_changes"]


def test_held_row_hash_and_duplicate_detection():
    held = [dict(tic_id="123", external_id="held", reason="unverified_time_standard")]
    d = delivery(held_rows=held)
    d["snapshot"]["held_rows"][0]["reason"] = "changed"
    with pytest.raises(ValueError, match="integrity"):
        run({"toi": d})
    held[0]["external_id"] = "1.01"
    assert delivery(held_rows=held)["reasons"] == ["duplicate_external_key"]


def test_external_reference_disappearance_and_history_provenance():
    old = run()
    result = run({"toi": delivery([], raw_sha256="b"*64)}, previous=old)
    assert result["reference_changes"][0]["action"] == "remove"
    assert result["reference_changes"][0]["after"] is None
    assert result["history"][0]["source_refs"]["absence_evidence"]


def test_changed_source_policy_requires_review():
    old = run()
    result = run({"toi": delivery(), "archive": delivery(source="archive")},
                 sources=["toi", "archive"], previous=old)
    assert result["status"] == "hold" and result["reasons"] == ["changed_source_policy"]


@pytest.mark.parametrize("timestamp", [None, "2026-09-22", "2026-09-22T00:00:00+09:00", "bad"])
def test_bad_retrieval_timestamp_holds(timestamp):
    assert delivery(retrieved_at=timestamp)["status"] == "hold"


def test_previous_snapshot_tamper_rejected():
    old = run()
    old["snapshots"]["toi"]["rows"][0]["raw_disposition"] = "FP"
    with pytest.raises(ValueError, match="integrity"):
        run(previous=old)


def test_missing_csv_tic_is_held():
    result = normalize_export_row("nea_toi", {"tid": None, "toi": "1.01"})
    assert result["status"] == "hold" and result["reason"]
    assert result["row"] is None and result["tic_id"] is None


def test_empty_transit_union_is_not_direct_even_with_zero_minimum(monkeypatch):
    from astro_kernel import external_catalog as mod
    monkeypatch.setitem(mod.RULE, "min_shared_points", 0)
    result = join_catalog(catalog(), {"toi": delivery()}, np.array([0., 2., 4.]),
                          required_sources=["toi"], approval="fixture-only")
    evidence = result["joins"]["toi"]["evidence"][0]
    assert evidence["observed_jaccard"] is None
    assert not evidence["direct_edge"]


def test_partial_source_failure_retains_diagnostic_references_only():
    result = run({"toi": delivery(), "archive": delivery(source="archive", complete=False)},
                 sources=["toi", "archive"])
    assert result["status"] == "hold" and not result["publishable"]
    assert len(result["external_references"]) == 1
    assert result["rows"] == result["reference_changes"] == []
