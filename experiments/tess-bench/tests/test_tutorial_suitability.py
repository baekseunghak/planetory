import numpy as np
from tess_bench.tutorial_suitability import window_stats


def test_secondary_and_missing_samples_remain_distinct():
    t=np.array([0.,.3,1.,1.3,2.,2.3,3.,3.3])
    f=np.array([.9,1.,.97,1.,.9,1.,np.nan,1.])
    c=dict(period_days=2.,epoch_btjd=0.,duration_hours=1.)
    r=window_stats(t,f,c)
    assert r['primary_points']==2 and r['secondary_points']==1
    assert np.isclose(r['secondary_depth_ppm'],30000)
    assert np.isclose(r['odd_depth_ppm'],100000)
    assert r['outside_mad_ppm']==0  # valid descriptor; never divide by it


def test_empty_primary_does_not_become_zero_depth():
    r=window_stats(np.array([.3,.4]),np.ones(2),dict(period_days=2.,epoch_btjd=0.,duration_hours=1.))
    assert r=={'status':'not_measurable'}
