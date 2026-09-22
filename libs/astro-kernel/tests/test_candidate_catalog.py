"""Identity proposals preserve history and never manufacture database IDs."""
from copy import deepcopy
import json

import pytest

from astro_kernel import candidate_catalog as cc
from astro_kernel.iteration import ITERATION_VERSION
from astro_kernel.transit_model import parse_transit_model


def candidate(key="a", period=2., step=0):
    return dict(peak_id=key, step=step, period_days=period, epoch_btjd=.5,
                duration_hours=2., depth_ppm=1000., snr=10., sde=8., bls_power=100.,
                n_transits=10, original_snr=10., validated_on_original=True)


def iteration(peaks=None, **overrides):
    return dict(dict(iteration_version=ITERATION_VERSION, complete=True, status="ok",
                     termination="no_quality_peak", time_start_btjd=0., time_end_btjd=30.,
                     accepted=[candidate()] if peaks is None else peaks,
                     input_snapshot_id="snapshot",preprocessing_version="silver-v1",
                     iteration_config_sha256="config-fingerprint",qa_failed_step=-1), **overrides)


def previous(candidates=None, **overrides):
    old=dict(candidate(),candidate_id=11,status="active",discoverable=True,removal_step=0)
    return dict(dict(tic_id=123,bundle_id=101,complete=True,time_start_btjd=0.,time_end_btjd=20.,
                     candidates=[old] if candidates is None else candidates,candidate_aliases=[]), **overrides)


def build(run=None, old=None, **overrides):
    kw=dict(tic_id=123,bundle_id=102,identity_approval="review-112-approved")
    kw.update(overrides)
    return cc.build_candidate_catalog(iteration() if run is None else run,old,**kw)


def test_external_ids_required_and_approval_separate():
    result=build(identity_approval=None)
    assert result["needed_new_peak_ids"] == ["a"]
    assert result["lifecycle_actions"] == []
    assert not result["catalog_ready"] and not result["publishable"]
    result=build(new_candidate_ids={"a":20},identity_approval=None)
    assert result["proposed_candidates"][0]["candidate_id"] == 20
    assert result["candidates"] == []
    assert result["reasons"] == ["identity_approval_required"]


def test_new_candidate_ready_has_schema_model_and_no_discoverability():
    result=build(new_candidate_ids={"a":20})
    assert result["catalog_ready"] and result["status"] == "ready"
    assert result["publishable"] is False
    row=result["candidates"][0]
    assert row["tic_id"] == 123 and row["updated_bundle_id"] == 102
    assert row["removal_step"] == 0 and row["bls_power"] == 100.
    assert "discoverable" not in row
    assert parse_transit_model(row["transit_model"]).candidate_id == "c-20"
    json.dumps(result,allow_nan=False)


def test_keep_updates_removal_step_without_mutating_previous():
    old=previous(candidate_aliases=[dict(candidate_id=11,alias_period_days=4.)])
    snapshot=deepcopy(old)
    run=iteration([candidate(step=3)])
    result=build(run,old)
    assert result["catalog_ready"]
    row=result["candidates"][0]
    assert row["candidate_id"] == 11 and row["removal_step"] == 3
    assert row["updated_bundle_id"] == 102 and "discoverable" not in row
    assert result["candidate_aliases"] == old["candidate_aliases"]
    assert old == snapshot
    assert result == build(run,old)


def test_retired_history_and_prior_alias_preserved():
    old=previous([dict(candidate(),candidate_id=11,status="active"),
                  dict(candidate("past",17.31),candidate_id=7,status="retired",updated_bundle_id=99,discoverable=False)])
    result=build(iteration([candidate("new",3.1)]),old,new_candidate_ids={"new":21})
    rows={c["candidate_id"]:c for c in result["candidates"]}
    assert rows[7] == old["candidates"][1]
    assert rows[11]["status"] == "retired" and rows[11]["period_days"] == 2.
    assert rows[11]["updated_bundle_id"] == 102
    assert rows[21]["status"] == "active"


def test_retired_reappearance_is_held():
    old=previous([dict(candidate(),candidate_id=11,status="retired")])
    result=build(old=old)
    assert result["reasons"] == ["retired_identity_review_required"]
    assert result["lifecycle_actions"] == []


@pytest.mark.parametrize("reason",["removal_qa_failed","max_iterations_reached","numerical_failure","candidate_validation_failed"])
def test_incomplete_cannot_retire(reason):
    result=build(iteration([],complete=False,status="failed",termination=reason),previous())
    assert result["lifecycle_actions"] == [] and result["identity_proposal"] is None
    assert result["candidates"] == previous()["candidates"]


def test_complete_empty_holds_retirement_proposal():
    result=build(iteration([]),previous())
    assert result["identity_proposal"]["retired_candidate_ids"] == [11]
    assert result["reasons"] == ["no_candidates_publication_held"]
    assert result["lifecycle_actions"] == []


