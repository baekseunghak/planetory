import pytest
import numpy as np
from tess_bench.candidate_identity import distance, reconcile, window_evidence, review_candidates


def candidate(period=4., epoch=0., identity="a"):
    return dict(period_days=period, epoch_btjd=epoch, duration_hours=3., candidate_id=identity)


def test_epoch_cycles_and_half_duration_boundary():
    a=candidate()
    assert distance(a,candidate(epoch=400),0,20)==0
    assert distance(a,candidate(epoch=.0625),0,20)==.5
    assert reconcile([a],[candidate(epoch=.0625)],0,20,tolerance=.5, new_complete=True)["matches"]
    assert not reconcile([a],[candidate(epoch=.06250001)],0,20,tolerance=.5, new_complete=True)["matches"]


def test_alias_requires_review_instead_of_retiring_identity():
    result=reconcile([candidate()],[candidate(period=8)],0,40,tolerance=.5, new_complete=True)
    assert result["matches"]==[]
    assert result["status"]=="possible_alias" and not result["publishable"]
    assert result["added"]==result["retired"]==[]


def test_unrelated_signal_add_and_retire():
    result=reconcile([candidate()],[candidate(period=7,epoch=1)],0,40,tolerance=.5, new_complete=True)
    assert result["added"]==[0] and result["retired"]==["a"]


def test_ties_block_all_lifecycle_changes():
    result=reconcile([candidate()],[candidate(),candidate(epoch=.001)],0,20,tolerance=.5, new_complete=True)
    assert not result["publishable"]
    assert result["added"]==result["retired"]==result["matches"]==[]


def test_close_two_to_one_and_invalid_input():
    assert reconcile([candidate(identity="a"),candidate(identity="b")],[candidate()],0,20,tolerance=.5, new_complete=True)["status"]=="ambiguous"
    with pytest.raises(ValueError):distance(candidate(),candidate(period=0),0,20)
    with pytest.raises(ValueError):distance(candidate(),candidate(),20,0)
    with pytest.raises(ValueError):reconcile([candidate(),candidate()],[],0,20,tolerance=.5, new_complete=True)


def test_alias_of_matched_candidate_is_not_silently_added():
    result = reconcile([candidate()], [candidate(), candidate(period=8)], 0, 40, tolerance=.5, new_complete=True)
    assert result["status"] == "possible_alias"
    assert result["added"] == result["retired"] == []


def test_conditional_depth_separates_strong_resonance_from_alias():
    t = np.arange(0, 40, 1/720)
    a, b = candidate(), candidate(period=8)
    ma = np.minimum(t % 4, 4-t % 4) < 3/48
    mb = np.minimum(t % 8, 8-t % 8) < 3/48
    noise = np.random.default_rng(42).normal(0,.0002,len(t))
    one = window_evidence(t,1-.002*ma+noise,a,b)
    two = window_evidence(t,1-.002*ma-.001*mb+noise,a,b)
    assert one["conditional_snr"][1] < 3
    assert min(two["conditional_snr"]) > 7
    assert not one["auto_merge"] and not two["auto_merge"]


def test_missing_exclusive_windows_is_unidentifiable_not_alias():
    t = np.arange(0,40,1/720)
    ma = np.minimum(t % 4,4-t % 4) < 3/48
    mb = np.minimum(t % 8,8-t % 8) < 3/48
    flux = 1-.002*ma-.001*mb+np.random.default_rng(9).normal(0,.0002,len(t))
    flux[ma != mb] = np.nan
    result = window_evidence(t,flux,candidate(),candidate(period=8))
    assert result["status"] == "unidentifiable"
    assert not result["auto_merge"]


def test_identical_template_and_all_missing_are_not_measurable():
    t = np.arange(0.,40.,.01)
    f = 1+np.random.default_rng(0).normal(0,.001,len(t))
    assert window_evidence(t,f,candidate(),candidate())["status"] == "unidentifiable"
    f[:] = np.nan
    assert window_evidence(t,f,candidate(),candidate())["status"] == "not_measurable"
    with pytest.raises(ValueError):window_evidence(t,f[:-1],candidate(),candidate())


