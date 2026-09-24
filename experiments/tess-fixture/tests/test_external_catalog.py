import json

import pytest

from tess_fixture.external_catalog import collect, inspect_csv, sha256, source_requests


def test_preamble_bom_and_quoted_multiline_are_preserved():
    data = '\ufeff# delivery metadata\r\n\r\nid,note\r\n1,"first\r\n# still field"\r\n'.encode()
    assert inspect_csv(data) == {"columns": ["id", "note"], "row_count": 1, "preamble_lines": 2}


@pytest.mark.parametrize("data", [
    b"<html>error</html>", b"<?xml version='1.0'?><error/>",
    b"id,name\n", b"id,id\n1,2\n", b"id,\n1,2\n", b"id,name\n1,2,3\n",
    b'id,name\n1,"unfinished',
])
def test_unusable_export_is_not_accepted(data):
    import csv
    with pytest.raises((ValueError, csv.Error)):
        inspect_csv(data)


def test_failed_refresh_keeps_previous_run_and_records_all_sources(tmp_path):
    def success(url):
        return b"id,name\r\n1,example\r\n", {"final_url": url}
    first = collect(tmp_path, fetch=success)
    previous = {p: p.read_bytes() for p in first.parent.iterdir()}
    calls = 0

    def failure(url):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise TimeoutError()
        if calls == 3:
            return b"<html>unavailable</html>", {}
        return success(url)

    second = collect(tmp_path, fetch=failure)
    result = json.loads(second.read_text())
    assert calls == 4
    assert result["status"] == "incomplete"
    assert sum(s["status"] == "failed" for s in result["sources"].values()) == 2
    for p, content in previous.items():
        assert p.read_bytes() == content
    for item in result["sources"].values():
        if "file" in item:
            assert sha256((second.parent / item["file"]).read_bytes()) == item["sha256"]


def test_success_is_not_operational_validation(tmp_path):
    path = collect(tmp_path, fetch=lambda url: (b"id,value\n1,x\n", {}))
    manifest = json.loads(path.read_text())
    assert manifest["status"] == "collected_schema_unverified"
    assert len(manifest["sources"]) == 4
    assert len(manifest["target_tics"]) == 9
    assert all("retrieved_at" in item for item in manifest["sources"].values())
    assert not (tmp_path / "current.json").exists()


def test_query_scope_and_time_reference_are_explicit():
    from urllib.parse import parse_qs, urlsplit
    urls = source_requests()
    query = parse_qs(urlsplit(urls["nea_pscomppars"]).query)["query"][0]
    assert "pl_tranmid_systemref" in query
    assert "where tic_id in" in query
    assert "rowupdate" not in query
    assert "s0001-s0013" in urls["mast_tce_s1_s13"]


def test_subset_only_fetches_requested_sources(tmp_path):
    calls = []
    def fetch(url):
        calls.append(url)
        return b"id,value\n1,x\n", {}
    path = collect(tmp_path, fetch=fetch, sources=["nea_pscomppars", "exofop_toi"])
    manifest = json.loads(path.read_text())
    assert len(calls) == 2
    assert manifest["subset"] is True
    assert set(manifest["sources"]) == {"nea_pscomppars", "exofop_toi"}


def test_safe_transport_diagnostics():
    from urllib.error import HTTPError, URLError
    from tess_fixture.external_catalog import error_details
    assert error_details(HTTPError("private", 400, "private", {}, None)) == {
        "error_type": "HTTPError", "http_status": 400}
    assert error_details(URLError(OSError(11001, "private"))) == {
        "error_type": "URLError", "reason_type": "OSError", "errno": 11001}


def test_invalid_source_does_not_create_run(tmp_path):
    with pytest.raises(ValueError):
        collect(tmp_path, sources=["unknown"])
    assert not list(tmp_path.iterdir())


def test_sample_scope_requests_and_manifest(tmp_path):
    from urllib.parse import parse_qs, urlparse
    from tess_fixture.external_catalog import source_requests, collect
    import json
    urls=source_requests([176984144,439456714])
    query=parse_qs(urlparse(urls['nea_toi']).query)['query'][0]
    assert '176984144,439456714' in query
    def fetch(url): return b'tid,toi\n176984144,1.01\n',{}
    p=collect(tmp_path,fetch=fetch,sources=['nea_toi'],tic_ids=[176984144,439456714])
    manifest=json.loads(p.read_text())
    assert manifest['task']=='S15P21C206-109'
    assert manifest['target_tics']==['176984144','439456714']
    assert manifest['subset'] is True


def test_scope_rejects_duplicate_and_invalid_ids():
    from tess_fixture.external_catalog import source_requests
    import pytest
    for ids in [[],[1,1],[-1],['1) or 1=1'],[None]]:
        with pytest.raises(ValueError): source_requests(ids)
