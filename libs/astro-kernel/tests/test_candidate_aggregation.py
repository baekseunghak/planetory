"""79 후보 집계: 완전·누락·요청 실패·중복 fixture 의 count·key 와 manifest 스키마를 검사한다.

외부 상태는 실제 124 `build_snapshot`·`join_catalog` 출력을 쓰고, 번들 검증은 125 `assemble` 이 한다.
ID·라벨·버전 문자열은 합성값이며 운영 할당·채택값이 아니다.
"""
import json
from copy import deepcopy
from pathlib import Path

import numpy as np
from jsonschema import Draft202012Validator

import pytest

from astro_kernel.candidate_aggregation import (AI_NOT_EXECUTED, AI_POLICY, STATUSES, aggregate, combine,
                                                evaluate)
from astro_kernel.external_catalog import build_snapshot, join_catalog
from astro_kernel.gold_serialization import GoldValidationError

SCHEMA = json.loads((Path(__file__).resolve().parents[3] / "contracts" / "gold"
                     / "publication-candidates.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA)
SOURCES = ("archive", "toi")
TIMES = np.arange(0, 10, .01)
VERSIONS = dict(preprocessing="pre-v1", bls_config="search-v1", residual_model="box-divide-v0",
                periodogram_config="provided-v1",
                ai_model=AI_NOT_EXECUTED, ai_threshold=AI_NOT_EXECUTED,
                external_matching="external-match-review-v1")
POLICY = AI_POLICY


def candidate(tic, bundle, cid, period, step):
    params = dict(period_days=period, epoch_btjd=1., duration_hours=2., depth_ppm=1000.)
    model = dict(candidate_id=f"c-{cid}", shape="box", baseline={"kind": "unity"},
                 residual_model_version="box-divide-v0", parameters=params)
    return dict(candidate_id=cid, tic_id=tic, updated_bundle_id=bundle, status="active",
                removal_step=step, **params, bls_power=12., transit_model=model, discoverable=True)


def delivery(source, tic, rows, **overrides):
    args = dict(source=source, scope=[str(tic)], rows=rows, raw_sha256="a" * 64,
                retrieved_at="2026-09-22T00:00:00Z", source_uri="https://example.org/catalog",
                source_table=source, time_evidence="fixture:explicit-TDB", complete=True, validated=True)
    args.update(overrides)
    return build_snapshot(**args)


def star(tic, cands, labels, **delivery_overrides):
    """cands: [(candidate_id, period)], labels: {source: {candidate_id: raw label}}."""
    bundle = tic * 10
    cs = [candidate(tic, bundle, cid, period, step) for step, (cid, period) in enumerate(cands)]
    catalog = dict(tic_id=tic, bundle_id=bundle, catalog_ready=True, complete=True, candidates=deepcopy(cs))
    deliveries = {s: delivery(s, tic, [dict(tic_id=str(tic), external_id=f"{s}-{c['candidate_id']}",
        period_days=c["period_days"], epoch_btjd=1., duration_hours=2., time_system="BTJD-TDB",
        raw_disposition=labels[s][c["candidate_id"]], source_row_updated_at="2026-09-01")
        for c in cs if c["candidate_id"] in labels.get(s, {})], **delivery_overrides.get(s, {}))
        for s in SOURCES}
    segment = dict(tic_id=tic, sector=3, binning_revision="bin-v1-fixture", start_btjd=0., bin_minutes=10.,
                   n_points=3, flux=[1., None, .999], flux_scatter=.01, gaps=[[1, 1]])
    return dict(tic_id=tic, inputs=dict(
        catalog=catalog, segmented=dict(segments=[segment], quarantined=[]),
        discovery=dict(status="ready", discoverability_ready=True, tic_id=tic, bundle_id=bundle,
                       candidate_quality_revision="quality-v1", proposed_candidates=deepcopy(cs)),
        external=join_catalog(catalog, deliveries, TIMES, required_sources=list(SOURCES), approval="fixture-only"),
        periodogram=dict(candidate_id=None, periods=np.geomspace(.5, 40., 5000).tolist(), power=[1.] * 5000),
        segment_ids={"3": bundle + 1}, input_snapshot_ids=[f"lc:spoc:s0003:sha256:{'b' * 64}:procver:fixture"],
        fold_reference_time_btjd=1., base_days=3., fine_tune=dict(half_width_cells=3)))


def no_signal(tic, previous=()):
    """122 hold without representatives; candidates carries the previous bundle's candidates."""
    return dict(tic_id=tic, inputs=dict(catalog=dict(tic_id=tic, bundle_id=tic * 10, status="held",
        catalog_ready=False, complete=True, candidates=list(previous), reasons=["no_candidates_publication_held"])))


def run(results, targets=None, **overrides):
    args = dict(run_id="run-fixture", silver_attempt="silver/pipeline_version=fixture/run_id=run-fixture",
                targets=targets if targets is not None else [r["tic_id"] for r in results],
                results=results, calculation_versions=VERSIONS, ai_policy=POLICY)
    args.update(overrides)
    out = aggregate(**args)
    VALIDATOR.validate(out)
    return out


def ambiguous(tic):
    s = star(tic, [(tic + 1, 2.)], {"toi": {tic + 1: "CP"}})
    rows = s["inputs"]["external"]["snapshots"]["toi"]["rows"]
    extra = dict(rows[0], external_id="toi-dup")
    catalog = s["inputs"]["catalog"]
    s["inputs"]["external"] = join_catalog(catalog, {"toi": delivery("toi", tic, rows + [extra]),
        "archive": delivery("archive", tic, [])}, TIMES, required_sources=list(SOURCES), approval="fixture-only")
    return s


def test_mixed_run_counts_every_target_and_traces_lineage():
    results = [star(101, [(1011, 2.), (1012, 5.3)], {"toi": {1011: "CP"}}),
               no_signal(102), ambiguous(103),
               star(104, [(1041, 2.)], {"archive": {1041: ""}})]
    results[3]["inputs"]["discovery"]["proposed_candidates"][0]["discoverable"] = False
    before = deepcopy(results)
    out = run(results)
    assert results == before
    m = out["manifest"]
    assert out["status"] == "complete" and m["complete"] is True and out["publishable"] is False
    assert m["counts"] == dict(ready=2, no_signal=1, held=1, request_failed=0, rejected=0, unprocessed=0)
    assert sum(m["counts"].values()) == m["target_tic_count"] == 4
    held = next(s for s in m["stars"] if s["tic_id"] == 103)
    assert held["reasons"] == ["external:toi:matching_held"]
    assert next(s for s in m["stars"] if s["tic_id"] == 102)["reasons"] == ["catalog:no_candidates_publication_held"]

    assert [(r["tic_id"], r["candidate_id"]) for r in out["candidates"]] == [(101, 1011), (101, 1012), (104, 1041)]
    assert m["candidate_count"] == len(out["candidates"]) == sum(b["active_candidates"] for b in m["bundles"])
    assert m["discoverable_ready_tic_count"] == 1  # 104 has only a non-discoverable candidate
    by_id = {r["candidate_id"]: r for r in out["candidates"]}
    labeled, missing, empty = by_id[1011], by_id[1012], by_id[1041]
    toi = next(s for s in labeled["external"]["sources"] if s["source"] == "toi")
    assert (toi["match"], toi["external_id"], toi["raw_disposition"]) == ("direct_match", "toi-1011", "CP")
    assert toi["retrieved_at"] == "2026-09-22T00:00:00Z" and toi["source_row_updated_at"] == "2026-09-01"
    snapshot = results[0]["inputs"]["external"]["snapshots"]["toi"]
    assert (toi["snapshot_id"], toi["snapshot_sha256"]) == (snapshot["snapshot_id"], snapshot["sha256"])
    assert (labeled["external"]["state"], labeled["external"]["disposition"]) == ("labeled", "confirmed")
    # Complete sources with no row are absence, not failure: the candidate stays with state missing.
    assert missing["external"]["state"] == "missing" and missing["external"]["disposition"] == "none"
    assert {s["match"] for s in missing["external"]["sources"]} == {"unmatched"}
    archive = next(s for s in empty["external"]["sources"] if s["source"] == "archive")
    assert archive["match"] == "direct_match" and archive["raw_disposition"] == ""
    assert empty["external"]["state"] == "missing"

    bundle = next(b for b in out["bundles"] if b["bundle"]["tic_id"] == 101)["bundle"]
    assert labeled["bundle_version"] == bundle["bundle_version"]
    assert m["bundles"][0]["record_checksums"] == bundle["manifest"]["record_checksums"]
    assert labeled["ai"] == dict(POLICY, score=None) and m["calculation_versions"] == VERSIONS
    assert labeled["transit_model"]["candidate_id"] == "c-1011"


def test_request_failure_and_unprocessed_keep_run_open():
    failed = star(201, [(2011, 2.)], {"toi": {2011: "CP"}}, toi=dict(complete=False))
    out = run([failed, star(202, [(2021, 2.)], {})], targets=[201, 202, 203])
    m = out["manifest"]
    assert out["status"] == "incomplete" and m["complete"] is False
    assert m["counts"]["request_failed"] == 1 and m["counts"]["unprocessed"] == 1 and m["counts"]["ready"] == 1
    assert next(s for s in m["stars"] if s["tic_id"] == 201)["reasons"] == ["external:toi:source_held"]
    assert [r["tic_id"] for r in out["candidates"]] == [202]
    assert out["candidates"][0]["external"]["state"] == "missing"


def test_held_only_run_is_complete_but_has_no_rows():
    out = run([ambiguous(301), no_signal(302)])
    assert out["status"] == "complete" and out["candidates"] == [] and out["bundles"] == []
    assert out["manifest"]["discoverable_ready_tic_count"] == 0


def test_previously_published_star_losing_all_candidates_is_held_not_no_signal():
    old = candidate(801, 8000, 8011, 2., 0)
    out = run([no_signal(801, [old]), no_signal(802, [dict(old, candidate_id=8021, status="retired")])])
    stars = {s["tic_id"]: s for s in out["manifest"]["stars"]}
    assert (stars[801]["status"], stars[801]["reasons"]) == ("held", ["catalog:previous_candidates_vanished"])
    assert stars[802]["status"] == "no_signal"

    # The same rule covers the 125 path, where the previous bundle is an explicit input.
    s = star(803, [(8031, 2.)], {})
    retired = dict(s["inputs"]["catalog"]["candidates"][0], status="retired", updated_bundle_id=8000)
    s["inputs"].update(
        catalog=dict(s["inputs"]["catalog"], candidates=[retired]),
        discovery=dict(s["inputs"]["discovery"], proposed_candidates=[deepcopy(retired)]),
        external=dict(s["inputs"]["external"], rows=[], history=[], external_references=[]),
        previous_bundle=dict(complete=True, tic_id=803, bundle_id=8000, candidates=[
            dict(retired, status="active", is_confirmed=False)]))
    assert run([s])["manifest"]["stars"][0]["reasons"] == ["catalog:previous_candidates_vanished"]


def test_duplicate_joins_never_inflate_candidates():
    good = star(401, [(4011, 2.)], {"toi": {4011: "CP"}})
    assert run([good, deepcopy(good)], targets=[401])["reason"] == "duplicate_tic_result"

    doubled = star(402, [(4021, 2.)], {"toi": {4021: "CP"}})
    doubled["inputs"]["catalog"]["candidates"] *= 2
    refs = star(403, [(4031, 2.)], {"toi": {4031: "CP"}})
    refs["inputs"]["external"]["rows"][0]["source_refs"]["refs"] *= 2
    out = run([good, doubled, refs])
    stars = {s["tic_id"]: s for s in out["manifest"]["stars"]}
    assert (stars[402]["status"], stars[402]["reasons"]) == ("rejected", ["candidate_set_mismatch"])
    assert (stars[403]["status"], stars[403]["reasons"]) == ("rejected", ["duplicate_external_match"])
    assert [r["candidate_id"] for r in out["candidates"]] == [4011]

    clash = star(404, [(4011, 2.)], {"toi": {4011: "CP"}})
    assert run([good, clash])["reason"] == "duplicate_candidate_id"


def test_input_order_does_not_change_output():
    results = [star(501, [(5011, 2.)], {"toi": {5011: "CP"}}), no_signal(502), star(503, [(5031, 2.)], {})]
    first = run(results)
    assert run(results[::-1], targets=[503, 502, 501]) == first


def test_run_level_inputs_and_scope_are_enforced():
    good = star(601, [(6011, 2.)], {"toi": {6011: "CP"}})
    override = deepcopy(good)
    override["inputs"]["ai_policy"] = POLICY
    assert run([override])["reason"] == "run_level_input_overridden"
    assert run([good], ai_policy=dict(POLICY, status="inference_failed"))["reason"] == "unsupported_ai_policy"
    # Test strings must not reach an operational run.
    assert run([good], ai_policy=dict(POLICY, model_version="fixture-policy-only"))["reason"] == "unsupported_ai_policy"
    assert run([good], calculation_versions=dict(VERSIONS, ai_model="fixture-policy-only")
               )["reason"] == "ai_version_mismatch"
    assert run([good], targets=[602])["reason"] == "result_outside_targets"
    assert run([], targets=[])["reason"] == "invalid_targets"
    assert run([good], calculation_versions=dict(VERSIONS, candidate_quality="quality-v1")
               )["reason"] == "per_star_version_in_run"
    assert run([good], calculation_versions=dict(VERSIONS, extra="x"))["reason"] == "invalid_calculation_versions"
    # Non-dict inputs are rejections, not crashes.
    assert run([good], calculation_versions=["not", "a", "dict"])["reason"] == "malformed_input"
    assert run([dict(tic_id=601, inputs="garbage")])["reason"] == "malformed_input"
    broken = deepcopy(good)
    broken["inputs"]["catalog"] = "garbage"
    assert run([broken])["manifest"]["stars"][0]["reasons"] == ["malformed_input"]
    mismatch = deepcopy(good)
    mismatch["tic_id"] = 603
    assert run([mismatch])["manifest"]["stars"][0]["reasons"] == ["result_tic_mismatch"]


def test_schema_matches_kernel_and_rejects_broken_rows():
    Draft202012Validator.check_schema(SCHEMA)
    manifest = SCHEMA["$defs"]["manifest"]["properties"]
    assert tuple(manifest["counts"]["required"]) == STATUSES
    out = run([star(701, [(7011, 2.)], {"toi": {7011: "CP"}})])
    broken = []
    for path, value in [(("candidates", 0, "ai", "score"), .9),
                        (("candidates", 0, "external", "state"), "missing"),
                        (("candidates", 0, "external", "sources", 1, "match"), "unmatched"),  # toi
                        (("manifest", "counts", "unknown"), 1),
                        (("publishable",), True)]:
        mutated = deepcopy(out)
        parent = mutated
        for part in path[:-1]:
            parent = parent[part]
        parent[path[-1]] = value
        broken.append(mutated)
    missing_count = deepcopy(out)
    del missing_count["manifest"]["counts"]["held"]
    for doc in broken + [missing_count]:
        assert not VALIDATOR.is_valid(doc)


def test_split_path_matches_aggregate_without_moving_payloads():
    # 80 evaluates stars on Spark executors and combines light results on the driver.
    results = [star(1101, [(11011, 2.), (11012, 5.3)], {"toi": {11011: "CP"}}), no_signal(1102),
               ambiguous(1103), star(1104, [(11041, 2.)], {}, toi=dict(complete=False))]
    targets = [1101, 1102, 1103, 1104, 1105]
    whole = run(results, targets=targets)
    per_star = dict(calculation_versions=VERSIONS, ai_policy=POLICY)
    args = dict(per_star, run_id="run-fixture", silver_attempt="silver/pipeline_version=fixture/run_id=run-fixture")
    stars = [evaluate(tic_id=r["tic_id"], inputs=r["inputs"], **per_star) for r in results]
    assert [s["payload"] for s in stars if s["payload"]] == whole["bundles"]
    light = [{k: v for k, v in s.items() if k != "payload"} for s in stars[::-1]]  # 1105 never evaluated
    split = combine(targets=targets, stars=light, **args)
    assert split == {k: v for k, v in whole.items() if k != "bundles"}
    assert split["status"] == "incomplete" and split["manifest"]["counts"]["unprocessed"] == 1

    ready = next(s for s in light if s["status"] == "ready")
    for broken, reason in [(light + [ready], "duplicate_tic_result"),
                           ([dict(ready, tic_id=1199)], "result_outside_targets"),
                           ([dict(ready, bundle=None)], "invalid_star_result"),
                           ([dict(ready, status="done")], "invalid_star_result")]:
        assert combine(targets=targets, stars=broken, **args)["reason"] == reason
    with pytest.raises(GoldValidationError, match="run_level_input_overridden"):
        evaluate(tic_id=1101, inputs=dict(results[0]["inputs"], ai_policy=POLICY), **per_star)
    assert evaluate(tic_id=1101, inputs="garbage", **per_star)["reasons"] == ["malformed_input"]


def test_candidate_quality_revision_is_taken_per_star():
    # 123 revisions hash each star's own models, so real runs never share one value.
    first, second = star(901, [(9011, 2.)], {"toi": {9011: "CP"}}), star(902, [(9021, 2.)], {})
    for s, revision in ((first, "candidate-quality-v1-aaa"), (second, "candidate-quality-v1-bbb")):
        s["inputs"]["discovery"]["candidate_quality_revision"] = revision
    out = run([first, second])
    assert out["manifest"]["counts"]["ready"] == 2 and "candidate_quality" not in out["manifest"]["calculation_versions"]
    got = {b["bundle"]["tic_id"]: b["bundle"]["manifest"]["calculation_versions"]["candidate_quality"] for b in out["bundles"]}
    assert got == {901: "candidate-quality-v1-aaa", 902: "candidate-quality-v1-bbb"}


def test_pscomppars_reference_is_published_as_archive_and_lineage_keeps_the_snapshot_name():
    # 266 reads only external_signal_references(source='archive', external_id=exact pl_name) [276].
    s = star(1001, [(10011, 2.)], {})
    row = dict(tic_id="1001", external_id="X b", period_days=2., epoch_btjd=1., duration_hours=2.,
               time_system="BTJD-TDB", raw_disposition=None, source_row_updated_at=None)
    s["inputs"]["external"] = join_catalog(
        s["inputs"]["catalog"], {"nea_pscomppars": delivery("nea_pscomppars", 1001, [row])}, TIMES,
        required_sources=["nea_pscomppars"], approval="fixture-only")
    out = run([s])
    [bundle] = out["bundles"]
    assert [(r["source"], r["external_id"], r["candidate_id"]) for r in bundle["external_statuses"]] == [
        ("archive", "X b", 10011)]
    [source] = out["candidates"][0]["external"]["sources"]
    assert (source["source"], source["match"]) == ("nea_pscomppars", "direct_match")
