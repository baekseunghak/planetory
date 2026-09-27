"""Build the real TESS demo sample for `npm run dev:cinema` with the team's astro-kernel.

Per star, in pipeline order (libs/astro-kernel/README.md, distributed-system/spark):
  1. fits_adapter.parse_spoc_hdul               Bronze product -> SectorInput
  2. preprocessing.preprocess_silver            119 Silver (QUALITY=0, median norm, biweight 1 d)
  3. iteration.iterate_bls                      120/122 iterative BLS + removal QA (default gate)
  4. candidate_catalog.build_candidate_catalog  122 identity + demo IDs
  5. segmentation.segment_silver                123 10-minute Gold segments
  6. discoverability.prepare_discoverability    123 provided-resolution periodograms + discoverable
  7. discoverability.evaluate                   same rule on the other removal subsets
  8. gold_serialization.assemble                125 Gold projection check (labels from repo only)
Output: apps/frontend/.real-sample/{manifest.json, stars/<TIC>.json} (gitignored) and
tools/real-sample/.cache/report.json. Nothing here writes to Git, a DB or the network
(downloads live in fetch.py and only touch MAST).

Rerun:  see tools/real-sample/README.md
"""
import argparse
import hashlib
import itertools
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from stars import REFS, STARS, product_filename  # noqa: E402

OUT = ROOT / "apps/frontend/.real-sample"
CACHE = HERE / ".cache"
FORMAT = "planetory-real-sample-v1"
FINE_TUNE = {"half_width_cells": 3}
TOP_N = 10                      # operation rule peaks.top_n (V9 seed)
HARMONICS = [2.0, 0.5]          # operation rule matching.harmonic_multipliers minus 1 (V9 seed)
DEMO_APPROVAL = "planetory-cinema-demo-only (not a review approval)"
CANDIDATE_ID_BASE = 9007199254760000


# --------------------------------------------------------------------------- helpers

def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def r6(value):
    return None if value is None or not math.isfinite(value) else float(f"{value:.7g}")


