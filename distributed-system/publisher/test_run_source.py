"""run_source 자기 검사 [S15P21C206-276]. DB 없이 돈다: python -m unittest test_run_source (publisher 디렉터리에서).

합성 run은 79 커널 aggregate로 만들고 외부 조인은 실제 124 build_snapshot·join_catalog다. ID·라벨·버전 문자열은
합성값이며 운영 할당·채택값이 아니다. test_load가 같은 run으로 적재까지 본다.
"""

import copy
import unittest

import numpy as np
from astro_kernel.candidate_aggregation import AI_NOT_EXECUTED, AI_POLICY, aggregate
from astro_kernel.external_catalog import build_snapshot, join_catalog
from astro_kernel.gold_canonical import record_checksum

from publisher import run_source as r

TIMES = np.arange(0, 10, .01)
VERSIONS = dict(preprocessing="pre-v1", bls_config="search-v1", residual_model="box-divide-v0",
                periodogram_config="provided-v1", ai_model=AI_NOT_EXECUTED, ai_threshold=AI_NOT_EXECUTED,
                external_matching="external-match-review-v1")


def _candidate(tic, cid, period, step):
    params = dict(period_days=period, epoch_btjd=1., duration_hours=2., depth_ppm=1000.)
    model = dict(candidate_id=f"c-{cid}", shape="box", baseline={"kind": "unity"},
                 residual_model_version="box-divide-v0", parameters=params)
    return dict(candidate_id=cid, tic_id=tic, updated_bundle_id=tic * 10, status="active", removal_step=step,
                **params, bls_power=12., transit_model=model, discoverable=True)


def _delivery(source, tic, rows):
    rows = [dict(tic_id=str(tic), epoch_btjd=1., duration_hours=2., time_system="BTJD-TDB",
                 source_row_updated_at=None, **row) for row in rows]
    return build_snapshot(source=source, scope=[str(tic)], rows=rows, raw_sha256="a" * 64,
                          retrieved_at="2026-09-22T00:00:00Z", source_uri="https://example.org/catalog",
                          source_table=source, time_evidence="fixture:explicit-TDB", complete=True, validated=True)


def _star(tic):
    """후보 둘. 첫째는 PSCompPars(DB에는 archive)·TOI(CP) 두 원천과 직접 대응하고 둘째는 대응이 없다.
    TOI에는 우리 후보와 대응하지 않는 행이 하나 더 있다(124 external_only)."""
    cs = [_candidate(tic, tic * 10 + 1, 2., 0), _candidate(tic, tic * 10 + 2, 5.3, 1)]
    catalog = dict(tic_id=tic, bundle_id=tic * 10, catalog_ready=True, complete=True, candidates=copy.deepcopy(cs))
    deliveries = {
        "nea_pscomppars": _delivery("nea_pscomppars", tic, [
            dict(external_id=f"TIC {tic} b", period_days=2., raw_disposition=None)]),
        "toi": _delivery("toi", tic, [dict(external_id=f"{tic}.01", period_days=2., raw_disposition="CP"),
                                      dict(external_id=f"{tic}.02", period_days=7.7, raw_disposition="PC")])}
    segment = dict(tic_id=tic, sector=3, binning_revision="bin-v1-fixture", start_btjd=0., bin_minutes=10.,
                   n_points=3, flux=[1., None, .999], flux_scatter=.01, gaps=[[1, 1]])
    return dict(tic_id=tic, inputs=dict(
        catalog=catalog, segmented=dict(segments=[segment], quarantined=[]),
        discovery=dict(status="ready", discoverability_ready=True, tic_id=tic, bundle_id=tic * 10,
                       candidate_quality_revision="quality-v1", proposed_candidates=copy.deepcopy(cs)),
        external=join_catalog(catalog, deliveries, TIMES, required_sources=sorted(deliveries), approval="fixture-only"),
        periodogram=dict(candidate_id=None, periods=np.geomspace(.5, 40., 5000).tolist(), power=[1.] * 5000),
        segment_ids={"3": tic * 10 + 1}, input_snapshot_ids=[f"lc:spoc:s0003:sha256:{'b' * 64}:procver:fixture"],
        fold_reference_time_btjd=1., base_days=3., fine_tune=dict(half_width_cells=3)))


def synthetic_run(*tics):
    """합성 run의 79 집계 출력과 별 메타데이터(80이 넘길 모양)."""
    run = aggregate(run_id="run-fixture", silver_attempt="silver/fixture", targets=list(tics),
                    results=[_star(t) for t in tics], calculation_versions=VERSIONS, ai_policy=AI_POLICY)
    metadata = {str(t): {"star": {"teff_k": 5800., "radius_rsun": 1., "tmag": 10.},
                         "observations": {"3": {"cadence": "120s", "source_version": "spoc-fixture"}}} for t in tics}
    return run, metadata


