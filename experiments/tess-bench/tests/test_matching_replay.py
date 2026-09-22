from types import SimpleNamespace

import numpy as np
import pytest

from tess_bench.matching_replay import observation, selection, snapshot, assert_snapshot


def test_windows_preserve_empty_bins_and_sector_gap():
    baseline = SimpleNamespace(time=np.array([0., 1 / 144, 3 / 144, 10.]),
        sectors=(1, 2), sector_of_point=np.array([1, 1, 1, 2]))
    bundle, bins = observation(baseline, np.array([1., np.nan, 1., 1.]))
    np.testing.assert_allclose(bundle['observedWindows'], [[0, 0], [3 / 144, 3 / 144], [10, 10]], rtol=0, atol=1e-14)
    assert bundle['observationBounds'] == pytest.approx([0, 10 + 1 / 144])
    assert bundle['foldReferenceTimeBtjd'] == pytest.approx(2 / 144)
    assert bins[0]['n_empty'] == 2


def test_empty_curve_does_not_invent_observations():
    baseline = SimpleNamespace(time=np.array([0., .1]), sectors=(1,), sector_of_point=np.array([1, 1]))
    bundle, _ = observation(baseline, np.array([np.nan, np.nan]))
    assert bundle['observedWindows'] == []


def test_sector_cap_rejected_instead_of_widening():
    baseline = SimpleNamespace(time=np.array([0., 150.]), sectors=(1,), sector_of_point=np.array([1, 1]))
    with pytest.raises(ValueError, match='never widen'):
        observation(baseline, np.ones(2))


@pytest.mark.parametrize('period', [0.5, 2., 20.])
def test_phase_selection_preserves_epoch_and_duration_across_boundary(period):
    s = selection(period, 100., 1., 100.)
    assert 0 <= s['phaseStart'] < 1 < s['phaseEnd']
    assert (s['phaseEnd'] - s['phaseStart']) * period * 24 == pytest.approx(1)
    center = ((s['phaseStart'] + s['phaseEnd']) / 2) % 1
    assert center == pytest.approx(0)
    assert s['sourcePeakGridIndex'] is None


def test_snapshot_change_rejected(tmp_path):
    p = tmp_path / 'input.json'
    p.write_text('{}')
    records = snapshot([p])
    assert_snapshot(records)
    p.write_text('{"changed": true}')
    with pytest.raises(ValueError, match='snapshot changed'):
        assert_snapshot(records)


def test_build_run_reconstructs_catalog_and_keeps_probe_unlabelled(tmp_path, monkeypatch):
    import json
    import csv
    from tess_bench import matching_replay as replay
    from tess_fixture.lightcurve import Baseline
    grid = dict(grid_id='synthetic', version='1', model='box', period_days=[2.],
                duration_hours=[3.], depth_ppm=[1000.], phase_fraction={'middle': .5})
    grid_path = tmp_path / 'grid.json'
    grid_path.write_text(json.dumps(grid))
    t = np.arange(0, 10, 1 / 144)
    baseline = Baseline(1, (1,), t, np.ones(len(t)), np.ones(len(t), dtype=int),
                        {1: 1.}, len(t), len(t), ('synthetic.fits',))
    monkeypatch.setattr(replay, 'load_sector', lambda p: None)
    monkeypatch.setattr(replay, 'build_baseline', lambda curves: baseline)
    catalog = replay.inj.build_catalog(grid, baseline, 'toy-realclean', 'synthetic-1')
    r = catalog[0]
    common = dict(baseline_id='toy-realclean', group_id=r.group_id, setting_id='s')
    tables = {
        'steps': [dict(**common, status='accepted', step=0, period_days=2, epoch_btjd=1, duration_hours=3)],
        'matches': [dict(injection_id=r.injection_id, period_days=2, duration_hours=3, depth_ppm=1000)]}
    outputs = []
    for kind, rows in tables.items():
        p = tmp_path / f'{kind}.csv'
        with p.open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        outputs.append(dict(kind=kind, path=str(p)))
    m = dict(run_id='synthetic', inputs=[dict(role='raw_product', path='synthetic.fits'),
        dict(role='grid', path=str(grid_path))], outputs=outputs,
        config=dict(parameters=dict(target='toy', stage='evaluation', noise_seeds=[], baselines=['realclean'],
            known_signals_removed=[], grid_set_id='synthetic-1', setting='s', baseline_days=10,
            preprocess_setting=dict(detrend_method='none', min_points=10),
            setting_params=dict(period_min_days=.5))))
    evidence = dict(measurements=[dict(baseline_id='toy-realclean', group_id=r.group_id,
                                       injection_id=r.injection_id, step=0)])
    curves = replay.build_run(m, evidence, log=lambda *a, **kw: None)
    assert len(curves) == 1
    assert len(curves[0]['submissions']) == 4
    assert {s['variant'] for s in curves[0]['submissions']} == {'truth', 'half-period', 'double-period', 'offset-probe'}
    assert all('false_positive' not in s for s in curves[0]['submissions'])
    assert curves[0]['bundle']['observedWindows']
