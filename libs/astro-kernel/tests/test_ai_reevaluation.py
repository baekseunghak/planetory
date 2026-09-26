from copy import deepcopy
import pytest

from astro_kernel.ai_reevaluation import empty_history, request, reevaluate


def intent(generation=1, **changes):
    args = dict(model_version='model-1', checkpoint_sha256='a'*64,
                input_version='input-1', input_sha256='b'*64,
                score_semantics='PC/EB versus junk', threshold_version='fixture-1',
                lower=.2, upper=.8)
    args.update(changes)
    return request(91, generation, **args)


def run(state, wanted, attempt='a', predict=None):
    return reevaluate(state, wanted, attempt,
                      predict or (lambda _: dict(score=.7, raw_output={'triage': .7})),
                      expected_revision=state['revision'])


def forbidden(_):
    raise AssertionError('must not infer')


def test_threshold_only_reuses_and_preserves_prior_state():
    original = empty_history(91)
    first = run(original, intent())
    snapshot = deepcopy(first)
    second = run(first, intent(2, threshold_version='fixture-2', upper=.6), 'b', forbidden)
    assert first == snapshot and original == empty_history(91)
    assert second['attempts'][0] == first['attempts'][0]
    assert second['attempts'][0]['verdict'] == 'hold'
    assert second['attempts'][1]['verdict'] == 'approved'
    assert second['attempts'][1]['reused_from'] == 'a'
    assert second['current'] == 'b'
    assert second['attempts'][1]['raw_output'] == {'triage': .7}


@pytest.mark.parametrize('change', [dict(model_version='model-2'), dict(checkpoint_sha256='c'*64),
    dict(input_version='input-2'), dict(input_sha256='d'*64), dict(score_semantics='new semantics')])
def test_inference_identity_changes_call_predictor(change):
    first = run(empty_history(91), intent())
    calls = []
    def predict(value):
        calls.append(value)
        return dict(score=.9, raw_output=[.9])
    second = run(first, intent(2, **change), 'b', predict)
    assert len(calls) == 1
    assert second['attempts'][-1]['mode'] == 'inference'
    assert second['attempts'][-1]['score'] == .9


@pytest.mark.parametrize('bad', [None, 0/1 - 1, 1.01, float('nan'), float('inf'), True])
def test_invalid_score_failure_then_retry_preserves_old_success(bad):
    first = run(empty_history(91), intent())
    wanted = intent(2, model_version='new')
    failed = run(first, wanted, 'b', lambda _: dict(score=bad, raw_output={}))
    assert failed['current'] == 'a'
    assert failed['attempts'][-1]['score'] is None
    assert failed['attempts'][-1]['status'] == 'failed'
    assert run(failed, wanted, 'b', forbidden) == failed
    recovered = run(failed, wanted, 'retry')
    assert recovered['current'] == 'retry'
    assert recovered['attempts'][:2] == failed['attempts']
    assert run(recovered, wanted, 'another', forbidden) == recovered


@pytest.mark.parametrize('score,verdict', [(0., 'rejected'), (.2, 'hold'), (.8, 'approved'), (1., 'approved')])
def test_zero_and_inclusive_boundaries(score, verdict):
    result = run(empty_history(91), intent(), predict=lambda _: dict(score=score, raw_output=score))
    assert result['attempts'][0]['status'] == 'completed'
    assert result['attempts'][0]['verdict'] == verdict


def test_failure_message_not_exposed_and_superseded_retry_blocked():
    def fail(_):
        raise RuntimeError('private input path')
    first = run(empty_history(91), intent(), predict=fail)
    assert first['current'] is None
    assert first['attempts'][0]['reason'] == 'RuntimeError'
    second = run(first, intent(2, model_version='new'), 'b', fail)
    with pytest.raises(ValueError, match='superseded'):
        run(second, intent(), 'retry')


def test_conflicting_identifiers_and_stale_revision_rejected():
    first = run(empty_history(91), intent())
    with pytest.raises(ValueError, match='attempt_id_conflict'):
        run(first, intent(2), 'a')
    with pytest.raises(ValueError, match='generation_conflict'):
        run(first, intent(1, model_version='new'), 'b')
    with pytest.raises(ValueError, match='threshold_version_conflict'):
        run(first, intent(2, upper=.9), 'b')
    with pytest.raises(ValueError, match='stale_revision'):
        reevaluate(first, intent(2), 'b', forbidden, expected_revision=0)


def test_old_completed_trigger_cannot_restore_previous_current():
    first = run(empty_history(91), intent())
    second = run(first, intent(2, model_version='new'), 'b')
    assert run(second, intent(), 'delayed', forbidden) == second


def test_caller_fields_and_mutable_output_are_not_modified():
    protected = dict(achievements=['a'], grade='g', disposition='pc', completed_stars=[1])
    snapshot = deepcopy(protected)
    raw = {'values': [.7]}
    state = run(empty_history(91), intent(), predict=lambda _: dict(score=.7, raw_output=raw))
    raw['values'].append(1)
    assert state['attempts'][0]['raw_output'] == {'values': [.7]}
    assert protected == snapshot
    assert set(state) == {'candidate_id', 'revision', 'current', 'intents', 'attempts'}
    with pytest.raises(ValueError, match='unexpected_intent_fields'):
        run(state, dict(intent(2), reopen=True), 'b')


@pytest.mark.parametrize('changes', [dict(checkpoint_sha256='bad'), dict(lower=.9, upper=.8),
    dict(lower=True), dict(input_version=''), dict(upper=float('nan'))])
def test_invalid_request(changes):
    with pytest.raises(ValueError):
        intent(**changes)


def test_candidate_mismatch():
    with pytest.raises(ValueError, match='candidate_mismatch'):
        run(empty_history(92), intent())
