from copy import deepcopy
import hashlib
import json
import zipfile

import numpy as np
import pytest

from tess_bench.external_catalog_candidate_regression import control_scenarios, load_review


def test_controlled_transitions_keep_ids_models_and_unrelated_values():
    catalog = dict(catalog_ready=True, tic_id=123, bundle_id=10,
        ai_score=.8, achievements=["untouched"], grade="untouched", candidates=[dict(
        candidate_id=100, tic_id=123, updated_bundle_id=10, status="active",
        period_days=2., epoch_btjd=1., duration_hours=2.)])
    before = deepcopy(catalog)
    result = control_scenarios(catalog, np.arange(0, 10, .01))
    assert len(result) == 9 and catalog == before
    for name in ("direct", "changed", "disappeared"):
        row = result[name]["rows"][0]
        assert row["candidate_id"] == 100
        assert row["representative_model"] == dict(period_days=2., epoch_btjd=1., duration_hours=2.)
        assert not {"ai_score", "achievements", "grade", "applied_at"} & row.keys()


def test_multi_signal_ids_are_not_row_order():
    catalog = dict(catalog_ready=True, tic_id=123, bundle_id=10, candidates=[
        dict(candidate_id=991, tic_id=123, updated_bundle_id=10, status="active",
             period_days=2., epoch_btjd=1., duration_hours=2.),
        dict(candidate_id=15, tic_id=123, updated_bundle_id=10, status="active",
             period_days=3.14159, epoch_btjd=.25, duration_hours=1.)])
    result = control_scenarios(catalog, np.arange(0, 30, .01))
    assert {r["candidate_id"] for r in result["direct"]["rows"]} == {991, 15}


def test_corrupt_zip_rejected_before_read(tmp_path):
    path = tmp_path / "test.zip"
    path.write_bytes(b"not a zip")
    with pytest.raises(ValueError, match="ZIP checksum"):
        load_review(path, "0"*64)


def test_member_hash_mismatch_rejected(tmp_path):
    path = tmp_path / "test.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("checksums.json", json.dumps({"catalog/proofs.json": "a"*64}))
        z.writestr("catalog/proofs.json", "[]")
    with pytest.raises(ValueError, match="member checksum"):
        load_review(path, hashlib.sha256(path.read_bytes()).hexdigest())
