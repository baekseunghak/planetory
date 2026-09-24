from tess_bench.population_kernel import summarize


def test_held_is_not_zero_and_groups_are_separate():
    rows=[dict(group='random',status='held',n_accepted=None,n_discoverable=None),
          dict(group='random',status='measured',n_accepted=0,n_discoverable=0),
          dict(group='random',status='measured',n_accepted=2,n_discoverable=1),
          dict(group='planet_host',status='measured',n_accepted=1,n_discoverable=0)]
    s=summarize(rows)
    assert s['random']['held']==1
    assert s['random']['zero_accepted_fraction']==0.5
    assert s['random']['with_discoverable_fraction']==0.5
    assert s['planet_host']['zero_accepted_fraction']==0
    assert s['planet_host']['with_discoverable']==0


def test_all_held_has_no_fraction():
    s=summarize([dict(group='random',status='held')])['random']
    assert s['zero_accepted_fraction'] is None
    assert s['with_discoverable_fraction'] is None

def test_measure_preserves_step_order_and_holds_failed_iteration(monkeypatch):
    from types import SimpleNamespace
    import numpy as np
    from tess_bench import population_kernel as mod
    base=SimpleNamespace(time=np.arange(5.),flux=np.ones(5),sector_of_point=np.ones(5))
    monkeypatch.setattr(mod,'load_sector',lambda p:None)
    monkeypatch.setattr(mod,'build_baseline',lambda c:base)
    monkeypatch.setattr(mod,'detrend_silver',lambda *a:SimpleNamespace(status='ok',failures=[],time=base.time,flux_det=base.flux,version='test'))
    candidates=[dict(step=i,period_days=2.,transit_model={'step':i}) for i in [0,1]]
    monkeypatch.setattr(mod,'iterate_bls',lambda *a,**kw:dict(complete=True,accepted=candidates))
    calls=[]
    def evaluate(t,f,previous,model,periods):
        calls.append(previous)
        return dict(status='measured',discoverable=model is not None),None,None
    monkeypatch.setattr(mod,'evaluate',evaluate)
    result=mod.measure(None,'snapshot','gate_v1/snr7_sde6')
    assert result['n_discoverable']==2
    assert calls==[[],[],[{'step':0}]]
    monkeypatch.setattr(mod,'iterate_bls',lambda *a,**kw:dict(complete=False,termination='removal_qa_failed'))
    result=mod.measure(None,'snapshot','gate_v1/snr7_sde6')
    assert result['status']=='held' and result['n_accepted'] is None


def test_combined_sectors_do_not_bin_the_intersector_gap(monkeypatch):
    from types import SimpleNamespace
    import numpy as np
    from tess_bench import population_kernel as mod
    time=np.array([0.,.01,.02,700.,700.01,700.02])
    flux=np.array([1.,np.nan,1.,1.,1.,1.])
    sector=np.array([5,5,5,31,31,31])
    monkeypatch.setattr(mod,'load_sector',lambda p:p)
    monkeypatch.setattr(mod,'build_baseline',lambda c:SimpleNamespace(time=time,flux=flux,sector_of_point=sector))
    monkeypatch.setattr(mod,'detrend_silver',lambda *a:SimpleNamespace(status='ok',failures=[],time=time,flux_det=flux,version='test'))
    def iterate(t,f,**kw):
        np.testing.assert_array_equal(kw['sector'],sector)
        np.testing.assert_array_equal(kw['baseline_time'],time)
        return dict(complete=True,accepted=[])
    monkeypatch.setattr(mod,'iterate_bls',iterate)
    def evaluate(t,f,*args):
        assert len(t)==6  # three bins per Sector, no 700-day allocation
        assert not ((t>1)&(t<699)).any()
        assert np.isnan(f).sum()==1
        return dict(status='measured',discoverable=None),None,None
    monkeypatch.setattr(mod,'evaluate',evaluate)
    result=mod.measure_sectors(['a','b'],'snapshot','test')
    assert result['status']=='measured'
    assert [s['sector'] for s in result['segments']]==[5,31]
    assert result['segments'][0]['gaps']==[[1,1]]