def test_failed_original_validation_held():
    result=build(iteration([dict(candidate(),validated_on_original=False)]),previous())
    assert result["reasons"] == ["original_validation_failed"]
    assert result["lifecycle_actions"] == []


def test_exact_copies_group_before_ids_preserving_raw_peaks():
    a,b=candidate("a"),dict(candidate("b"),epoch_btjd=2.5)
    result=build(iteration([b,a]),new_candidate_ids={"a":20})
    assert len(result["raw_peaks"]) == 2 and len(result["candidates"]) == 1
    assert result["candidate_aliases"] == []
    assert len(result["exact_model_groups"][0]["duplicates"]) == 1


@pytest.mark.parametrize("second",[dict(candidate("b"),epoch_btjd=.501),candidate("b",4.)])
def test_near_or_harmonic_peaks_are_not_merged(second):
    result=build(iteration([candidate(),second]))
    assert result["reasons"] == ["within_bundle_identity_ambiguous"]
    assert result["lifecycle_actions"] == []
    assert result["candidate_aliases"] == [] and result["pair_evidence"]


def test_cross_bundle_possible_alias_held():
    result=build(iteration([candidate("b",4.)]),previous())
    assert result["reasons"] == ["possible_alias"]
    assert result["identity_proposal"] is None


def test_candidate_order_does_not_change_ids():
    a,b=candidate("a"),candidate("b",3.1,1)
    ids={"a":20,"b":21}
    first=build(iteration([a,b]),new_candidate_ids=ids)
    second=build(iteration([b,a]),new_candidate_ids=ids)
    assert first["candidates"] == second["candidates"]
    assert first["lifecycle_actions"] == second["lifecycle_actions"]


@pytest.mark.parametrize("ids",[{"a":True},{"a":0},{"a":2**63},{"a":1.2},{"a":11},{"wrong":20},{"a":20,"b":20}])
def test_bad_allocations_rejected(ids):
    old=previous([dict(candidate("past",17.31),candidate_id=11,status="retired")])
    with pytest.raises(ValueError): build(old=old,new_candidate_ids=ids)


@pytest.mark.parametrize("override",[dict(tic_id=999),dict(complete=False),dict(bundle_id=102),dict(time_end_btjd=0.)])
def test_previous_contract_rejected(override):
    with pytest.raises(ValueError): build(old=previous(**override))


def test_model_parameters_must_match_candidate():
    c=candidate()
    c["transit_model"]=dict(shape="box",parameters=dict(period_days=3.,epoch_btjd=.5,duration_hours=2.,depth_ppm=1000.))
    with pytest.raises(ValueError): build(iteration([c]))


def test_inconsistent_completion_rejected():
    with pytest.raises(ValueError): build(iteration(qa_failed_step=0))
    with pytest.raises(ValueError): build(iteration(status="failed"))
    with pytest.raises(ValueError): build(iteration(termination="max_iterations_reached"))


def test_schema_accepts_all_ready_models():
    from pathlib import Path
    from jsonschema import Draft202012Validator
    schema=json.loads((Path(__file__).resolve().parents[3]/"contracts/gold/transit-model.schema.json").read_text(encoding="utf-8"))
    for row in build(new_candidate_ids={"a":20})["candidates"]:
        Draft202012Validator(schema).validate(row["transit_model"])


def test_identity_epoch_boundary_and_symmetry():
    a=candidate()
    assert cc.distance(a,dict(a,epoch_btjd=20.5),0.,30.) == 0
    b=dict(a,epoch_btjd=.5+1/24)
    assert cc.distance(a,b,0.,30.) == pytest.approx(.5)
    assert cc.distance(a,b,0.,30.) == cc.distance(b,a,0.,30.)
    assert cc.possible_multipliers(a,candidate("b",4.),0.,30.,.5)
    assert not cc.reconcile([dict(a,candidate_id=11)],[candidate("b",4.)],0.,30.,tolerance=.5,new_complete=True)["publishable"]


@pytest.mark.parametrize("bad",[None,float("nan"),True])
def test_missing_or_bad_bls_power_rejected(bad):
    c=candidate()
    if bad is None: c.pop("bls_power")
    else: c["bls_power"]=bad
    with pytest.raises(ValueError): build(iteration([c]),new_candidate_ids={"a":20})


@pytest.mark.parametrize("value",[True,0,-1,"new",2**63])
def test_invalid_bundle_ids(value):
    with pytest.raises(ValueError): build(bundle_id=value)
    with pytest.raises(ValueError): build(old=previous(bundle_id=value))


def test_numeric_string_bundle_ids_are_normalized():
    result=build(new_candidate_ids={"a":20},bundle_id="102")
    assert result["bundle_id"] == 102
    assert result["candidates"][0]["updated_bundle_id"] == 102
