import pytest
import numpy as np
from tess_bench.candidate_identity import distance, reconcile, window_evidence


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
