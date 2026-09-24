from copy import deepcopy

import numpy as np
import pytest

from gold_roundtrip.serialization import assemble


def inputs():
    model = dict(candidate_id="c-991", shape="box", baseline={"kind": "unity"},
                 residual_model_version="box-divide-v0",
                 parameters=dict(period_days=2., epoch_btjd=1., duration_hours=2., depth_ppm=1000.))
    c = dict(candidate_id=991, tic_id=123, updated_bundle_id=20, status="active", removal_step=0,
             **model["parameters"], bls_power=12., transit_model=model, discoverable=True)
    segment = dict(tic_id=123, sector=1, binning_revision="bin-v1-fixture", start_btjd=0.,
                   bin_minutes=10., n_points=3, flux=[1., None, .999], flux_scatter=.01,
                   gaps=[[1, 1]], diagnostics=dict(counts=[5, 0, 5]))
    row = dict(candidate_id=991, disposition="confirmed", planet_truth="planet", answer_class="graded",
               is_confirmed=True, rule_version="external-v1", source_refs={"refs": ["fixture"]},
               representative_model={k: c[k] for k in ("period_days", "epoch_btjd", "duration_hours")})
    versions = dict(preprocessing="pre-v1", bls_config="search-v1", residual_model="box-divide-v0",
                    periodogram_config="provided-v1", candidate_quality="quality-v1",
                    ai_model="fixture-policy-only", ai_threshold="fixture-policy-only", external_matching="ext-v1")
    return dict(catalog=dict(tic_id=123, bundle_id=20, catalog_ready=True, complete=True, candidates=[c]),
                segmented=dict(segments=[segment, dict(segment, sector=2, start_btjd=2.)], quarantined=[]),
                discovery=dict(status="ready", discoverability_ready=True, tic_id=123, bundle_id=20,
                               candidate_quality_revision="quality-v1", proposed_candidates=[deepcopy(c)]),
                external=dict(status="ready", tic_id="123", bundle_id=20, rows=[row],
                              matching_rule_version="ext-v1", external_references=[]),
                periodogram=dict(candidate_id=None, periods=np.geomspace(.5, 40., 5000).tolist(), power=[1.] * 5000),
                segment_ids={"1": 5, "2": 9}, input_snapshot_ids=["fixture:sha256:" + "a" * 64],
                calculation_versions=versions, fold_reference_time_btjd=1., base_days=3.,
                ai_policy=dict(status="policy_not_executed", decision_reference="synthetic-policy-test",
                               model_version="fixture-policy-only", threshold_version="fixture-policy-only"),
                fine_tune=dict(half_width_cells=3))


def test_multiple_segments_and_ids_preserved_without_diagnostics_or_ai_execution():
    data = inputs()
    before = deepcopy(data)
    result = assemble(**data)
    assert result["status"] == "validated", result
    assert data == before and result["publishable"] is False
    p = result["payload"]
    assert [s["id"] for s in p["segments"]] == [5, 9]
    assert p["candidates"][0]["id"] == 991
    assert p["segments"][0]["flux"][1] is None
    assert "diagnostics" not in p["segments"][0]
    assert "applied_at" not in p["candidate_dispositions"][0]
    assert p["ai_results"] == [] and "ai_executions" not in p
    assert set(p["bundle"]["manifest"]["array_checksums"]) == {
        "segment:5:flux", "segment:9:flux", "periodogram:20:power"}


@pytest.mark.parametrize("path,value", [
    (("catalog", "catalog_ready"), False),
    (("discovery", "status"), "held"),
    (("external", "status"), "hold"),
    (("external", "rows"), []),
    (("external", "bundle_id"), 21),
    (("segmented", "quarantined"), [dict(sector=3)]),
    (("segmented", "segments", 0, "gaps"), []),
    (("segmented", "segments", 0, "flux", 0), float("nan")),
    (("segmented", "segments", 0, "n_points"), 20001),
    (("segment_ids", "2"), 5),
    (("periodogram", "candidate_id"), 991),
    (("periodogram", "power", 0), None),
    (("periodogram", "periods", 100), 1.),
    (("external", "rows", 0, "planet_truth"), "not_planet"),
    (("external", "rows", 0, "representative_model", "period_days"), 3.),
    (("discovery", "proposed_candidates", 0, "discoverable"), None),
    (("calculation_versions", "candidate_quality"), "wrong"),
    (("ai_policy", "status"), "inference_failed"),
    (("ai_policy", "decision_reference"), ""),
])
def test_invalid_proposals_are_rejected_atomically(path, value):
    data = inputs()
    parent = data
    for part in path[:-1]:
        parent = parent[part]
    parent[path[-1]] = value
    result = assemble(**data)
    assert result["decision"] == "PUBLISH_REJECTED"
    assert result["payload"] is None and not result["publishable"]


