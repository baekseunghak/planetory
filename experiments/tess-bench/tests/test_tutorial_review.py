import json
import xml.etree.ElementTree as ET
import numpy as np
import pytest
from tess_bench.tutorial_review import checked_json, folded_svg
from tess_bench.population_kernel import digest


def test_checked_result_rejects_modification(tmp_path):
    path=tmp_path/'result.json'
    path.write_text(json.dumps({'status':'measured'}))
    expected=digest(path)
    assert checked_json(path,expected)['status']=='measured'
    path.write_text(json.dumps({'status':'held'}))
    with pytest.raises(ValueError,match='checksum mismatch'):
        checked_json(path,expected)


def test_fold_retains_finite_points_and_escapes_text():
    candidate=dict(period_days=4.,epoch_btjd=0.,duration_hours=2.,depth_ppm=1000.)
    t=np.array([0.,.01,1.9,-1.9])
    f=np.array([.999,np.nan,1.,1.])
    zoom=ET.fromstring(folded_svg(t,f,candidate,'A < B'))
    full=ET.fromstring(folded_svg(t,f,candidate,'A < B',True))
    ns={'s':'http://www.w3.org/2000/svg'}
    assert len(zoom.findall('s:circle',ns))==1
    assert len(full.findall('s:circle',ns))==3
    assert 'A < B' in ''.join(full.itertext())