def test_failed_bundle_cannot_retire_all_candidates():
    result = reconcile([candidate()], [], 0, 40, tolerance=.5, new_complete=False)
    assert result["status"] == "incomplete"
    assert result["retired"] == [] and not result["publishable"]
    good = reconcile([candidate()], [], 0, 40, tolerance=.5, new_complete=True)
    assert good["retired"] == ["a"]


def test_invalid_candidate_is_rejected_even_without_opposite_rows():
    with pytest.raises(ValueError):
        reconcile([], [candidate(period=0)], 0, 40, tolerance=.5, new_complete=True)


def test_half_alias_epoch_can_pick_the_other_transit():
    result = reconcile([candidate(period=8)], [candidate(period=4,epoch=4)],
                       0,40,tolerance=.5,new_complete=True)
    assert result["status"] == "possible_alias"


def test_real_bundle_qa_failure_preserves_identity():
    from tess_bench.candidate_bundle_regression import compare_bundles
    a = dict(tic_id=1,start_btjd=0,end_btjd=40,termination="no_quality_peak",qa_failed_step=-1,
             candidates=[dict(candidate(),validated_on_original=True)])
    b = dict(a, candidates=[],termination="removal_qa_failed",qa_failed_step=0)
    result = compare_bundles(a,b)
    assert not result["new_complete"]
    assert all(r["status"]=="incomplete" and not r["retired"] for r in result["sweep"].values())
    with pytest.raises(ValueError):compare_bundles(a,dict(b,tic_id=2))
    reversed_result = compare_bundles(b,a)
    assert not reversed_result["comparison_complete"]
    assert all(not r["publishable"] for r in reversed_result["sweep"].values())


def test_ratio_expansion_can_block_two_distinct_injections():
    from types import SimpleNamespace
    from tess_bench.iterate import is_duplicate
    from tess_bench.candidate_ratio_sweep import SETS
    prior = [SimpleNamespace(step=0,period_days=3.,duration_hours=2.)]
    assert is_duplicate(7.,2/24,10,prior,SETS["base"]) == -1
    assert is_duplicate(7.,2/24,10,prior,SETS["integer_3_4"]) == -1
    assert is_duplicate(7.,2/24,10,prior,SETS["rational_to_9"]) == 0


@pytest.mark.parametrize("period", [4/3,1.,12.,16.])
def test_extended_harmonics_are_review_flags_not_new_ids(period):
    result = reconcile([candidate()], [candidate(period=period)], 0,80,tolerance=.5,new_complete=True)
    assert result["status"] == "possible_alias" and not result["publishable"]
    assert result["matches"] == result["added"] == result["retired"] == []


def test_swapping_bundles_cannot_change_boundary_decision():
    a, b = candidate(period=4.006), candidate()
    # v1 returned 0.528 in one direction but 0.480 in the other.
    assert distance(a,b,0,40) == distance(b,a,0,40)
    assert distance(a,b,0,40) > .5
    for old,new in ((a,b),(b,a)):
        assert not reconcile([old],[new],0,40,tolerance=.5,new_complete=True)["matches"]


@pytest.mark.parametrize("duration", [float("nan"),float("inf"),100.])
def test_each_duration_is_validated_in_both_orders(duration):
    a, b = candidate(), dict(candidate(),duration_hours=duration)
    for x,y in ((a,b),(b,a)):
        with pytest.raises(ValueError): distance(x,y,0,40)


def peak(identity, period=4., epoch=0., original_snr=10.):
    return dict(candidate(period,epoch),peak_id=identity,
                validated_on_original=True,original_snr=original_snr)


def test_review_preserves_aliases_and_does_not_call_display_choice_physical():
    rows=[peak("short"),peak("long",period=8.,original_snr=20.)]
    r=review_candidates(rows,0,40,tolerance=.5,complete=True)
    assert r["raw_peaks"]==rows and r["display_representative"]=="long"
    assert r["status"]=="review_required" and not r["automatic_merge"]
    assert not r["physical_representative_confirmed"]
    assert r["pair_evidence"][0]["relation"]=="possible_alias"
    assert not r["pair_evidence"][0]["confirmed_alias"]
    reverse=review_candidates(rows[::-1],0,40,tolerance=.5,complete=True)
    assert reverse["pair_evidence"]==r["pair_evidence"]
    assert reverse["display_representative"]==r["display_representative"]


