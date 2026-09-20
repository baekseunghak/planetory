import pytest
from astronet_eval.metrics import binary_metrics, summarize


def test_ties_are_grouped_and_ap_is_not_trapezoidal_auc():
    report = binary_metrics([0.5], [0.5], [0.5, 0.6])
    assert report['average_precision'] == .5
    assert report['pr_auc_trapezoid'] == .75
    assert report['thresholds'][0] == dict(threshold=.5, tp=1, fp=1, tn=0, fn=0, recall=1., precision=.5)
    assert report['thresholds'][1]['precision'] is None
    assert binary_metrics([], [.1], [.5])['average_precision'] is None


def row(cid, label='PC', status='ok', score='.8', truth='true'):
    return dict(candidate_id=cid, split='calibration', label=label, in_truth=truth,
                status=status, reason='missing_geometry' if status != 'ok' else '', score=score)


def test_unverified_excluded_failures_preserved_and_eb_is_positive():
    report = summarize([row('pc'), row('eb', 'EB'), row('noise', 'junk', score='.1'),
                        row('u', 'junk_unverified', truth='false'),
                        row('failed', status='input_incomplete', score='')], [.4])
    assert report['success_n'] == 4 and report['total_n'] == 5
    assert report['binary_scored_only']['n_positive'] == 2
    assert report['binary_scored_only']['n_negative'] == 1
    assert report['by_label']['PC']['failures'] == {'input_incomplete:missing_geometry': 1}


@pytest.mark.parametrize('bad', [row('x', score='nan'), row('x', score='1.1'),
    row('x', truth='false'), row('x', status='input_incomplete', score='0'),
    {**row('x'), 'split':'evaluation'}])
def test_rejects_invalid_inputs(bad):
    with pytest.raises(ValueError):
        summarize([bad], [.4])


def test_rejects_duplicate_candidates():
    with pytest.raises(ValueError):
        summarize([row('x'), row('x')], [.4])


def test_evaluation_bands_include_review_not_automatic_rejection():
    rows = [{**row('pc', score='.2'), 'split':'evaluation', 'decision_band':'review'},
            {**row('noise', 'junk', score='.6'), 'split':'evaluation', 'decision_band':'approved'}]
    plan = {'lower':0, 'upper':.3}
    report = summarize(rows, [.3], 'evaluation', plan)
    assert report['by_label']['PC']['bands'] == {'review':1}
    assert report['binary_scored_only']['thresholds'][0]['fn'] == 1
    assert report['binary_scored_only']['thresholds'][0]['fp'] == 1
    rows[0]['decision_band'] = 'below'
    with pytest.raises(ValueError, match='band'):
        summarize(rows, [.3], 'evaluation', plan)
