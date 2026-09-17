"""write_checksums 는 내용이 같으면 추적 파일을 건드리지 않는다 (MR !45 리뷰 지적, S15P21C206-108 에서 수정)."""
import json
from pathlib import Path

from tess_fixture.download import load_expected_checksums, write_checksums


def _rec(name="a.fits", sha="0" * 64, **extra):
    row = {"filename": name, "source_uri": f"mast:{name}", "target_key": "t", "target_name": "T", "role": "raw_product",
           "tic_id": 1, "sector": 3, "size_bytes": 10, "sha256": sha, "procver": "p", "data_rel": 1, "camera": 1, "ccd": 1,
           "path": "/tmp/x", "cached": False}
    row.update(extra)
    return row


def test_rewriting_same_content_keeps_file_and_updated_at(tmp_path: Path):
    p = tmp_path / "checksums.json"
    assert write_checksums([_rec()], p) is True
    before = p.read_bytes()
    stamp = json.loads(before)["updated_at"]
    assert write_checksums([_rec()], p) is False                    # 같은 내용 → 쓰지 않음
    assert p.read_bytes() == before and json.loads(p.read_bytes())["updated_at"] == stamp
    # 다른 순서·여분 키(cached, path, sample_id)가 있어도 보존 키만 비교하므로 같다
    assert write_checksums([_rec(cached=True, sample_id="s")], p) is False
    assert p.read_bytes() == before


def test_changed_hash_or_new_file_rewrites_and_merges(tmp_path: Path):
    p = tmp_path / "checksums.json"
    write_checksums([_rec()], p)
    assert write_checksums([_rec(sha="1" * 64)], p) is True          # 해시 변경 → 새로 씀
    assert load_expected_checksums(p) == {"a.fits": "1" * 64}
    assert write_checksums([_rec(name="b.fits")], p) is True         # 새 파일 → 병합
    assert load_expected_checksums(p) == {"a.fits": "1" * 64, "b.fits": "0" * 64}
    payload = json.loads(p.read_text(encoding="utf-8"))
    assert [f["filename"] for f in payload["files"]] == ["a.fits", "b.fits"] and payload["schema"] == "planetory.fixture-checksums.v1"
