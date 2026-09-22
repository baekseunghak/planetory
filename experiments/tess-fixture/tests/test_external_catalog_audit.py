import csv
import io
import json

import pytest

from tess_fixture.external_catalog import collect
from tess_fixture.external_catalog_audit import FIELDS, audit


def bundle(tmp_path):
    names = iter(FIELDS)
    def fetch(url):
        name = next(names)
        fields = list(FIELDS[name]) + ["Comments"]
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerow({fields[0]: "259377017", fields[1]: "signal-a", "Comments": "excluded free text"})
        writer.writerow({fields[0]: "999", fields[1]: "outside-target"})
        return output.getvalue().encode(), {}
    return collect(tmp_path, fetch=fetch)


def test_checksum_and_target_projection_excludes_free_text(tmp_path):
    result = audit([bundle(tmp_path)])
    assert len(result["sources"]) == 4
    for item in result["sources"].values():
        assert item["total_rows"] == 2
        assert item["selected_rows"] == 1
        assert "Comments" not in item["rows"][0]
    assert "excluded free text" not in json.dumps(result)


def test_tampered_raw_is_rejected(tmp_path):
    path = bundle(tmp_path)
    (path.parent / "nea_toi.raw").write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum"):
        audit([path])


def test_duplicate_success_is_not_silently_overwritten(tmp_path):
    path = bundle(tmp_path)
    with pytest.raises(ValueError, match="duplicate"):
        audit([path, path])


def test_missing_source_is_not_complete(tmp_path):
    path = bundle(tmp_path)
    data = json.loads(path.read_text())
    data["sources"]["nea_toi"]["status"] = "failed"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="four successful"):
        audit([path])
