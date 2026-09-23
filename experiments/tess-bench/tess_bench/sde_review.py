"""243 experimental SDE comparison; fixed power-ranked peaks, no operational edits."""
import argparse
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np
from scipy.ndimage import median_filter

from tess_fixture import inject as inj, manifest as mf
from tess_fixture.targets import select_targets, iter_products
from .bls import load_bls_settings, run_bls
from .bls_dy import local_scatter, recompute_snr
from .bls_match import match_injection
from .cli import build_bls_inputs
from .preprocess import load_settings, preprocess
from .silver_regression import ROOT, BENCH, FIXTURE, verify_snapshot, write_csv

TARGETS = ('l98_59', 'cm_dra', 'wasp18', 'toi700', 'hd21749')
THRESHOLDS = (2., 3., 4., 5., 6., 8., 10., 12.)
METHODS = ('global', 'running_median', 'log_bins')
SEEDS = (20260910, 20260917, 20260918)


def standardize(values):
    out = np.full(values.shape, np.nan)
    finite = np.isfinite(values)
    if finite.sum() >= 2:
        sd = float(np.std(values[finite]))
        if sd > 0 and np.isfinite(sd):
            out[finite] = (values[finite] - np.mean(values[finite])) / sd
    return out


def sde_arrays(periods, power, *, median_window=1001, log_bins=10, min_bin_points=20):
    """Experimental definitions on an ascending full finite periodogram.

    Running median uses a fixed grid-point window with reflected edges;
    log bins include their left edge and the final bin includes the maximum.
    Sparse/constant bins are unmeasurable, never silently globally filled.
    """
    p, y = np.asarray(periods, float), np.asarray(power, float)
    if (p.ndim != 1 or p.shape != y.shape or len(p) < 3 or
            not np.all(np.isfinite(p)) or not np.all(np.isfinite(y)) or
            np.any(p <= 0) or np.any(np.diff(p) <= 0)):
        raise ValueError('invalid_periodogram')
    if median_window < 3 or median_window % 2 != 1 or median_window > len(p):
        raise ValueError('invalid_median_window')
    if log_bins < 1 or min_bin_points < 2:
        raise ValueError('invalid_log_bins')
    detrended = y - median_filter(y, size=median_window, mode='reflect')
    local = np.full(y.shape, np.nan)
    edges = np.geomspace(p[0], p[-1], log_bins + 1)
    bins = np.clip(np.searchsorted(edges, p, side='right') - 1, 0, log_bins - 1)
    for b in range(log_bins):
        mask = bins == b
        if mask.sum() >= min_bin_points:
            local[mask] = standardize(y[mask])
    return dict(global_=standardize(y), running_median=standardize(detrended), log_bins=local)


def compare_curve(baseline, members, run, local_snr, arrays, global_exact=None):
    """Re-match all surviving peaks; threshold filtering must not reuse old match ranks."""
    indexes = [int(np.searchsorted(run.periods, peak.period_days)) for peak in run.peaks]
    rows = []
    in_range = [m for m in members if run.period_min_days <= m.period_days <= run.period_max_days]
    for method in METHODS:
        scores = arrays['global_' if method == 'global' else method]
        snrs = dict(global_=[p.snr for p in run.peaks], local=local_snr)
        if global_exact is not None:
            snrs['global_exact'] = global_exact
        for dy_key, values in snrs.items():
            dy = 'global' if dy_key == 'global_' else dy_key
            peaks = [replace(p, sde=float(scores[i]), snr=float(s)) for p, i, s in
                     zip(run.peaks, indexes, values, strict=True)]
            for threshold in (None, *THRESHOLDS):
                selected = peaks if threshold is None else [p for p in peaks if
                           p.snr >= 7 and p.sde >= threshold and p.n_transits >= 2]
                matches = [match_injection(baseline.time, m, selected).match for m in in_range]
                rows.append(dict(method=method, dy=dy, threshold='ungated' if threshold is None else threshold,
                                 signals_in_range=len(in_range), direct=matches.count('direct'),
                                 alias=sum(m.startswith('alias') for m in matches),
                                 selected_peaks=len(selected), control=not bool(members),
                                 unmeasurable_sde=sum(not np.isfinite(p.sde) for p in peaks)))
    return rows


