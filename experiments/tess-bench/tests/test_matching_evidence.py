import csv
import hashlib
import json

import pytest

from tess_bench.matching_evidence import APPROVED_CODE, audit, summarize


def fixture(tmp_path, *, validation_failed=0, step=0, period=5.0, count=2):
    common = dict(baseline_id="synthetic", group_id="g", setting_id="s")
    tables = {
        "steps": [dict(**common, status="accepted", step=0, period_days=period,
                       duration_hours=2, n_transits=count)],
        "iterations": [dict(**common, n_accepted=1, n_validation_failed=validation_failed)],
        "matches": [dict(**common, injection_id="truth", match="direct", recovered_step=step,
                         period_days=5, duration_hours=2)],
    }
    outputs = []
    for kind, rows in tables.items():
        path = tmp_path / f"{kind}.csv"
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        outputs.append(dict(kind=kind, path=str(path), rows=len(rows),
                            sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(dict(run_id="synthetic", code=dict(git_commit=APPROVED_CODE,
                    git_dirty=False), outputs=outputs)), encoding="utf-8")
    return path


def test_exact_signal_partial_metrics(tmp_path):
    run = audit(fixture(tmp_path))
    summary = summarize([run])["summary"]
    assert summary["recovered_signals_examined"] == summary["duration_pass"] == 1
    assert summary["period_pass_by_cap"] == dict.fromkeys(["5", "10", "20", "50", "uncapped"], 1)


def test_cap_sensitivity_does_not_label_full_match(tmp_path):
    run = audit(fixture(tmp_path, period=5.001, count=100))
    summary = summarize([run])["summary"]
    assert summary["period_pass_by_cap"]["uncapped"] == 0
    assert summary["period_pass_by_cap"]["5"] == 1
    assert "matched" not in run["measurements"][0]


def test_tampered_output_rejected(tmp_path):
    path = fixture(tmp_path)
    with (tmp_path / "steps.csv").open("a") as stream:
        stream.write("tampered")
    with pytest.raises(ValueError, match="checksum"):
        audit(path)


def test_dirty_source_rejected(tmp_path):
    path = fixture(tmp_path)
    data = json.loads(path.read_text())
    data["code"]["git_dirty"] = True
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="approved clean"):
        audit(path)


def test_failed_original_validation_not_used(tmp_path):
    run = audit(fixture(tmp_path, validation_failed=1))
    assert run["measurements"] == []
    assert run["skipped_recoveries_in_original_validation_failed_curves"] == 1


def test_missing_accepted_link_rejected(tmp_path):
    with pytest.raises(ValueError, match="accepted step"):
        audit(fixture(tmp_path, step=1))


@pytest.mark.parametrize("count", [0, -1, 1.5, float("nan")])
def test_invalid_transit_count_rejected(tmp_path, count):
    with pytest.raises(ValueError, match="invalid measured"):
        audit(fixture(tmp_path, count=count))


def test_duplicate_run_not_double_counted(tmp_path):
    run = audit(fixture(tmp_path))
    with pytest.raises(ValueError, match="duplicate run"):
        summarize([run, run])


def test_manifest_row_count_mismatch_rejected(tmp_path):
    path = fixture(tmp_path)
    data = json.loads(path.read_text())
    data["outputs"][0]["rows"] = 2
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="row count"):
        audit(path)


def test_curve_count_mismatch_rejected_even_with_valid_hash(tmp_path):
    path = fixture(tmp_path)
    csv_path = tmp_path / "iterations.csv"
    content = csv_path.read_text().replace("s,1,0", "s,2,0")
    csv_path.write_text(content)
    data = json.loads(path.read_text())
    data["outputs"][1]["sha256"] = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="accepted count"):
        audit(path)
