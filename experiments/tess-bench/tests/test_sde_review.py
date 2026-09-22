import numpy as np
import pytest

from tess_bench.sde_review import sde_arrays


def test_global_matches_reference_and_affine_scaling():
    p = np.linspace(.5, 20, 1001)
    y = np.random.default_rng(42).normal(size=len(p))
    a = sde_arrays(p, y, median_window=51)
    b = sde_arrays(p, 3 * y + 10, median_window=51)
    np.testing.assert_allclose(a['global_'], (y - y.mean()) / y.std())
    for k in a:
        np.testing.assert_allclose(a[k], b[k], atol=1e-12)


def test_constant_is_unmeasurable_not_zero():
    a = sde_arrays(np.linspace(1, 10, 1001), np.ones(1001))
    assert all(np.isnan(v).all() for v in a.values())


def test_log_last_edge_and_sparse_bins():
    p = np.geomspace(1, 100, 100)
    y = np.arange(100.) ** 2
    a = sde_arrays(p, y, median_window=5, log_bins=2)
    np.testing.assert_allclose(a['log_bins'][50:], (y[50:] - y[50:].mean()) / y[50:].std())
    b = sde_arrays(p, y, median_window=5, log_bins=100)
    assert np.isnan(b['log_bins']).all()


def test_running_median_removes_slow_background():
    p = np.linspace(1, 10, 1001)
    y = np.linspace(0, 100, 1001)
    y[500] += 5
    a = sde_arrays(p, y, median_window=51)
    assert a['running_median'][500] > a['global_'][500] + 5


@pytest.mark.parametrize('kind', ['nan', 'descending', 'duplicate', 'shape'])
def test_invalid_periodogram_rejected(kind):
    p, y = np.arange(1., 12.), np.arange(11.)
    if kind == 'nan': y[0] = np.nan
    if kind == 'descending': p = p[::-1]
    if kind == 'duplicate': p[1] = p[0]
    if kind == 'shape': y = y[:-1]
    with pytest.raises(ValueError, match='invalid_periodogram'):
        sde_arrays(p, y, median_window=3)


def test_bad_window_rejected():
    with pytest.raises(ValueError, match='invalid_median_window'):
        sde_arrays(np.arange(1., 12.), np.arange(11.), median_window=4)


def test_gate_recomputes_match_after_filtering(monkeypatch):
    from types import SimpleNamespace
    from tess_bench.bls import Peak
    from tess_bench.sde_review import compare_curve
    p = Peak(1, 1., 0., 1., .01, .001, 10., 10., 6., 7., 7., 2, 10, 0.)
    run = SimpleNamespace(periods=np.array([1., 2., 3.]), peaks=[p], period_min_days=.5, period_max_days=3.)
    base = SimpleNamespace(time=np.arange(10.))
    member = SimpleNamespace(period_days=1.)
    monkeypatch.setattr('tess_bench.sde_review.match_injection',
                        lambda t, m, ps: SimpleNamespace(match='direct' if ps else 'missed'))
    arrays = dict(global_=np.array([6., 0., 0.]), running_median=np.array([np.nan, 0., 0.]), log_bins=np.array([6., 0., 0.]))
    rows = compare_curve(base, [member], run, [0.], arrays)
    assert next(r for r in rows if r['method']=='global' and r['dy']=='global' and r['threshold']==6.)['direct'] == 1
    assert next(r for r in rows if r['method']=='global' and r['dy']=='local' and r['threshold']==6.)['direct'] == 0
    assert next(r for r in rows if r['method']=='running_median' and r['threshold']==2.)['selected_peaks'] == 0


def test_runner_writes_verified_outputs_without_fits(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    from tess_bench import sde_review as mod
    from tess_bench.bls import BlsSetting
    root = tmp_path
    bench, fixture = root / 'experiments/tess-bench', root / 'experiments/tess-fixture'
    for folder in (bench, fixture, root / 'libs/astro-kernel'):
        folder.mkdir(parents=True)
        (folder / 'pyproject.toml').write_text('')
    (fixture / 'configs').mkdir()
    for path in (fixture / 'checksums.json', fixture / 'references.csv',
                 fixture / 'configs/injection_grid_v1.json', bench / 'uv.lock'):
        path.write_text('{}')
    for name, value in [('ROOT', root), ('BENCH', bench), ('FIXTURE', fixture)]:
        monkeypatch.setattr(mod, name, value)
    monkeypatch.setattr(mod, 'iter_products', lambda _: [])
    setting = BlsSetting('test', n_periods=1200)
    monkeypatch.setattr(mod, 'load_bls_settings', lambda *a: ({}, [setting]))
    monkeypatch.setattr(mod, 'load_settings', lambda *a: ({}, [None]))
    t = np.linspace(0, 20, 500)
    f = 1 + np.random.default_rng(1).normal(0, .001, len(t))
    base = SimpleNamespace(time=t, flux=f, sector_of_point=np.ones(len(t)))
    monkeypatch.setattr(mod, 'build_bls_inputs', lambda *a, **kw:
                        SimpleNamespace(baselines={'realclean': base}, groups={'realclean': {'none': []}}))
    monkeypatch.setattr(mod, 'preprocess', lambda *a: SimpleNamespace(
        status='ok', time=t, flux_det=f, kept=np.ones(len(t), bool)))
    mod.run_review(['l98_59'], tmp_path, tmp_path / 'out', limit=1)
    out = next((tmp_path / 'out').iterdir())
    manifest = json.loads((out / 'manifest.json').read_text())
    assert manifest['status'] == 'completed' and manifest['subset']
    assert manifest['curves'] == 1 and manifest['comparison_rows'] == 81
    mod.verify_snapshot([manifest['plan'], *manifest['outputs']])
    with np.load(next(out.glob('*.npz')), allow_pickle=False) as data:
        assert data['power'].shape == (1200,)
