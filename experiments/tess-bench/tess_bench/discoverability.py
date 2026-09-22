"""115 experiment: fixed provided resolution, discovery-stage residuals."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from uuid import uuid4

import numpy as np
from astro_kernel.bls import BlsError, bls_periodogram, period_grid
from astro_kernel.iteration import iterate_bls
from astro_kernel.preprocessing import detrend_silver
from astro_kernel.transit_model import remove_transit_models, phase_distance_days
from tess_fixture import inject as inj, manifest as mf
from tess_fixture.targets import select_targets, iter_products
from .binning import bin_curve
from .bls import load_bls_settings
from .cli import build_bls_inputs
from .preprocess import load_settings
from .silver_regression import ROOT, BENCH, FIXTURE, verify_snapshot

CONFIG = BENCH / "configs/discoverability_v1.json"
TARGETS = ("toi270", "l98_59", "cm_dra", "wasp18", "wasp62", "toi700", "toi451", "pi_men", "hd21749")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def provided_curve(t, f, sectors, minutes):
    """114 reference only; reject experimental auto-expansion for 115."""
    times, fluxes, records = [], [], []
    for sector in np.unique(sectors):
        selected = sectors == sector
        b = bin_curve(t[selected], f[selected], minutes=minutes, reducer="mean")
        if b.minutes != minutes:
            raise ValueError("provided grid exceeds 20000 points; no automatic expansion")
        times.append(b.centers)
        fluxes.append(b.flux)
        records.append(dict(sector=int(sector), start_btjd=b.start, n_points=len(b.flux),
                            n_finite=int(np.isfinite(b.flux).sum()), gaps=b.gaps))
    t, f = np.concatenate(times), np.concatenate(fluxes)
    order = np.argsort(t, kind="stable")
    return t[order], f[order], records


def observed_transits(t, f, period, epoch, duration):
    good = np.isfinite(f) & (np.abs(phase_distance_days(t, period, epoch)) < duration / 48)
    return len(np.unique(np.rint((t[good] - epoch) / period).astype(np.int64)))


def classify(pg, t, f, model, cfg):
    """All interior strict maxima, not the UI top-N recommendation list.

    Endpoints/plateaus are deliberately excluded in this proposal. Alias
    matching is not inferred from a similar period alone.
    """
    power = pg.power
    indices = np.flatnonzero((power[1:-1] > power[:-2]) & (power[1:-1] > power[2:])) + 1
    peaks = []
    for i in indices:
        ntr = observed_transits(t, f, pg.periods[i], pg.epoch_btjd[i], pg.duration_hours[i])
        if (pg.snr[i] >= cfg["snr_min"] and pg.sde[i] >= cfg["sde_min"]
                and ntr >= cfg["min_observed_transits"]):
            peaks.append(dict(grid_index=int(i), period_days=float(pg.periods[i]),
                              epoch_btjd=float(pg.epoch_btjd[i]), duration_hours=float(pg.duration_hours[i]),
                              snr=float(pg.snr[i]), sde=float(pg.sde[i]), n_transits=ntr))
    result = dict(status="measured", qualified_peaks=peaks, discoverable=None,
                  reason="quality_peak_present" if peaks else "no_quality_peak")
    if model is None:
        return result
    p = model["parameters"]
    if not pg.periods[0] <= p["period_days"] <= pg.periods[-1]:
        return {**result, "discoverable": False, "reason": "outside_provided_grid"}
    log_cell = np.log(pg.periods[-1] / pg.periods[0]) / (len(pg.periods) - 1)
    matched = []
    for peak in peaks:
        cells = abs(np.log(peak["period_days"] / p["period_days"]) / log_cell)
        epoch_error = abs(float(phase_distance_days([peak["epoch_btjd"]], p["period_days"], p["epoch_btjd"])[0]))
        if (cells <= cfg["match_half_width_cells"]
                and epoch_error <= max(peak["duration_hours"], p["duration_hours"]) / 48):
            matched.append(peak["grid_index"])
    return {**result, "discoverable": bool(matched), "matched_grid_indices": matched,
            "reason": "matched_peak" if matched else "no_matching_quality_peak"}


def evaluate(t, f, previous_models, model, cfg, periods):
    residual = remove_transit_models(t, f, previous_models).flux_residual
    try:
        pg = bls_periodogram(t, residual, periods, durations_hours=cfg["durations_hours"],
                             config_version=cfg["version"])
    except BlsError as exc:
        # Degenerate/failed inputs never become a measured no-signal result.
        return dict(status="input_insufficient" if exc.code == "insufficient_observations" else "calculation_failed",
                    reason=exc.code, discoverable=None, qualified_peaks=[]), residual, None
    return classify(pg, t, residual, model, cfg), residual, pg


def summarize(rows):
    # Only one unmodified realclean curve per target. Injected curves are not
    # independent stars; realclean has Archive-listed transits removed.
    controls = [r for r in rows if r["control"] and r["stage"] == "original"]
    valid = [r for r in controls if r["status"] == "measured"]
    no_peak = sum(not r["qualified_peaks"] for r in valid)
    candidates = [r for r in rows if r["stage"] == "candidate"]
    return dict(control_total=len(controls), control_measured=len(valid), control_no_quality_peak=no_peak,
                control_no_quality_peak_fraction=no_peak / len(valid) if valid else None,
                candidate_total=len(candidates), candidate_measured=sum(r["status"] == "measured" for r in candidates),
                candidate_discoverable=sum(r["discoverable"] is True for r in candidates),
                limitation="realclean fixture controls only; not raw stars or service population prevalence")


def reevaluation_changes(old, new, old_revision, new_revision):
    """Stable candidate keys must be supplied by identity reconciliation.

    Missing/failed evaluations are not false. No membership event is emitted.
    """
    if old_revision == new_revision:
        if old != new:
            raise ValueError("same revision has different decisions")
        return []
    changes = []
    for key in sorted(old.keys() & new.keys()):
        before, after = old[key], new[key]
        if before is False and after is True:
            changes.append(dict(candidate_key=key, before=False, after=True,
                                old_revision=old_revision, new_revision=new_revision))
    return changes


def revision_probe(cfg, out):
    """Independent seeded synthetic example, never a real-candidate result.

    A transition is measured, not forced. Absence of false->true remains an
    unresolved acceptance condition and must not trigger automatic retuning.
    """
    from astro_kernel.transit_model import model_flux
    t = (np.arange(5760) + .5) * 10 / 1440
    m = dict(shape="box", candidate_id="synthetic-115",
             parameters=dict(period_days=2.731, epoch_btjd=.6, duration_hours=2.88, depth_ppm=2000.))
    f = model_flux(t, m) + np.random.default_rng(20260922).normal(0, .0005, len(t))
    runs = []
    for count in (64, cfg["grid"]["count"]):
        periods = period_grid(.5, 40., count, spacing="log")
        verdict, _, pg = evaluate(t, f, [], m, cfg, periods)
        arrays = dict(time=t, flux=f, periods=periods)
        if pg is not None:
            arrays.update(power=pg.power, snr=pg.snr, sde=pg.sde)
        np.savez_compressed(out / f"revision-probe-{count}.npz", **arrays)
        runs.append(dict(count=count, evaluation_revision=digest(dict(config=cfg, count=count, seed=20260922)), **verdict))
    changes = reevaluation_changes({"synthetic-115": runs[0]["discoverable"]},
                                    {"synthetic-115": runs[1]["discoverable"]},
                                    runs[0]["evaluation_revision"], runs[1]["evaluation_revision"])
    return dict(scope="synthetic grid sensitivity, not an approved old operational revision",
                model=m, seed=20260922, runs=runs, false_to_true=changes)


def run(raw, results, targets):
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    bls_cfg, _ = load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
    _, pre = load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
    paths = [raw / target.key / filename for target, _, filename, _ in iter_products(select_targets(targets))]
    paths += [FIXTURE / "checksums.json", FIXTURE / "references.csv", BENCH / "uv.lock",
              BENCH / "pyproject.toml", ROOT / "libs/astro-kernel/pyproject.toml"]
    for directory in (BENCH / "configs", FIXTURE / "configs", BENCH / "tess_bench",
                      FIXTURE / "tess_fixture", ROOT / "libs/astro-kernel/astro_kernel"):
        paths += sorted(directory.glob("*.json" if directory.name == "configs" else "*.py"))
    entries = [mf.file_entry(p) for p in sorted(set(paths))]
    snapshot = digest([{ "file": str(Path(e["path"]).relative_to(ROOT)) if Path(e["path"]).is_relative_to(ROOT)
                         else Path(e["path"]).name, "sha256": e["sha256"]} for e in entries])
    out = results / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-115", inputs=entries, config=cfg, targets=targets,
                environment=mf.environment_info(("numpy", "astropy", "scipy")),
                candidate_source="122 iterate_bls, no truth-assisted selection",
                controls="realclean none plus three injected pairs per target",
                approval="proposal only; no production discoverable update")
    (out / "plan.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    plan_entry = mf.file_entry(out / "plan.json")
    print(f"Plan fixed: {out / 'plan.json'}", flush=True)
    started, rows = time.perf_counter(), []
    try:
        for target in targets:
            bi = build_bls_inputs(target, "tuning", bls_cfg, pre[0], FIXTURE / "configs/injection_grid_v1.json", raw, noise_seeds=[])
            base = bi.baselines["realclean"]
            groups = [(gid, members) for gid, members in bi.groups["realclean"].items() if not members or len(members) == 2]
            if len(groups) != 4:
                raise ValueError("expected none and three registered pairs")
            for gid, members in groups:
                source = inj.inject_group(base, members) if members else base.flux.copy()
                prepared = detrend_silver(base.time, source, base.sector_of_point)
                if prepared.status != "ok":
                    raise ValueError(f"preprocessing failed: {target}/{gid}/{prepared.status}")
                original = iterate_bls(prepared.time, prepared.flux_det, sector=base.sector_of_point,
                    baseline_time=prepared.time, input_snapshot_id=plan_entry["sha256"], preprocessing_version=prepared.version)
                t, f, segments = provided_curve(prepared.time, prepared.flux_det, base.sector_of_point, cfg["bin_minutes"])
                pmax = max([40.0] + [c["period_days"] for c in original["accepted"]])
                periods = period_grid(cfg["grid"]["min_days"], pmax,
                                      cfg["grid"]["count"], spacing=cfg["grid"]["spacing"])
                previous = []
                revision = digest(dict(snapshot=snapshot, target=target, group=gid,
                                       config=cfg, period_max_days=pmax))
                context = dict(target=target, group=gid, control=not members, source_termination=original["termination"],
                               evaluation_revision=revision, source_complete=original["complete"])
                source_name = f"source-{target}-{len(rows):04d}.json"
                (out / source_name).write_text(json.dumps(original, indent=2, allow_nan=False) + "\n", encoding="utf-8")
                context["source_output"] = source_name
                stages = [("original", None)] + [("candidate", c) for c in original["accepted"]]
                for stage, candidate in stages:
                    model = candidate["transit_model"] if candidate else None
                    verdict, residual, pg = evaluate(t, f, previous, model, cfg, periods)
                    if candidate and not candidate["validated_on_original"]:
                        verdict.update(status="candidate_invalid", reason="original_validation_failed", discoverable=None)
                    filename = f"stage-{len(rows):04d}.npz"
                    arrays = dict(time=t, flux=residual, periods=periods)
                    if pg is not None:
                        arrays.update(power=pg.power, snr=pg.snr, sde=pg.sde, epoch_btjd=pg.epoch_btjd, duration_hours=pg.duration_hours)
                    np.savez_compressed(out / filename, **arrays)
                    rows.append(dict(**context, stage=stage, candidate=candidate,
                                     removed_models=list(previous), segments=segments, output=filename, **verdict))
                    if model is not None:
                        previous.append(model)
                print(f"{target}/{gid}: {len(original['accepted'])} candidates evaluated", flush=True)
        verify_snapshot(entries + [plan_entry])
        (out / "measurements.json").write_text(json.dumps(rows, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        probe = revision_probe(cfg, out)
        (out / "revision-probe.json").write_text(json.dumps(probe, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        verify_snapshot(entries + [plan_entry])
        summary = summarize(rows)
        manifest = dict(task="S15P21C206-115", status="completed", plan=plan_entry, summary=summary,
                        wall_s=time.perf_counter() - started,
                        outputs=[mf.file_entry(p) for p in sorted(out.iterdir()) if p.name != "plan.json"])
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps(summary), flush=True)
        print(f"Completed: {out}", flush=True)
    except BaseException as exc:
        (out / "failure.json").write_text(json.dumps(dict(reason=str(exc), completed_stages=len(rows))) + "\n", encoding="utf-8")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--results", type=Path, default=BENCH / "results/discoverability")
    parser.add_argument("--targets", nargs="+", choices=TARGETS, default=list(TARGETS))
    args = parser.parse_args()
    run(args.raw, args.results, args.targets)


if __name__ == "__main__":
    main()
