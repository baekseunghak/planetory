import csv
import hashlib
import itertools
import json

import pytest

from tess_bench.sde_review_summary import summarize


def fixture_run(folder, duplicate=False):
    rows = [dict(target='star', baseline='realclean', group='single', method=m,
                 dy=d, threshold=t, control='False', signals_in_range=1,
                 direct=int(m == 'running_median'), alias=0, selected_peaks=1)
            for m, d, t in itertools.product(
                ['global', 'running_median', 'log_bins'], ['global', 'local', 'global_exact'],
                ['ungated', '2.0', '3.0', '4.0', '5.0', '6.0', '8.0', '10.0', '12.0'])]
    if duplicate:
        rows[-1] = rows[0]
    with (folder / 'comparisons.csv').open('w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=rows[0])
        writer.writeheader()
        writer.writerows(rows)
    (folder / 'plan.json').write_text('{}')
    (folder / 'peaks.csv').write_text('rank\n1\n')
    entries = [dict(path='C:/original/pc/' + name,
                    sha256=hashlib.sha256((folder / name).read_bytes()).hexdigest())
               for name in ['plan.json', 'comparisons.csv', 'peaks.csv']]
    (folder / 'manifest.json').write_text(json.dumps(dict(status='completed', subset=False,
        curves=1, comparison_rows=81, plan=entries[0], outputs=entries[1:])))


def test_portable_recount_and_paired_gain(tmp_path):
    fixture_run(tmp_path)
    result = summarize(tmp_path)
    assert result['paired_curves'][0]['direct_delta'] == 1
    assert result['comparison_rows'] == 81


def test_corrupt_csv_rejected(tmp_path):
    fixture_run(tmp_path)
    with (tmp_path / 'comparisons.csv').open('a') as handle:
        handle.write('\n')
    with pytest.raises(ValueError, match='checksum_mismatch'):
        summarize(tmp_path)


def test_duplicate_comparison_rejected_even_with_valid_hash(tmp_path):
    fixture_run(tmp_path, duplicate=True)
    with pytest.raises(ValueError, match='duplicate_comparison'):
        summarize(tmp_path)
