import numpy as np
import pytest
from tess_bench.tutorial_labels import link, secondary_cycles, diagnostic_link, dv_reference


def test_matching_period_does_not_override_unknown_time():
    c=dict(period_days=2.,epoch_btjd=0.,duration_hours=2.)
    assert link(c,c,np.arange(0,5,.01))['status']=='hold'
    assert link(c,dict(c,time_system='BTJD-TDB'),np.arange(0,5,.01))['status']=='pairwise_direct'


def test_secondary_preserves_missing_cycle_and_depth():
    t=np.array([.8,1.,1.2,2.8,3.,3.2])
    r=secondary_cycles(t,np.array([1.,.99,1.,1.,np.nan,1.]),dict(period_days=2.,epoch_btjd=0.,duration_hours=4.))
    assert np.isclose(r[0]['depth_ppm'],10000.)
    assert r[1]['depth_ppm'] is None


def test_conditional_agreement_cannot_clear_time_hold():
    c=dict(period_days=2.,epoch_btjd=0.,duration_hours=2.)
    r=diagnostic_link(c,c,np.arange(0,5,.01))
    assert r['formal']['status']=='hold'
    assert r['conditional_metrics']['observed_jaccard']==1


def test_secondary_and_half_period_do_not_become_direct():
    c=dict(period_days=2.,epoch_btjd=0.,duration_hours=2.)
    t=np.arange(0,20,.01)
    assert link(c,dict(c,epoch_btjd=1.,time_system='BTJD-TDB'),t)['status']=='not_direct'
    assert link(c,dict(c,period_days=1.,time_system='BTJD-TDB'),t)['status']=='not_direct'


def test_dv_reference_requires_target_real_data_and_converged_fit(tmp_path):
    xml='''<dv:dvTargetResults xmlns:dv="http://www.nasa.gov/2018/TESS/DV" ticId="123" simData="false">
    <dv:planetResults planetNumber="1"><dv:allTransitsFit fullConvergence="true"><dv:modelParameters>
    <dv:modelParameter name="orbitalPeriodDays" value="2"/>
    <dv:modelParameter name="transitEpochBtjd" value="1300"/>
    <dv:modelParameter name="transitDurationHours" value="3"/>
    </dv:modelParameters></dv:allTransitsFit></dv:planetResults></dv:dvTargetResults>'''
    path=tmp_path/'reference.xml'; path.write_text(xml)
    assert dv_reference(path,123,1)['epoch_btjd']==1300
    with pytest.raises(ValueError): dv_reference(path,124,1)
    with pytest.raises(ValueError): dv_reference(path,123,2)
    for altered in [xml.replace('simData="false"','simData="true"'),xml.replace('fullConvergence="true"','fullConvergence="false"')]:
        path.write_text(altered)
        with pytest.raises(ValueError): dv_reference(path,123,1)
