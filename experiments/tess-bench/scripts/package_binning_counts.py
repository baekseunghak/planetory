"""Package saved 114 counts for review; never rerun preprocessing or binning."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path, PureWindowsPath
import zipfile

import numpy as np


VERIFY = '''import csv, hashlib, json
from pathlib import Path
p = Path(__file__).resolve().parent
m = json.loads((p / "manifest.json").read_text(encoding="utf-8"))
for name, digest in m["outputs"].items():
    assert hashlib.sha256((p / name).read_bytes()).hexdigest() == digest, name
rows = list(csv.DictReader((p / "segments.csv").open(encoding="utf-8")))
records = json.loads((p / "counts.json").read_text(encoding="utf-8"))
assert len(records) == 23
groups = {}
seen = set()
for record in records:
    key = (record["target"], record["sector"])
    assert key not in seen
    seen.add(key)
    a, b = record["mean"], record["median"]
    assert a == b
    assert all(type(x) is int and x >= 0 for x in a)
    for reducer, counts in [("mean", a), ("median", b)]:
        matches = [r for r in rows if r["target"] == key[0] and int(r["sector"]) == key[1]
                   and float(r["requested_minutes"]) == 10 and r["reducer"] == reducer]
        assert len(matches) == 1
        row = matches[0]
        assert float(row["actual_minutes"]) == 10
        assert len(counts) == int(row["n_points"])
        assert sum(counts) == int(row["n_kept"])
        assert counts.count(0) == int(row["n_empty"])
    values = [a.count(i) for i in range(1, 5)] + [sum(x >= 5 for x in a)]
    acc = groups.setdefault(key[0], [0] * 5)
    groups[key[0]] = [x + y for x, y in zip(acc, values)]
assert len(groups) == 9
groups["total"] = [sum(v[i] for v in groups.values()) for i in range(5)]
assert groups["total"] == [142, 204, 524, 2168, 65872]
for target, counts in groups.items():
    print(target, counts, sum(counts), [round(100*x/sum(counts), 4) for x in counts])
print("PASS: 23 sectors; mean/median equality; n_points/n_kept/n_empty; bundle checksums")
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source
    original = (source / "manifest.json").read_bytes()
    manifest = json.loads(original)
    expected = {PureWindowsPath(x["path"]).name: x["sha256"] for x in manifest["outputs"]}
    verified = {}

    def checked(name):
        data = (source / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected[name]:
            raise ValueError(f"source checksum mismatch: {name}")
        verified[name] = digest
        return data

    segments = checked("segments.csv")
    rows = list(csv.DictReader(io.StringIO(segments.decode("utf-8"))))
    selected = [r for r in rows if float(r["requested_minutes"]) == 10]
    assert len(selected) == 46
    records = {}
    for row in selected:
        assert float(row["actual_minutes"]) == 10
        with np.load(io.BytesIO(checked(row["array_file"])), allow_pickle=False) as data:
            counts = data["counts"]
            assert counts.ndim == 1 and np.issubdtype(counts.dtype, np.integer)
            assert np.all(counts >= 0)
            values = counts.tolist()
        assert len(values) == int(row["n_points"])
        assert sum(values) == int(row["n_kept"])
        assert values.count(0) == int(row["n_empty"])
        key = (row["target"], int(row["sector"]))
        record = records.setdefault(key, {"target": key[0], "sector": key[1]})
        assert row["reducer"] in ("mean", "median") and row["reducer"] not in record
        record[row["reducer"]] = values
    assert len(records) == 23
    for record in records.values():
        assert record["mean"] == record["median"]
    files = {
        "counts.json": json.dumps(list(records.values()), separators=(",", ":")).encode(),
        "segments.csv": segments,
        "source-manifest.json": original,
        "verify.py": VERIFY.encode(),
        "README.txt": (
            "114 counts-only review artifact. Extract and run: python verify.py\n"
            "Python standard library only; no FITS, flux, or model needed.\n"
            "Export checked all 46 source NPZ hashes against source-manifest.json.\n"
            "Original NPZ files are not included: their full hashes cannot be rechecked from this bundle.\n"
            "verify.py checks derived bundle hashes, reducer equality, CSV counts and the published table.\n"
            "Source manifest is historical; bundle manifest is a later export, not a new experiment.\n"
        ).encode(),
    }
    report = {"task": "S15P21C206-114", "source_manifest_sha256": hashlib.sha256(original).hexdigest(),
              "source_files_verified_at_export": verified,
              "outputs": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files["manifest.json"] = json.dumps(report, indent=2).encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    print(args.output.resolve())
    print("sha256:", hashlib.sha256(args.output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