def header_number(header, key):
    try:
        value = float(header.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def candidate_peaks(power, periods, *, half=3, top_n=TOP_N, harmonics=HARMONICS):
    """Port of backend CandidatePeaks.extract (float32 power, 2h+1 spacing, harmonic ranges)."""
    p32 = np.asarray(power, dtype=np.float32)
    n = len(p32)
    maxima = []
    for i in range(n):
        has_left, has_right = i > 0, i < n - 1
        above_left = has_left and p32[i] > p32[i - 1]
        above_right = has_right and p32[i] > p32[i + 1]
        if ((not has_left or above_left) and (not has_right or p32[i] >= p32[i + 1])
                and (above_left or above_right)):
            maxima.append(i)
    maxima.sort(key=lambda i: (-float(p32[i]), i))

    def reach(i):
        return periods[max(0, i - half)], periods[min(n - 1, i + half)]

    picked = []
    for i in maxima:
        if len(picked) >= top_n:
            break
        close = False
        for chosen in picked:
            if abs(i - chosen) < 2 * half + 1:
                close = True
                break
            low, high = reach(i)
            for m in harmonics:
                target = periods[chosen] * m
                slack = target * 1e-12
                if low - slack <= target <= high + slack:
                    close = True
                    break
            if close:
                break
        if not close:
            picked.append(i)
    return picked


def phase_distance(t, period, epoch):
    return (t - epoch + period / 2) % period - period / 2


# --------------------------------------------------------------------------- labels

def label_candidate(candidate, refs, start, end):
    """Repo facts only. Returns (label row | None, evidence dict)."""
    from astro_kernel.candidate_catalog import distance

    best = None
    for ref in refs:
        for multiple in [1.0] + ([ref["multiple"]] if ref.get("multiple") else []):
            period = candidate["period_days"] * multiple
            rel = abs(period - ref["period"]) / ref["period"]
            evidence = dict(ref=ref["label"], multiple=multiple, period_rel_error=rel, repo=ref["repo"])
            if ref.get("epoch") is not None and multiple == 1.0:
                a = dict(period_days=candidate["period_days"], epoch_btjd=candidate["epoch_btjd"],
                         duration_hours=candidate["duration_hours"])
                b = dict(period_days=ref["period"], epoch_btjd=ref["epoch"], duration_hours=ref["duration"])
                d = distance(a, b, start, end)
                ratio = max(a["duration_hours"], b["duration_hours"]) / min(a["duration_hours"], b["duration_hours"])
                evidence.update(identity_distance=d, duration_ratio=ratio,
                                rule="identity_distance<=0.5 and duration_ratio<=2 (124 RULE)")
                ok = d <= 0.5 and ratio <= 2.0
            else:
                evidence.update(rule="period-only, relative error <= 0.5%")
                ok = rel <= 0.005
            if ok and (best is None or rel < best[1]["period_rel_error"]):
                best = (ref, evidence)
    return best if best else (None, None)


# --------------------------------------------------------------------------- one star

def process(star, index):
    from astropy.io import fits

    from astro_kernel import candidate_catalog, discoverability, gold_serialization
    from astro_kernel.fits_adapter import parse_spoc_hdul
    from astro_kernel.iteration import iterate_bls
    from astro_kernel.preprocessing import preprocess_silver
    from astro_kernel.segmentation import segment_silver

    began = time.perf_counter()
    timings = {}

    def lap(name, since):
        timings[name] = round(time.perf_counter() - since, 2)
        return time.perf_counter()

    tic = star["tic"]
    names = [product_filename(tic, sector) for sector in star["sectors"]]
    digests = {name: sha256(CACHE / name) for name in names}
    report = dict(tic=tic, sectors=star["sectors"], role=star["role"], name=star["name"], why=star["why"],
                  files=digests)
    t0 = time.perf_counter()
    # 1. Bronze -> SectorInput per product (the kernel adapter does not open files; we do, memmap off).
    inputs, procvers, tmag = [], [], None
    for name in names:
        with fits.open(CACHE / name, memmap=False) as hdul:
            sector_input, meta = parse_spoc_hdul(hdul, product_id=name, source_sha256=digests[name])
            header = hdul[0].header
            tmag, teff, radius = (header_number(header, k) for k in ("TESSMAG", "TEFF", "RADIUS"))
        inputs.append(sector_input)
        procvers.append(str(meta["PROCVER"]))
    report.update(procver=sorted(set(procvers)), tmag=tmag, teff=teff, radius=radius)
    t0 = lap("fits", t0)
    # 2. Silver preprocessing (Sectors are detrended independently inside the kernel).
    prepared, detrended = preprocess_silver(inputs)
    report["preprocessing"] = dict(status=detrended.status, version=detrended.version,
                                   kept=int(detrended.kept.sum()), n_raw=int(prepared.n_raw))
    t0 = lap("preprocess", t0)
    if detrended.status != "ok":
        report.update(outcome="held", reason=f"preprocessing:{detrended.status}")
        return report, None
    snapshots = [f"{name}:sha256:{digests[name]}" for name in names]
    snapshot = "|".join(snapshots) if len(snapshots) > 1 else snapshots[0]
    # 3. Iterative BLS (default quality version, as the Spark 127 caller).
    iteration = iterate_bls(prepared.time, detrended.flux_det, sector=prepared.sector,
                            baseline_time=prepared.time, input_snapshot_id=snapshot,
                            preprocessing_version=detrended.version)
    report["iteration"] = dict(status=iteration["status"], termination=iteration["termination"],
                               quality_version=iteration["candidate_quality_version"],
                               accepted=[dict(step=c["step"], period_days=c["period_days"],
                                              epoch_btjd=c["epoch_btjd"], duration_hours=c["duration_hours"],
                                              depth_ppm=c["depth_ppm"], snr=c["snr"], sde=c["sde"],
                                              validated_on_original=c["validated_on_original"])
                                         for c in iteration["accepted"]],
                               steps=[{k: s.get(k) for k in ("step", "status", "reason", "period_days",
                                                             "qa_failures")} for s in iteration["steps"]])
    t0 = lap("iterate_bls", t0)
    # 4. Candidate catalog: first call names the IDs to allocate, second call uses them.
    bundle_id = 100 + index
    first = candidate_catalog.build_candidate_catalog(iteration, tic_id=tic, bundle_id=bundle_id)
    ids = {peak: CANDIDATE_ID_BASE + index * 100 + i + 1
           for i, peak in enumerate(first["needed_new_peak_ids"])}
    catalog = candidate_catalog.build_candidate_catalog(iteration, tic_id=tic, bundle_id=bundle_id,
                                                        new_candidate_ids=ids, identity_approval=DEMO_APPROVAL)
    report["catalog"] = dict(status=catalog["status"], reasons=catalog["reasons"],
                             n_proposed=len(catalog["proposed_candidates"]))
    t0 = lap("catalog", t0)
    # 5. Gold segments (10-minute mean bins of the detrended flux).
    segmented = segment_silver(prepared, detrended, snapshot_id=snapshot,
                               product_checksums=digests,
                               preprocessing_parameters=dict(kernel=detrended.version, interval_masks=[]))
    if segmented["quarantined"]:
        report.update(outcome="held", reason="segment_quarantined")
        return report, None
    t0 = lap("segment", t0)
    # 6. Provided-resolution discoverability (periodograms per removal stage).
    disc = discoverability.prepare_discoverability(
        segmented, catalog, fine_tune=FINE_TUNE,
        candidate_quality_version=iteration["candidate_quality_version"], rule_approval=DEMO_APPROVAL)
    report["discoverability"] = dict(status=disc["status"], reasons=disc["reasons"],
                                     evaluations=[{k: e.get(k) for k in ("candidate_id", "status", "reason",
                                                                         "discoverable", "matched_grid_indices")}
                                                  for e in disc["evaluations"]])
    t0 = lap("discoverability", t0)
    if disc["status"] != "ready":
        report.update(outcome="held", reason="discoverability:" + ",".join(disc["reasons"]))
        return report, None

    t, f, _ = discoverability.provided_arrays(segmented["segments"])
    pmax = disc["period_max_days"]
    periods = discoverability.period_grid(0.5, pmax, 5000, spacing="log")
    cell = math.log(pmax / 0.5) / 4999
    fold_reference = float(np.median(np.unique(prepared.time)))       # DAT-11 rule
    base_days = float(np.ptp(prepared.time))
    start, end = float(prepared.time[0]), float(prepared.time[-1])

    active = sorted((c for c in disc["proposed_candidates"] if c["status"] == "active"),
                    key=lambda c: c["removal_step"])
    exported = [c for c in active if c["discoverable"] is True]
    report["not_discoverable"] = [dict(candidate_id=c["candidate_id"], period_days=c["period_days"])
                                  for c in active if c["discoverable"] is not True]

    # Labels from repo facts (see stars.py), then a controlled 124-shaped result for 125.
    refs = REFS.get(tic, [])
    labels = {}
    for c in active:
        ref, evidence = label_candidate(c, refs, start, end)
        labels[c["candidate_id"]] = (ref, evidence)
    report["labels"] = {str(cid): dict(label=ref["label"] if ref else None, evidence=ev)
                        for cid, (ref, ev) in labels.items()}
    report["refs_unmatched"] = [r["label"] for r in refs
                                if not any(ref is r for ref, _ in labels.values())]

    # 7. Periodograms for every removal subset of the exported candidates (same rule).
    stage_pg = {}
    for c, artifact in zip([None, *active], disc["periodograms"]):
        removed = tuple(sorted(x["candidate_id"] for x in active
                               if c is not None and x["removal_step"] < c["removal_step"]))
        stage_pg[removed] = artifact["periodogram"]
    ids_exported = [c["candidate_id"] for c in exported]
    if len(exported) <= 4:
        subsets = [s for k in range(len(exported) + 1) for s in itertools.combinations(ids_exported, k)]
    else:
        subsets = [tuple(ids_exported[:k]) for k in range(len(ids_exported) + 1)]
        subsets += [(i,) for i in ids_exported[1:]]
    by_id = {c["candidate_id"]: c for c in active}
    periodograms, reused = [], 0
    for subset in subsets:
        key = tuple(sorted(subset))
        pg = stage_pg.get(key)
        if pg is not None:
            reused += 1
        else:
            models = [by_id[i]["transit_model"] for i in sorted(subset, key=lambda i: by_id[i]["removal_step"])]
            _, _, pg = discoverability.evaluate(t, f, models, None, periods)
        if pg is None:
            continue
        picked = candidate_peaks(pg.power, periods)
        peaks = []
        for rank, g in enumerate(picked, 1):
            p = float(periods[g])
            peaks.append(dict(rank=rank, gridIndex=int(g),
                              suggestedDurationHours=r6(float(pg.duration_hours[g])),
                              suggestedPhaseCenter=float((float(pg.epoch_btjd[g]) - fold_reference) / p % 1.0)))
        periodograms.append(dict(removedCandidateIds=[str(i) for i in key], periodMinDays=0.5,
                                 periodMaxDays=float(pmax), nPeriods=5000,
                                 power=[r6(float(v)) for v in pg.power], peaks=peaks,
                                 _pg=pg))
    report["periodograms"] = dict(count=len(periodograms), kernel_stage_reused=reused)
    t0 = lap("subset_periodograms", t0)

    # Link each exported candidate to the displayed peaks it produces (any stage it is live in).
    for c in exported:
        links = {}
        for item in periodograms:
            if str(c["candidate_id"]) in item["removedCandidateIds"]:
                continue
            pg = item["_pg"]
            for peak in item["peaks"]:
                g = peak["gridIndex"]
                for m in (1.0, 2.0, 0.5):
                    off = abs(math.log(periods[g] * m / c["period_days"])) / cell
                    if off > FINE_TUNE["half_width_cells"]:
                        continue
                    fold = min(periods[g], c["period_days"])
                    d = abs(phase_distance(float(pg.epoch_btjd[g]), fold, c["epoch_btjd"]))
                    if d <= max(float(pg.duration_hours[g]), c["duration_hours"]) / 48:
                        links.setdefault(g, m)
        c["_peaks"] = [dict(gridIndex=g, multiplier=m) for g, m in sorted(links.items())]

    # 8. Gold projection check.
    rows, refs_out = [], []
    for c in active:
        ref, evidence = labels[c["candidate_id"]]
        disposition = {"confirmed": "confirmed", "fp": "fp"}.get(ref["kind"], "pc") if ref else "none"
        truth = {"confirmed": "planet", "fp": "not_planet"}.get(disposition)
        rows.append(dict(candidate_id=c["candidate_id"], disposition=disposition,
                         answer_class="graded" if truth else "analysis", planet_truth=truth,
                         is_confirmed=disposition == "confirmed", rule_version="demo-repo-labels-v1",
                         source_refs=dict(repo=ref["repo"] if ref else None, evidence=evidence,
                                          decision_reason="repo_fact" if ref else "no_label"),
                         representative_model={k: c[k] for k in ("period_days", "epoch_btjd", "duration_hours")}))
        if ref:
            refs_out.append(dict(candidate_id=c["candidate_id"], tic_id=tic, source=ref["source"],
                                 external_id=ref["label"], disposition=ref["disposition"],
                                 period_days=ref["period"], epoch_btjd=ref.get("epoch"),
                                 fetched_on="2026-09-26"))
    external = dict(status="ready", reasons=[], tic_id=str(tic), bundle_id=bundle_id, rows=rows,
                    external_references=refs_out, history=[], matching_rule_version="demo-repo-labels-v1")
    original = periodograms[0]["_pg"]
    gold = gold_serialization.assemble(
        catalog=catalog, segmented=segmented, discovery=disc, external=external,
        periodogram=dict(candidate_id=None, periods=periods.tolist(), power=original.power.tolist()),
        segment_ids={str(s["sector"]): 5000 + index * 10 + k for k, s in enumerate(segmented["segments"])},
        input_snapshot_ids=snapshots,
        calculation_versions=dict(preprocessing=detrended.version, bls_config=iteration["bls_config_version"],
                                  residual_model="box-divide-v0", periodogram_config="provided-bls-1.0.0",
                                  candidate_quality=disc["candidate_quality_revision"],
                                  external_matching="demo-repo-labels-v1", ai_model="demo-not-executed",
                                  ai_threshold="demo-not-executed"),
        fold_reference_time_btjd=fold_reference, base_days=base_days,
        ai_policy=dict(status="policy_not_executed", decision_reference="planetory-cinema-demo",
                       model_version="demo-not-executed", threshold_version="demo-not-executed"),
        fine_tune=FINE_TUNE)
    report["gold"] = dict(status=gold["status"], reason=gold.get("reason"),
                          bundle_version=(gold["payload"] or {}).get("bundle", {}).get("bundle_version"))
    t0 = lap("gold", t0)

    # ------------------------------------------------------------ frontend payload
    segments = []
    for s in sorted(segmented["segments"], key=lambda s: s["start_btjd"]):
        segments.append(dict(sector=s["sector"], startBtjd=s["start_btjd"], binMinutes=s["bin_minutes"],
                             flux=[None if v is None else round(v, 7) for v in s["flux"]],
                             fluxScatter=r6(s["flux_scatter"])))
    candidates = []
    for c in exported:
        ref, evidence = labels[c["candidate_id"]]
        period = c["period_days"]
        epoch = c["epoch_btjd"] + math.ceil((start - c["epoch_btjd"]) / period - 1e-9) * period
        item = dict(candidateId=str(c["candidate_id"]),
                    kind=ref["kind"] if ref else "candidate",
                    periodDays=period, epochBtjd=epoch, durationHours=c["duration_hours"],
                    depthPpm=c["depth_ppm"], removalStep=c["removal_step"], snr=r6(c["snr"]),
                    peaks=c["_peaks"])
        if ref:
            item.update(externalLabel=ref["label"], externalSource=ref["source"],
                        externalDisposition=ref["disposition"],
                        labelEvidence=f"{ref['repo']}; {evidence['rule']}")
            if ref.get("planet"):
                item.update(planetName=ref["planet"], radiusEarth=ref.get("radius_earth"),
                            discoveryYear=ref.get("year"))
        candidates.append(item)
    for item in periodograms:
        item.pop("_pg")
    payload = dict(ticId=str(tic), role=star["role"], displayName=star["name"], tmag=tmag, teffK=teff,
                   radiusRsun=radius, sectors=sorted({s["sector"] for s in segments}),
                   foldReferenceTimeBtjd=fold_reference, segments=segments,
                   periodograms=periodograms, candidates=candidates,
                   rules=dict(harmonics=HARMONICS),
                   provenance=dict(products=digests, procver=report["procver"],
                                   preprocessing=detrended.version,
                                   bls=iteration["bls_config_version"],
                                   quality=iteration["candidate_quality_version"],
                                   discoverability=discoverability.RULE["version"],
                                   candidateQualityRevision=disc["candidate_quality_revision"],
                                   gold=report["gold"]["status"]))
    if star["role"] == "tutorial":
        payload["tutorialSeq"] = star["seq"]
    report.update(outcome="exported" if candidates else "no_discoverable_candidate",
                  exported_candidates=[dict(id=c["candidateId"], kind=c["kind"], period=c["periodDays"],
                                            depth_ppm=c["depthPpm"], duration_h=c["durationHours"],
                                            label=c.get("externalLabel"), peaks=len(c["peaks"]))
                                       for c in candidates])
    report["seconds"] = round(time.perf_counter() - began, 1)
    report["timings"] = timings
    return report, payload if candidates else None


def run_one(args):
    star, index = args
    try:
        return process(star, index)
    except Exception as exc:  # report and continue with the other stars
        import traceback
        return dict(tic=star["tic"], role=star["role"], name=star["name"], outcome="error",
                    reason=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()), None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--only", type=int, nargs="*", help="TIC ids to process (default: all)")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    missing = [(s["tic"], x) for s in STARS for x in s["sectors"]
               if not (CACHE / product_filename(s["tic"], x)).exists()]
    if missing:
        sys.exit(f"{len(missing)} FITS files missing in {CACHE}; run fetch.py first")
    jobs = [(s, i) for i, s in enumerate(STARS) if not args.only or s["tic"] in args.only]
    began = time.perf_counter()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run_one, jobs))
    wall = time.perf_counter() - began
    reports = [r for r, _ in results]
    payloads = [p for _, p in results if p is not None]
    for r in reports:
        print(f"{r['tic']:>10} {r['role']:<8} {r['name']:<16} {r['outcome']:<26} {r.get('reason') or ''}"
              f" {r.get('seconds', '')}s", flush=True)
    # Galaxy order: tutorials by seq, then explore stars with a labelled planet first.
    def order(p):
        if p["role"] == "tutorial":
            return (0, p["tutorialSeq"], 0)
        kinds = {c["kind"] for c in p["candidates"]}
        return (1, 0 if "confirmed" in kinds else 1 if "candidate" in kinds else 2,
                [s["tic"] for s in STARS].index(int(p["ticId"])))
    payloads.sort(key=order)
    args.out.mkdir(parents=True, exist_ok=True)
    stars_dir = args.out / "stars"
    stars_dir.mkdir(exist_ok=True)
    for old in stars_dir.glob("*.json"):
        old.unlink()
    for p in payloads:
        (stars_dir / f"{p['ticId']}.json").write_text(json.dumps(p, separators=(",", ":"), allow_nan=False),
                                                     encoding="utf-8")
    from astro_kernel.discoverability import RULE as DISCOVERABILITY_RULE
    manifest = dict(format=FORMAT, generatedAt=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    source=("MAST SPOC 2-min LC (Sectors 2-5, spoc-5.0.x) -> libs/astro-kernel "
                            f"(silver-biweight-1.0.0, bls_grid_v1 gate_v1, {DISCOVERABILITY_RULE['version']}); "
                            "labels: repo references only"),
                    stars=[{k: v for k, v in dict(ticId=p["ticId"], role=p["role"], tutorialSeq=p.get("tutorialSeq"),
                                                  displayName=p["displayName"]).items() if v is not None}
                           for p in payloads])
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    (CACHE / "report.json").write_text(json.dumps(dict(wall_seconds=round(wall, 1), workers=args.workers,
                                                       stars=reports), indent=1, default=str), encoding="utf-8")
    size = sum(p.stat().st_size for p in stars_dir.glob("*.json"))
    print(f"exported {len(payloads)} stars to {args.out} ({size / 1e6:.1f} MB), wall {wall:.0f}s", flush=True)


if __name__ == "__main__":
    main()