def verify_kernel(time, flux, baseline_time, reference, arrays, baseline, members):
    """Independent experimental definition versus operational search and rematching."""
    from types import SimpleNamespace
    from astro_kernel.bls import search_bls, running_median_sde, RUNNING_MEDIAN_QUALITY_VERSION
    actual = search_bls(time, flux, baseline_time=baseline_time,
                        input_snapshot_id="243-regression", preprocessing_version="biweight_1.0d",
                        quality_version=RUNNING_MEDIAN_QUALITY_VERSION)
    pg = actual["periodogram"]
    np.testing.assert_array_equal(pg.periods, reference.periods)
    np.testing.assert_allclose(pg.power, reference.power, rtol=1e-12, atol=1e-12)
    np.testing.assert_allclose(running_median_sde(pg.periods, pg.power),
                               arrays["running_median"], rtol=1e-12, atol=1e-12, equal_nan=True)
    if actual["candidate_quality_version"] != RUNNING_MEDIAN_QUALITY_VERSION or actual["status"] == "failed":
        raise ValueError("kernel_version_or_search_failed")
    expected = []
    for old, new in zip(reference.peaks, actual["peaks"], strict=True):
        i = int(np.searchsorted(reference.periods, old.period_days))
        score = float(arrays["running_median"][i])
        for key in ("period_days", "epoch_btjd", "duration_hours", "depth", "depth_err", "power", "snr", "n_transits"):
            np.testing.assert_allclose(new[key], getattr(old, key), rtol=1e-12, atol=1e-12)
        np.testing.assert_allclose(new["sde"], score, rtol=1e-12, atol=1e-12, equal_nan=True)
        passed = bool(old.snr >= 7 and score >= 8 and old.n_transits >= 2)
        if passed != (new["status"] == "accepted"):
            raise ValueError("kernel_gate_mismatch")
        if passed:
            expected.append(replace(old, sde=score))
    selected = [SimpleNamespace(**p) for p in actual["accepted_peaks"]]
    for member in members:
        if reference.period_min_days <= member.period_days <= reference.period_max_days:
            a = match_injection(baseline.time, member, expected)
            b = match_injection(baseline.time, member, selected)
            if (a.match, a.matched_rank) != (b.match, b.matched_rank):
                raise ValueError("kernel_recovery_mismatch")
    return dict(passed=True, candidate_quality_version=actual["candidate_quality_version"],
                n_accepted=actual["n_accepted"])


