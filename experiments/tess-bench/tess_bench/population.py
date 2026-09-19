"""109 예비 측정: 고정 서비스 표본의 최초 BLS 게이트 통과 여부. 운영 판정 아님."""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from dataclasses import fields
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from tess_fixture.download import primary_header
from tess_fixture.lightcurve import build_baseline, load_sector
from tess_fixture.manifest import build_manifest, file_entry, new_run_id, write_manifest
from tess_fixture.service_sample import load_sample_config
from .bls import Peak, load_bls_settings, run_bls
from .preprocess import load_settings, preprocess

BENCH = Path(__file__).resolve().parents[1]
FIXTURE = BENCH.parent / "tess-fixture"
GATE = {"snr_min": 7.0, "sde_min": 6.0, "n_transits_min": 2}
STAR_FIELDS = ["tic_id", "sector", "group", "status", "reason", "n_raw", "n_valid",
               "n_kept", "n_gate_peaks", "period_min_days", "period_max_days", "wall_s"]
PEAK_FIELDS = ["tic_id", "sector", "group", "passes_gate"] + [f.name for f in fields(Peak)]


def passes_gate(peak):
    return bool(np.isfinite(peak.snr) and np.isfinite(peak.sde)
                and peak.snr >= GATE["snr_min"] and peak.sde >= GATE["sde_min"]
                and peak.n_transits >= GATE["n_transits_min"])


def summarize(rows):
    result = {}
    for group in sorted({r["group"] for r in rows}):
        selected = [r for r in rows if r["group"] == group]
        valid = [r for r in selected if r["status"] == "ok"]
        zero = sum(r["n_gate_peaks"] == 0 for r in valid)
        result[group] = {"selected": len(selected), "valid": len(valid),
                         "failed": len(selected) - len(valid), "no_gate_peak": zero,
                         "has_gate_peak": len(valid) - zero,
                         "no_gate_peak_fraction_valid": zero / len(valid) if valid else None}
    return result


def preflight(sample, members, raw_root, checksums):
    records = json.loads(checksums.read_text(encoding="utf-8"))["files"]
    expected = {r["filename"]: r for r in records}
    if len(expected) != len(records):
        raise ValueError("duplicate checksum filename")
    inputs = []
    for member in members:
        name = sample.filename(member)
        path = raw_root / str(member.tic_id) / name
        entry = file_entry(path, tic_id=member.tic_id, sector=member.sector, group=member.group)
        ref = expected.get(name)
        if ref is None or entry["sha256"] != ref["sha256"]:
            raise ValueError(f"checksum mismatch or missing reference: {name}")
        header = primary_header(path)
        if (int(header["TICID"]), int(header["SECTOR"])) != (member.tic_id, member.sector):
            raise ValueError(f"TIC/sector mismatch: {name}")
        if str(header.get("PROCVER", "")) != ref["procver"]:
            raise ValueError(f"PROCVER mismatch: {name}")
        entry["procver"] = ref["procver"]
        inputs.append(entry)
    return inputs


def measure(member, path, prep_setting, bls_setting):
    start = time.perf_counter()
    row = dict.fromkeys(STAR_FIELDS, "")
    row.update(tic_id=member.tic_id, sector=member.sector, group=member.group,
               status="failed", n_gate_peaks="")
    peaks, run = [], None
    try:
        curve = load_sector(path)
        baseline = build_baseline([curve], prep_setting.quality_bitmask)
        row.update(n_raw=baseline.n_raw, n_valid=baseline.n_valid)
        prep = preprocess(baseline.time, baseline.flux, baseline.sector_of_point, prep_setting)
        row["n_kept"] = int(prep.kept.sum())
        # Fallback/partial preprocessing must not silently enter the no-signal denominator.
        if prep.status != "ok" or prep.failures or row["n_kept"] < prep_setting.min_points:
            raise ValueError(f"preprocess: {prep.status}; kept={row['n_kept']}; {prep.failures}")
        run = run_bls(prep.time[prep.kept], prep.flux_det[prep.kept], bls_setting,
                      baseline_time=baseline.time, keep_periodogram=True)
        if not run.peaks or any(not np.isfinite(p.sde) or not np.isfinite(p.snr) for p in run.peaks):
            raise ValueError("empty or nonfinite BLS peaks")
        peaks = [{"tic_id": member.tic_id, "sector": member.sector, "group": member.group,
                  "passes_gate": passes_gate(p), **p.as_row()} for p in run.peaks]
        row.update(status="ok", n_gate_peaks=sum(p["passes_gate"] for p in peaks),
                   period_min_days=run.period_min_days, period_max_days=run.period_max_days)
    except ValueError as exc:
        row["reason"] = str(exc)
    row["wall_s"] = time.perf_counter() - start
    return row, peaks, run


