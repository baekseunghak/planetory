import json
from types import SimpleNamespace

import numpy as np
import pytest

from tess_bench import discoverability as d


def config():
    return json.loads(d.CONFIG.read_text(encoding="utf-8"))


def periodogram():
    periods = np.geomspace(.5, 8, 9)
    power = np.array([0, 1, 0, 2, 9, 2, 0, 1, 0.])
    return SimpleNamespace(periods=periods, power=power, epoch_btjd=np.zeros(9),
                           duration_hours=np.ones(9) * 2, snr=np.ones(9) * 8, sde=np.ones(9) * 7)


def model():
    return dict(shape="box", parameters=dict(period_days=2., epoch_btjd=0., duration_hours=2., depth_ppm=1000.))


def test_direct_peak_and_observed_transits():
    pg, t = periodogram(), np.array([0, 2, 4, 6.])
    result = d.classify(pg, t, np.ones(4), model(), config())
    assert result["discoverable"] is True
    assert 4 in result["matched_grid_indices"]


@pytest.mark.parametrize("change", ["snr", "sde", "epoch", "empty"])
def test_bad_peak_does_not_match(change):
    pg, t, f = periodogram(), np.array([0, 2, 4, 6.]), np.ones(4)
    if change in ("snr", "sde"):
        getattr(pg, change)[:] = 0
    elif change == "epoch":
        pg.epoch_btjd[:] = .5
    else:
        f[:] = np.nan
    assert d.classify(pg, t, f, model(), config())["discoverable"] is False


def test_input_shortage_is_not_false():
    result, _, pg = d.evaluate(np.arange(10.), np.ones(10), [], model(), config(), np.geomspace(.5, 40, 100))
    assert pg is None
    assert result["status"] == "input_insufficient"
    assert result["discoverable"] is None


def test_degenerate_is_not_no_signal():
    result, _, _ = d.evaluate(np.arange(200.), np.ones(200), [], None, config(), np.geomspace(.5, 40, 100))
    assert result["status"] == "calculation_failed"
    assert result["reason"] == "degenerate_flux"


def test_provided_centers_and_exclusions():
    t, f, records = d.provided_curve(np.array([0, 2, 20, 30]) / 1440,
                                     np.array([1., 3, np.nan, 5]), np.ones(4), 10.)
    np.testing.assert_allclose(t * 1440, [5, 15, 25, 35])
    np.testing.assert_allclose(f, [2, np.nan, np.nan, 5], equal_nan=True)
    assert records[0]["gaps"] == [[1, 2]]


def test_no_auto_widening():
    with pytest.raises(ValueError, match="no automatic"):
        d.provided_curve(np.array([0., 200.]), np.ones(2), np.ones(2), 10.)


def test_no_plateau_or_endpoint_peaks():
    pg = periodogram()
    pg.power[:] = 10
    result = d.classify(pg, np.array([0., 2, 4]), np.ones(3), model(), config())
    assert result["qualified_peaks"] == []


def test_control_denominator_excludes_injections_and_failures():
    rows = [dict(control=True, stage="original", status="measured", qualified_peaks=[]),
            dict(control=True, stage="original", status="calculation_failed", qualified_peaks=[]),
            dict(control=False, stage="original", status="measured", qualified_peaks=[])]
    summary = d.summarize(rows)
    assert summary["control_total"] == 2
    assert summary["control_measured"] == 1
    assert summary["control_no_quality_peak_fraction"] == 1


def test_revision_changes_do_not_treat_missing_or_failure_as_false():
    old = dict(a=False, b=None, c=True)
    new = dict(a=True, b=True, c=True, new=True)
    assert [r["candidate_key"] for r in d.reevaluation_changes(old, new, "old", "new")] == ["a"]
    with pytest.raises(ValueError):
        d.reevaluation_changes(old, new, "same", "same")


def test_discovery_stage_uses_only_prior_models(monkeypatch):
    seen = []
    def fake_pg(t, f, periods, **kwargs):
        seen.append(f.copy())
        return periodogram()
    monkeypatch.setattr(d, "bls_periodogram", fake_pg)
    t, f = np.array([0., 2., 4.]), np.array([.999, .999, .999])
    d.evaluate(t, f, [], model(), config(), periodogram().periods)
    np.testing.assert_array_equal(seen[0], f)
    d.evaluate(t, f, [model()], None, config(), periodogram().periods)
    np.testing.assert_allclose(seen[1], np.ones(3))


@pytest.mark.parametrize("decisions", [(False, True), (False, False), (None, True)])
def test_probe_reports_measured_transition_only(monkeypatch, tmp_path, decisions):
    outcomes = iter(decisions)
    def fake_evaluate(t, f, previous, model, cfg, periods):
        return dict(discoverable=next(outcomes)), f, None
    monkeypatch.setattr(d, "evaluate", fake_evaluate)
    result = d.revision_probe(config(), tmp_path)
    assert bool(result["false_to_true"]) == (decisions == (False, True))
    assert len(list(tmp_path.glob("*.npz"))) == 2