class RunSourceTest(unittest.TestCase):
    A, B = 990_000_001, 990_000_002

    def setUp(self):
        self.run, self.meta = synthetic_run(self.A, self.B)
        self.assertEqual(self.run["manifest"]["counts"]["ready"], 2, self.run["manifest"]["stars"])

    def payloads(self):
        return dict(r.star_payloads(self.run, self.meta))

    def bundle(self, tic):
        return next(b for b in self.run["bundles"] if b["bundle"]["tic_id"] == tic)

    def test_ready_stars_become_first_publish_payloads_with_every_external_reference(self):
        got = self.payloads()
        self.assertEqual(sorted(got), [self.A, self.B])
        p = got[self.A]
        self.assertIsInstance(p, dict, p)
        first, second = p["candidates"]
        self.assertEqual(sorted((e["source"], e["external_id"]) for e in first["external"]),
                         [("archive", f"TIC {self.A} b"), ("toi", f"{self.A}.01")])
        self.assertEqual(second["external"], [])
        self.assertEqual([e["external_id"] for e in p["external_only"]], [f"{self.A}.02"])
        self.assertTrue(first["record"]["is_confirmed"])
        self.assertEqual((p["star"]["service_status"], p["star"]["confirmed_count"]), (None, 1))
        self.assertNotIn("payload_digest", p["bundle"])
        self.assertEqual(p["bundle"]["manifest"]["publish"]["run_id"], "run-fixture")
        # 적재가 DB에서 다시 읽어 대조하는 외부 참조 checksum과 같아야 한다. candidate_key는 연결된 후보의 값이다.
        rows = [dict(e, candidate_key={k: c["record"][k] for k in ("period_days", "epoch_btjd")})
                for c in p["candidates"] for e in c["external"]] + [dict(e, candidate_key=None) for e in p["external_only"]]
        self.assertEqual(record_checksum("external_statuses", rows),
                         p["bundle"]["manifest"]["record_checksums"]["external_statuses"])

    def test_run_that_disagrees_with_its_manifest_publishes_nothing(self):
        for name, change in (("후보 표", lambda run: run["candidates"][0].update(depth_ppm=2000.)),
                             ("번들 요약", lambda run: run["manifest"]["bundles"][0].update(bundle_version="pv1-other")),
                             ("거절된 run", lambda run: run.update(status="rejected", manifest=None)),
                             ("모르는 형식", lambda run: run["manifest"].update(schema_version="other")),
                             ("깨진 입력", lambda run: run.pop("candidates"))):
            with self.subTest(name):
                run = copy.deepcopy(self.run)
                change(run)
                with self.assertRaises(r.PublishRejected):
                    list(r.star_payloads(run, self.meta))

    def test_one_broken_star_is_rejected_alone(self):
        self.bundle(self.B)["segments"][0]["flux"][0] = 1.5
        got = self.payloads()
        self.assertIsInstance(got[self.B], r.PublishRejected)
        self.assertIn("배열 checksum", str(got[self.B]))
        self.assertIsInstance(got[self.A], dict)

    def test_missing_star_metadata_rejects_that_star(self):
        del self.meta[str(self.B)]
        got = self.payloads()
        self.assertIsInstance(got[self.B], r.PublishRejected)
        self.assertIsInstance(got[self.A], dict)

    def test_values_outside_the_gold_contract_are_rejected(self):
        for name, change in (("base_days", lambda g: g["bundle"].update(base_days=0.)),
                             ("depth", lambda g: g["candidates"][0].update(depth_ppm=1_000_000.))):
            with self.subTest(name):
                g = copy.deepcopy(self.bundle(self.A))
                change(g)
                # checksum 검사를 지나 값 검사에 닿게 한다.
                g["bundle"]["manifest"]["record_checksums"]["candidates"] = record_checksum("candidates", g["candidates"])
                with self.assertRaisesRegex(r.PublishRejected, "범위 밖"):
                    r.check_bundle(g)

    def test_update_bundle_is_not_published_yet(self):
        g = copy.deepcopy(self.bundle(self.A))
        g["lifecycle_actions"] = [dict(candidate_id=g["candidates"][0]["id"], action="keep")]
        with self.assertRaisesRegex(r.PublishRejected, "갱신 판"):
            r.check_bundle(g)


if __name__ == "__main__":
    unittest.main()