def write_csv(path, rows, names):
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=names)
        writer.writeheader()
        writer.writerows(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="설정 순서의 첫 N개: 시간 측정용, 모집단 결론에 사용 금지")
    parser.add_argument("--sample-config", type=Path, default=FIXTURE / "configs/service_sample_v1.json")
    parser.add_argument("--raw-root", type=Path, default=FIXTURE / "sample_service")
    parser.add_argument("--checksums", type=Path, default=FIXTURE / "service_sample_checksums.json")
    parser.add_argument("--output-root", type=Path, default=BENCH / "results/population")
    args = parser.parse_args(argv)
    sample = load_sample_config(args.sample_config)
    if args.limit is not None and not 1 <= args.limit <= len(sample.members):
        parser.error("--limit must be between 1 and sample size")
    if len({m.tic_id for m in sample.members}) != len(sample.members):
        parser.error("v1 measures one Sector per TIC; multi-Sector aggregation is not implemented")
    if any(m.group not in ("random", "planet_host") for m in sample.members):
        parser.error("unsupported sample group")
    members = sample.members[:args.limit] if args.limit else sample.members
    prep_path = BENCH / "configs/preprocess_settings_v1.json"
    bls_path = BENCH / "configs/bls_settings_v1.json"
    prep_setting = load_settings(prep_path, ["biweight_1.0d"])[1][0]
    bls_setting = load_bls_settings(bls_path, ["poc_linear20k"])[1][0]
    inputs = preflight(sample, members, args.raw_root, args.checksums)
    code_paths = [Path(__file__), BENCH / "tess_bench/preprocess.py", BENCH / "tess_bench/bls.py",
                  FIXTURE / "tess_fixture/lightcurve.py", FIXTURE / "tess_fixture/service_sample.py",
                  FIXTURE / "tess_fixture/download.py", FIXTURE / "tess_fixture/manifest.py",
                  BENCH / "uv.lock", BENCH / "pyproject.toml", FIXTURE / "pyproject.toml"]
    inputs += [file_entry(p) for p in [args.sample_config, args.checksums, prep_path, bls_path, *code_paths]]
    run_id = new_run_id()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = args.output_root / f"run-{stamp}-{run_id[:8]}"
    out.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    rows, peaks, outputs = [], [], []
    print(f"preflight OK: {len(members)} files; preliminary; {out}", flush=True)
    for index, member in enumerate(members, 1):
        row, star_peaks, run = measure(member, args.raw_root / str(member.tic_id) / sample.filename(member),
                                       prep_setting, bls_setting)
        rows.append(row)
        peaks.extend(star_peaks)
        if run is not None:
            path = out / f"{member.tic_id}-s{member.sector}-periodogram.npz"
            np.savez_compressed(path, periods_days=run.periods, power=run.power)
            outputs.append(file_entry(path))
        # Preserve completed rows if a later unexpected error interrupts the run.
        write_csv(out / "stars.csv", rows, STAR_FIELDS)
        write_csv(out / "peaks.csv", peaks, PEAK_FIELDS)
        print(f"[{index}/{len(members)}] TIC {member.tic_id} {member.group}: {row['status']} "
              f"gate_peaks={row['n_gate_peaks']} {row['wall_s']:.1f}s {row['reason']}", flush=True)
    summary = {"preliminary": True, "subset": len(members) != len(sample.members),
               "groups": summarize(rows), "wall_s": time.perf_counter() - started}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    outputs += [file_entry(out / name) for name in ("stars.csv", "peaks.csv", "summary.json")]
    manifest = build_manifest("S15P21C206-109", "python -m tess_bench.population " +
                              " ".join(sys.argv[1:] if argv is None else argv), BENCH.parents[1], inputs,
                              {"name": "signal_population_preliminary_v1", "version": "1.0.0",
                               "sha256": file_entry(Path(__file__))["sha256"],
                               "sample_id": sample.sample_id, "sample_version": sample.version,
                               "members": [dict(tic_id=m.tic_id, sector=m.sector, group=m.group) for m in members],
                               "preprocess_setting_id": prep_setting.setting_id,
                               "preprocess": prep_setting.params(), "bls_setting_id": bls_setting.setting_id,
                               "bls": bls_setting.params(), "gate": GATE, **summary}, outputs,
                              notes="First-pass top-5 peaks only; not adopted candidates or discoverability. "
                              "random denominator excludes failed measurements; planet_host is separate. "
                              "No known-planet removal; 110/115/116 approval and tutorial selection remain pending.",
                              run_id=run_id, packages=("numpy", "scipy", "astropy"))
    write_manifest(manifest, out / "manifest.json")
    print(json.dumps(summary, ensure_ascii=False))
    print(f"manifest: {out / 'manifest.json'}")


if __name__ == "__main__":
    main()