def test_input_order_does_not_change_payload():
    data = inputs()
    first = assemble(**data)
    data["segmented"]["segments"].reverse()
    assert assemble(**data) == first


def test_missing_required_version_rejected():
    data = inputs()
    del data["calculation_versions"]["ai_model"]
    assert assemble(**data)["reason"] == "missing_calculation_versions"


def test_reference_projection_keeps_binding_but_not_diagnostics():
    data = inputs()
    data["external"]["external_references"] = [dict(candidate_id=991, tic_id=123,
        source="fixture", external_id="one", disposition="CP", period_days=2., epoch_btjd=1.,
        fetched_on="2026-09-24", match_status="direct_match", internal_note="diagnostic")]
    result = assemble(**data)
    assert result["status"] == "validated", result
    ref = result["payload"]["external_statuses"][0]
    assert ref["candidate_id"] == 991
    assert ref["candidate_key"] == dict(period_days=2., epoch_btjd=1.)
    assert "internal_note" not in ref and "match_status" not in ref


def test_duplicate_candidate_ids_rejected():
    data = inputs()
    data["catalog"]["candidates"] *= 2
    assert assemble(**data)["reason"] == "candidate_set_mismatch"


def with_retired():
    data = inputs()
    retired = deepcopy(data["catalog"]["candidates"][0])
    retired.update(candidate_id=15, status="retired", updated_bundle_id=19, is_confirmed=False)
    retired["transit_model"]["candidate_id"] = "c-15"
    alias = dict(candidate_id=15, multiplier=2., alias_period_days=4.)
    data["catalog"]["candidates"].append(deepcopy(retired))
    data["catalog"]["candidate_aliases"] = [alias]
    data["discovery"]["proposed_candidates"].append(deepcopy(retired))
    data["previous_bundle"] = dict(complete=True, tic_id=123, bundle_id=19,
                                   candidates=[retired], candidate_aliases=[deepcopy(alias)])
    return data


def test_retired_identity_model_labels_and_aliases_preserved():
    data = with_retired()
    before = deepcopy(data)
    r = assemble(**data)
    assert r["status"] == "validated", r
    assert data == before
    p = r["payload"]
    retired = next(c for c in p["candidates"] if c["id"] == 15)
    assert retired["status"] == "retired" and retired["is_confirmed"] is False
    assert retired["updated_bundle_id"] == 19
    assert p["retain_disposition_candidate_ids"] == [15]
    assert [d["candidate_id"] for d in p["candidate_dispositions"]] == [991]
    assert p["candidate_aliases"] == data["previous_bundle"]["candidate_aliases"]


@pytest.mark.parametrize("kind", ["no_previous", "alias_changed", "retired_changed", "dropped"])
def test_lifecycle_damage_rejected(kind):
    data = with_retired()
    if kind == "no_previous":
        del data["previous_bundle"]
    elif kind == "alias_changed":
        data["catalog"]["candidate_aliases"][0]["multiplier"] = 3.
    elif kind == "retired_changed":
        data["discovery"]["proposed_candidates"][1]["discoverable"] = False
    else:
        data["catalog"]["candidates"].pop()
        data["discovery"]["proposed_candidates"].pop()
    assert assemble(**data)["status"] == "rejected"


def test_history_kept_without_timestamp_and_forged_value_rejected():
    data = inputs()
    h = dict(candidate_id=991, bundle_id=20, field="disposition", old_value=None,
             new_value="confirmed", rule_version="external-v1", reason="disposition_updated:fixture")
    data["external"]["history"] = [h]
    result = assemble(**data)
    assert result["payload"]["history_proposals"] == [h]
    assert "changed_at" not in result["payload"]["history_proposals"][0]
    h["new_value"] = "fp"
    assert assemble(**data)["reason"] == "history_value_mismatch"