def test_pairwise_close_chain_is_not_collapsed_into_one_signal():
    rows=[peak("a"),peak("b",epoch=.05),peak("c",epoch=.1)]
    r=review_candidates(rows,0,40,tolerance=.5,complete=True)
    assert {(p["peak_a"],p["peak_b"]) for p in r["pair_evidence"]}=={("a","b"),("b","c")}
    assert len(r["raw_peaks"])==3 and not r["automatic_merge"]
    assert r["representative_tie"]


def test_review_invalid_evidence_and_incomplete_bundle():
    rows=[peak("a",original_snr=float("nan")),peak("b",period=7.)]
    r=review_candidates(rows,0,40,tolerance=.5,complete=False)
    assert r["review_order"]==["b"] and r["status"]=="incomplete"
    rows[1]["validated_on_original"]=False
    r=review_candidates(rows,0,40,tolerance=.5,complete=True)
    assert r["display_representative"] is None and r["status"]=="incomplete"
    with pytest.raises(ValueError):
        review_candidates([peak("a"),peak("a")],0,40,tolerance=.5,complete=True)


def test_existing_cross_bundle_matches_do_not_bypass_within_bundle_aliases():
    from tess_bench.candidate_bundle_regression import compare_bundles
    record=dict(tic_id=1,start_btjd=0,end_btjd=40,termination="no_quality_peak",
                qa_failed_step=-1,candidates=[peak("a"),peak("b",period=8.)])
    result=compare_bundles(record,record)
    assert result["comparison_complete"] and not result["identity_ready"]
    assert all(not r["publishable"] and not r["retired"] for r in result["sweep"].values())
    assert all(r["status"]=="within_bundle_ambiguous" for r in result["sweep"].values())


def test_two_bundles_keep_add_and_retire_together():
    old=[candidate(identity="keep"),candidate(period=7.,identity="retire")]
    new=[candidate(epoch=.01),candidate(period=11.,epoch=1.)]
    result=reconcile(old,new,0,40,tolerance=.5,new_complete=True)
    assert result["matches"]==[dict(candidate_id="keep",new_index=0)]
    assert result["added"]==[1] and result["retired"]==["retire"]
    # A failed rerun cannot apply even the otherwise unambiguous changes.
    failed=reconcile(old,new,0,40,tolerance=.5,new_complete=False)
    assert failed["matches"]==failed["added"]==failed["retired"]==[]


def equivalence_fixture(depth_ppm=0., noise_ppm=.1):
    from astro_kernel.transit_model import phase_distance_days
    t=np.arange(0,80,1/720)
    a=dict(peak("a",epoch=1),depth_ppm=2000.)
    b=dict(peak("b",period=8,epoch=1),depth_ppm=2000.)
    ma=np.abs(phase_distance_days(t,4,1))<3/48
    mb=np.abs(phase_distance_days(t,8,1))<3/48
    f=(1-.002*ma)*(1-depth_ppm*1e-6*mb)+np.random.default_rng(312).normal(0,noise_ppm*1e-6,len(t))
    return t,f,a,b


def test_equivalent_pair_keeps_raw_alias_and_short_photometric_period():
    from tess_bench.candidate_identity import merge_harmonic_pair
    t,f,a,b=equivalence_fixture()
    r=merge_harmonic_pair(t,f,a,b,margin_ppm=.25)
    assert r["evidence"]["automatic_merge"]
    assert not r["evidence"]["physical_period_confirmed"]
    assert r["representative"]==a and r["aliases"]==[b] and r["raw_peaks"]==[a,b]
    reverse=merge_harmonic_pair(t,f,b,a,margin_ppm=.25)
    assert reverse["representative"]==a and reverse["aliases"]==[b]


