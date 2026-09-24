"""Candidate-local, append-only AI reevaluation. No inference runtime or persistence.

The caller serializes transitions (CAS/transaction), allocates DB identities, and
authorizes operational use separately. This module never publishes results.
"""
from copy import deepcopy
import hashlib
import json
import math


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def _text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("nonempty_identifier_required")
    return value


def _digest(value):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("sha256_required")
    return value


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError("finite_number_required")
    return value


def request(candidate_id, generation, *, model_version, checkpoint_sha256,
            input_version, input_sha256, score_semantics, threshold_version,
            lower, upper):
    """Build immutable-by-content intent; thresholds are caller supplied, not policy."""
    if type(candidate_id) is not int or not 0 < candidate_id < 2**63:
        raise ValueError("candidate_bigint_required")
    if type(generation) is not int or generation < 1:
        raise ValueError("positive_generation_required")
    if not 0 <= _number(lower) < _number(upper) <= 1:
        raise ValueError("invalid_thresholds")
    inference = dict(model_version=_text(model_version), checkpoint_sha256=_digest(checkpoint_sha256),
                     input_version=_text(input_version), input_sha256=_digest(input_sha256),
                     score_semantics=_text(score_semantics))
    return dict(candidate_id=candidate_id, generation=generation, inference=inference,
                threshold=dict(version=_text(threshold_version), lower=float(lower), upper=float(upper)))


def empty_history(candidate_id):
    if type(candidate_id) is not int or not 0 < candidate_id < 2**63:
        raise ValueError("candidate_bigint_required")
    return dict(candidate_id=candidate_id, revision=0, current=None, intents=[], attempts=[])


def reevaluate(history, intent, attempt_id, predict, *, expected_revision):
    """Return a copied ledger. predict(intent) returns score and JSON raw_output.

    Exact attempt retry or completed intent retry is a no-op. Failed attempts need
    a new attempt ID. A newer intent supersedes unfinished older intents, even if
    it fails. current continues to reference the last successful evaluation.
    """
    intent = deepcopy(intent)
    # Validate the entire shape instead of accepting hidden policy/mutable fields.
    canonical = request(intent['candidate_id'], intent['generation'],
                        **intent['inference'], threshold_version=intent['threshold']['version'],
                        lower=intent['threshold']['lower'], upper=intent['threshold']['upper'])
    if intent != canonical:
        raise ValueError("unexpected_intent_fields")
    _text(attempt_id)
    if history['candidate_id'] != intent['candidate_id']:
        raise ValueError("candidate_mismatch")
    if type(expected_revision) is not int or expected_revision != history['revision']:
        raise ValueError("stale_revision")
    fingerprint = _hash(intent)
    for attempt in history['attempts']:
        if attempt['attempt_id'] == attempt_id:
            if attempt['intent_sha256'] != fingerprint:
                raise ValueError("attempt_id_conflict")
            return deepcopy(history)
    previous_intents = history['intents']
    for previous in previous_intents:
        if previous['generation'] == intent['generation'] and previous != intent:
            raise ValueError("generation_conflict")
        if (previous['threshold']['version'] == intent['threshold']['version']
                and previous['threshold'] != intent['threshold']):
            raise ValueError("threshold_version_conflict")
    for attempt in history['attempts']:
        if attempt['intent_sha256'] == fingerprint and attempt['status'] == 'completed':
            return deepcopy(history)
    if previous_intents and intent['generation'] < max(i['generation'] for i in previous_intents):
        raise ValueError("superseded_intent")
    result = deepcopy(history)
    if intent not in previous_intents:
        result['intents'].append(intent)
    source = next((a for a in reversed(history['attempts'])
                   if a['status'] == 'completed' and a['inference'] == intent['inference']), None)
    attempt = dict(attempt_id=attempt_id, intent_sha256=fingerprint,
                   generation=intent['generation'], inference=deepcopy(intent['inference']),
                   threshold=deepcopy(intent['threshold']), status='failed', reason=None,
                   score=None, verdict=None, raw_output=None,
                   mode='reuse_score' if source else 'inference',
                   reused_from=source['attempt_id'] if source else None)
    try:
        output = dict(score=source['score'], raw_output=deepcopy(source['raw_output'])) if source else predict(deepcopy(intent))
        score = _number(output['score'])
        if not 0 <= score <= 1:
            raise ValueError('score_out_of_range')
        raw = deepcopy(output['raw_output'])
        _hash(raw)  # JSON-safe, finite raw output only.
        threshold = intent['threshold']
        verdict = 'rejected' if score < threshold['lower'] else 'approved' if score >= threshold['upper'] else 'hold'
        attempt.update(status='completed', score=float(score), raw_output=raw, verdict=verdict)
    except Exception as exc:
        # Do not leak input values or exception messages into execution history.
        attempt['reason'] = type(exc).__name__
    result['attempts'].append(attempt)
    result['revision'] += 1
    if attempt['status'] == 'completed':
        result['current'] = attempt_id
    return result