def run_review(targets, raw, results, limit=0, verify_operational=False):
    cfg, settings = load_bls_settings(BENCH / 'configs/bls_settings_v1.json', ['poc_linear20k'])
    _, pres = load_settings(BENCH / 'configs/preprocess_settings_v1.json', ['biweight_1.0d'])
    paths = [raw / t.key / name for t, _, name, _ in iter_products(select_targets(targets))]
    paths += [FIXTURE / 'checksums.json', FIXTURE / 'references.csv',
              FIXTURE / 'configs/injection_grid_v1.json', BENCH / 'uv.lock']
    for folder in (BENCH, FIXTURE, ROOT / 'libs/astro-kernel'):
        paths.append(folder / 'pyproject.toml')
    for folder in (BENCH / 'tess_bench', FIXTURE / 'tess_fixture', ROOT / 'libs/astro-kernel/astro_kernel'):
        paths += sorted(folder.rglob('*.py'))
    paths += sorted((BENCH / 'configs').glob('*.json'))
    inputs = [mf.file_entry(p) for p in paths]
    out = results / ('run-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task='S15P21C206-243', targets=targets, limit=limit, inputs=inputs,
                verify_operational=verify_operational,
                scope='exploratory reanalysis of previously inspected evaluation targets; not independent holdout',
                settings=settings[0].params(), seeds=SEEDS, thresholds=THRESHOLDS,
                median_window=1001, log_bins=10, min_bin_points=20,
                snr_min=7, n_transits_min=2, peak_selection='original power-ranked top 5; no reranking',
                local_snr='fixed peaks only, 1-day robust scatter; not weighted BLS re-search; global_exact controls compute_stats versus power approximation',
                environment=mf.environment_info(('numpy', 'astropy', 'scipy')))
    (out / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
    plan_entry = mf.file_entry(out / 'plan.json')
    print(f'Plan fixed: {out / "plan.json"}', flush=True)
    outputs, rows, peak_rows = [], [], []
    kernel_rows = []
    try:
        for target in targets:
            bi = build_bls_inputs(target, 'evaluation', cfg, pres[0], FIXTURE / 'configs/injection_grid_v1.json',
                                  raw, noise_seeds=list(SEEDS), limit=limit)
            for bkey, groups in bi.groups.items():
                base = bi.baselines[bkey]
                for n, (gid, members) in enumerate(groups.items(), 1):
                    flux = inj.inject_group(base, members) if members else base.flux.copy()
                    prepared = preprocess(base.time, flux, base.sector_of_point, pres[0])
                    if prepared.status != 'ok':
                        raise ValueError(f'preprocessing_failed:{target}/{bkey}/{gid}')
                    keep = prepared.kept & np.isfinite(prepared.flux_det)
                    t, f = prepared.time[keep], prepared.flux_det[keep]
                    result = run_bls(t, f, settings[0], baseline_time=base.time, keep_periodogram=True)
                    arrays = sde_arrays(result.periods, result.power)
                    if verify_operational:
                        checked = verify_kernel(t, f, base.time, result, arrays, base, members)
                        kernel_rows.append(dict(target=target, baseline=bkey, group=gid, **checked))
                    local = recompute_snr(t, f, local_scatter(t, f), [p.as_row() for p in result.peaks])
                    scatter = float(1.4826 * np.median(np.abs(f - np.median(f))))
                    exact = recompute_snr(t, f, np.full(f.shape, scatter), [p.as_row() for p in result.peaks])
                    for p, s in zip(result.peaks, local, strict=True):
                        i = int(np.searchsorted(result.periods, p.period_days))
                        np.testing.assert_allclose(arrays['global_'][i], p.sde, rtol=1e-12, atol=1e-12)
                        peak_rows.append(dict(target=target, baseline=bkey, group=gid, **p.as_row(), local_snr=s,
                                              running_median_sde=arrays['running_median'][i], log_bins_sde=arrays['log_bins'][i]))
                    path = out / f'{target}-{bkey}-{n:04d}.npz'
                    rows += [dict(target=target, baseline=bkey, group=gid, periodogram_file=path.name, **r)
                             for r in compare_curve(base, members, result, local, arrays, exact)]
                    np.savez_compressed(path, periods=result.periods, power=result.power, **arrays)
                    outputs.append(mf.file_entry(path))
                    if n % 20 == 0 or n == len(groups):
                        print(f'{target}/{bkey}: {n}/{len(groups)} curves', flush=True)
        write_csv(out / 'comparisons.csv', rows)
        write_csv(out / 'peaks.csv', peak_rows)
        outputs += [mf.file_entry(out / name) for name in ('comparisons.csv', 'peaks.csv')]
        if verify_operational:
            write_csv(out / 'kernel-comparisons.csv', kernel_rows)
            outputs.append(mf.file_entry(out / 'kernel-comparisons.csv'))
        verify_snapshot(inputs + [plan_entry] + outputs)
        manifest = dict(task=plan['task'], status='completed', adopted=False, plan=plan_entry,
                        outputs=outputs, curves=sum(p['path'].endswith('.npz') for p in outputs),
                        comparison_rows=len(rows), kernel_verified_curves=len(kernel_rows),
                        subset=bool(limit or tuple(targets) != TARGETS))
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print(f'Completed: {out}', flush=True)
    except BaseException as exc:
        (out / 'failure.json').write_text(json.dumps(dict(status='failed', reason=str(exc))) + '\n', encoding='utf-8')
        raise


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--targets', nargs='+', choices=TARGETS, default=list(TARGETS))
    p.add_argument('--raw', type=Path, default=FIXTURE / 'sample_raw')
    p.add_argument('--results', type=Path, default=BENCH / 'results/sde-review')
    p.add_argument('--verify-kernel', action='store_true', help='compare operational 243 search on every curve')
    p.add_argument('--limit', type=int, default=0, help='smoke only: groups per baseline, plus none')
    args = p.parse_args()
    if args.limit < 0 or len(args.targets) != len(set(args.targets)):
        p.error('limit must be nonnegative and targets unique')
    run_review(args.targets, args.raw, args.results, args.limit, args.verify_kernel)


if __name__ == '__main__':
    main()