@pytest.mark.parametrize("depth,noise", [(2.,.1),(2.,200.),(1000.,200.),(0.,200.)])
def test_distinct_or_uncertain_pair_is_never_merged(depth,noise):
    from tess_bench.candidate_identity import merge_harmonic_pair
    r=merge_harmonic_pair(*equivalence_fixture(depth,noise),margin_ppm=.25)
    assert not r["evidence"]["automatic_merge"]
    assert r["representative"] is None and r["aliases"]==[]
    assert r["unresolved_peak_ids"]==["a","b"]


def test_submargin_signal_is_an_explicit_limit_not_physical_identity():
    from tess_bench.candidate_identity import harmonic_equivalence
    r=harmonic_equivalence(*equivalence_fixture(.05),margin_ppm=.25)
    assert r["automatic_merge"] and not r["physical_period_confirmed"]


def test_equivalence_missing_whole_block_and_bad_models():
    from tess_bench.candidate_identity import harmonic_equivalence
    t,f,a,b=equivalence_fixture()
    f[(t>=15)&(t<23)]=np.nan
    r=harmonic_equivalence(t,f,a,b,margin_ppm=.25)
    assert r["reason"]=="missing_distinguishing_windows"
    with pytest.raises(ValueError): harmonic_equivalence(t,f,a,b,margin_ppm=float("nan"))
    assert not harmonic_equivalence(t,f,a,dict(b,validated_on_original=False),margin_ppm=.25)["automatic_merge"]
    assert not harmonic_equivalence(t,f,a,dict(b,depth_ppm=float("nan")),margin_ppm=.25)["automatic_merge"]
    t,f,a,b=equivalence_fixture()
    assert harmonic_equivalence(t,f,a,dict(b,depth_ppm=3000),margin_ppm=.25)["reason"]=="stored_depth_not_equivalent"
    assert harmonic_equivalence(t,f,a,dict(b,duration_hours=2.9),margin_ppm=.25)["reason"]=="different_duration_models"


def test_merged_representatives_keep_id_across_two_bundles():
    from tess_bench.candidate_identity import merge_harmonic_pair
    t,f,a,b=equivalence_fixture()
    first=merge_harmonic_pair(t,f,a,b,margin_ppm=.25)
    second=merge_harmonic_pair(t,f,dict(b,epoch_btjd=b["epoch_btjd"]+8),
                               dict(a,epoch_btjd=a["epoch_btjd"]+4),margin_ppm=.25)
    assert first["representative"] is not None and second["representative"] is not None
    result=reconcile([dict(first["representative"],candidate_id="persistent-id")],
                     [second["representative"]],float(t[0]),float(t[-1]),tolerance=.5,new_complete=True)
    assert result["matches"]==[dict(candidate_id="persistent-id",new_index=0)]
    assert result["added"]==result["retired"]==[]


def test_exact_copies_group_before_ids_but_nearby_models_do_not():
    from tess_bench.candidate_identity import group_exact_models
    a=dict(peak("a",epoch=1),depth_ppm=2000.)
    a.pop("candidate_id")
    b=dict(a,peak_id="b",epoch_btjd=401.)
    c=dict(a,peak_id="c",depth_ppm=2000.001)
    r=group_exact_models([c,b,a],0,80,complete=True)
    assert len(r["groups"])==2 and len(r["raw_peaks"])==3
    assert r["groups"][0]["representative"]==a and r["groups"][0]["duplicates"]==[b]
    assert group_exact_models([a],0,80,complete=False)["groups"]==[]
    with pytest.raises(ValueError):
        group_exact_models([dict(a,candidate_id="already-published")],0,80,complete=True)


def test_exact_grouping_does_not_merge_gap_induced_harmonic_coincidence():
    from tess_bench.candidate_identity import group_exact_models
    a=dict(period_days=4.,epoch_btjd=1.,duration_hours=3.,depth_ppm=2000.,
           validated_on_original=True,peak_id="a")
    assert len(group_exact_models([a,dict(a,period_days=8.,peak_id="b")],0,80,complete=True)["groups"])==2
