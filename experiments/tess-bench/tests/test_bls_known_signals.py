import numpy as np

from astro_kernel import remove_transit_models
from tess_bench import bls


def _ref(**over):
    row = {"target_key": "toi270", "pl_name": "TOI-270 c", "pl_orbper": "5.66051", "pl_tranmid": "2458463.08056",
           "pl_trandur": "1.682", "pl_trandep": "0.3451844", "tran_flag": "1"}
    row.update(over)
    return row


def test_known_signal_models_builds_astro_kernel_json_and_skips_with_reason():
    rows = [_ref(), _ref(pl_name="L 98-59 e", target_key="l98_59", tran_flag="0"),
            _ref(pl_name="no-depth", pl_trandep=""), _ref(pl_name="bad", pl_trandur="200"),
            {"target_key": "cm_dra", "pl_name": "", "tran_flag": ""}, _ref(pl_name="other-star", target_key="wasp18")]
    models, skipped = bls.known_signal_models(rows, "toi270")
    assert [m["candidate_id"] for m in models] == ["TOI-270 c"]
    p = models[0]["parameters"]
    assert p["period_days"] == 5.66051 and p["epoch_btjd"] == 2458463.08056 - 2457000 and p["duration_hours"] == 1.682
    assert abs(p["depth_ppm"] - 3451.844) < 1e-6
    assert {s["pl_name"]: s["reason"] for s in skipped} == {"no-depth": "missing_period_epoch_duration_or_depth", "bad": "invalid_geometry"}
    # 다른 별·비통과·자리표시 행은 조용히 건너뛴다 (skipped 에도 없음)
    assert bls.known_signal_models(rows, "l98_59") == ([], [{"pl_name": "L 98-59 e", "reason": "not_transiting"}])


def test_models_are_accepted_by_astro_kernel_and_remove_the_signal():
    models, _ = bls.known_signal_models([_ref()], "toi270")
    t = np.arange(1460.0, 1487.0, 2 / 1440)
    p = models[0]["parameters"]
    phase = ((t - p["epoch_btjd"]) / p["period_days"] + 0.5) % 1.0 - 0.5
    flux = np.ones_like(t)
    flux[np.abs(phase * p["period_days"]) < 0.5 * p["duration_hours"] / 24] *= 1 - p["depth_ppm"] / 1e6
    r = remove_transit_models(t, flux, models)
    assert np.allclose(r.flux_residual, 1.0, atol=1e-12) and r.models[0].candidate_id == "TOI-270 c"
