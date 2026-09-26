from tess_bench import tutorial_screening as t
from pathlib import Path
import json
import pytest


def test_eb_catalog_tampering_rejected(tmp_path,monkeypatch):
    path=tmp_path/'eb.csv'
    path.write_text('changed',encoding='utf-8')
    monkeypatch.setattr(t,'eb_catalog_path',lambda:path)
    with pytest.raises(ValueError,match='snapshot mismatch'): t.eb_selections()


def test_eb_plan_preserves_source_rows_without_assuming_timescale(tmp_path,monkeypatch):
    path=tmp_path/'eb.csv'
    path.write_text('tess_id,signal_id,sectors\n42,1,3\n',encoding='utf-8')
    monkeypatch.setattr(t,'eb_catalog_path',lambda:path)
    monkeypatch.setattr(t,'EB_CATALOG_SHA256',t.digest(path))
    monkeypatch.setattr(t,'EB_TICS',[42])
    row=t.eb_selections()[0]
    assert row['catalog_row']['signal_id']=='1'
    assert row['sectors']==[3] and 'unverified' in row['reference_use']
    path.write_text('tess_id,signal_id,sectors\n42,1,4\n',encoding='utf-8')
    monkeypatch.setattr(t,'EB_CATALOG_SHA256',t.digest(path))
    with pytest.raises(ValueError,match='selection mismatch'): t.eb_selections()

def test_targets_unique_and_original_fixture_preserved():
    rows=t.selections()
    assert len(rows)==25
    assert len({(r['tic_id'],r['sector']) for r in rows})==25
    assert sum(r['kind']=='multiple_fp_screening' for r in rows)==2


def test_combined_plan_has_exact_products_and_marks_extended_scope():
    rows=t.combined_selections()
    assert len(rows)==10
    assert len({r['tic_id'] for r in rows})==10
    extras=[r for r in rows if r['kind']=='multiple_fp_combined']
    assert {tuple(r['sectors']) for r in extras}=={(5,31),(4,31)}
    for row in extras:
        assert row['outside_initial_collection'] is True
        name,uri=t.product(row['tic_id'],31)
        assert f"-s0031-{row['tic_id']:016d}-" in name
        assert uri.endswith(name)


def test_literature_selection_stays_in_initial_sectors_and_is_not_a_label():
    rows=t.literature_selections()
    assert [r['sectors'] for r in rows]==[[3],[4],[5],[3,4,5]]
    assert {r['tic_id'] for r in rows}=={278956474}
    assert all(r['outside_initial_collection'] is False for r in rows)
    assert all('no verified epoch/duration' in r['reference_use'] for r in rows)

def test_missing_input_records_failure_without_implicit_download(tmp_path,monkeypatch):
    import pytest
    monkeypatch.setattr(t,'BENCH',tmp_path)
    monkeypatch.setattr(t,'FIXTURE',tmp_path/'fixture')
    monkeypatch.setattr(t,'digest',lambda p:'fixed')
    monkeypatch.setattr(t,'selections',lambda:[dict(key='test',tic_id=311183180,sector=5,kind='test')])
    monkeypatch.setattr(t,'download_product',lambda *a:pytest.fail('implicit network'))
    with pytest.raises(FileNotFoundError):t.run(False)
    files=list(tmp_path.glob('results/tutorial-screening/*/failure.json'))
    assert len(files)==1 and json.loads(files[0].read_text())['status']=='failed'
