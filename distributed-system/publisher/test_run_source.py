"""run_source 자기 검사 [S15P21C206-276]. DB 없이 돈다: python -m unittest test_run_source (publisher 디렉터리에서).

합성 run은 79 커널 aggregate로 만들고 외부 조인은 실제 124 build_snapshot·join_catalog다. ID·라벨·버전 문자열은
합성값이며 운영 할당·채택값이 아니다. test_load가 같은 run으로 적재까지 본다.
"""

import copy
import hashlib
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np
from astro_kernel.candidate_aggregation import AI_NOT_EXECUTED, AI_POLICY, aggregate
from astro_kernel.external_catalog import build_snapshot, join_catalog
from astro_kernel.gold_canonical import record_checksum

from publisher import run_source as r
from publisher.__main__ import exit_code, notify_record

APPROVAL = "unittest-only"
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
    """합성 run의 79 집계 출력과 별 메타데이터(80이 번들 줄에 싣는 모양)."""
    run = aggregate(run_id="run-fixture", silver_attempt="silver/fixture", targets=list(tics),
                    results=[_star(t) for t in tics], calculation_versions=VERSIONS, ai_policy=AI_POLICY)
    metadata = {str(t): {"star": {"teff_k": None, "radius_rsun": None, "tmag": None},
                         "observations": {"3": {"cadence": "120s", "source_version": "spoc-fixture"}}} for t in tics}
    return run, metadata


def write_ready(folder: Path, run: dict, metadata: dict) -> Path:
    """80 publish-ready를 Node 1로 받은 폴더와 같은 배치로 쓴다. 번들은 두 part로 나눈다."""
    files = {}

    def write(rel, rows):
        data = "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows).encode()
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_bytes(data)
        files[rel] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "lines": len(rows)}

    write("manifest/part-00000", [run["manifest"]])
    write("candidates/part-00000", run["candidates"])
    bundles = [{"tic_id": b["bundle"]["tic_id"], "payload": b, "metadata": metadata[str(b["bundle"]["tic_id"])]}
               for b in run["bundles"]]
    for i in range(2):
        write(f"bundles/part-{i:05d}", bundles[i::2])
    write("bundles/part-00002", [])                        # Spark는 빈 파티션도 파일로 쓴다(lines=0)
    (folder / "bundles" / "_SUCCESS").write_bytes(b"")   # files에 없는 파일은 읽지 않는다
    marker = {"schema": r.READY_SCHEMA, "run_id": run["manifest"]["run_id"], "counts": run["manifest"]["counts"],
              "excluded_tics": [], "files": files}
    (folder / "_READY.json").write_text(json.dumps(marker), encoding="utf-8")
    return folder


class RunSourceTest(unittest.TestCase):
    A, B = 990_000_001, 990_000_002

    def setUp(self):
        self.run, self.meta = synthetic_run(self.A, self.B)
        self.assertEqual(self.run["manifest"]["counts"]["ready"], 2, self.run["manifest"]["stars"])
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def payloads(self):
        _, items = r.read_ready(write_ready(self.dir, self.run, self.meta), "run-fixture", APPROVAL)
        return dict(items)

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
        self.assertEqual((p["bundle"]["manifest"]["publish"]["run_id"], p["bundle"]["manifest"]["publish"]["approval"]),
                         ("run-fixture", APPROVAL))
        # 적재가 DB에서 다시 읽어 대조하는 외부 참조 checksum과 같아야 한다. candidate_key는 연결된 후보의 값이다.
        rows = [dict(e, candidate_key={k: c["record"][k] for k in ("period_days", "epoch_btjd")})
                for c in p["candidates"] for e in c["external"]] + [dict(e, candidate_key=None) for e in p["external_only"]]
        self.assertEqual(record_checksum("external_statuses", rows),
                         p["bundle"]["manifest"]["record_checksums"]["external_statuses"])
        self.assertEqual(r.confirmed_without_archive(p), 0)
        first["external"] = [e for e in first["external"] if e["source"] != "archive"]
        self.assertEqual(r.confirmed_without_archive(p), 1, "archive가 없는 확정 후보는 266 설명이 열리지 않는다")

    def test_folder_that_disagrees_with_its_marker_publishes_nothing(self):
        def marker(folder, change):
            m = json.loads((folder / "_READY.json").read_text(encoding="utf-8"))
            change(m)
            (folder / "_READY.json").write_text(json.dumps(m), encoding="utf-8")

        cases = (
            ("전송 중 바뀐 part", lambda f: (f / "bundles/part-00001").write_bytes(
                (f / "bundles/part-00001").read_bytes() + b" ")),
            ("빠진 part", lambda f: (f / "candidates/part-00000").unlink()),
            ("모르는 형식", lambda f: marker(f, lambda m: m.update(schema="other"))),
            ("다른 run", lambda f: marker(f, lambda m: m.update(run_id="other-run"))),
            ("폴더 밖 경로", lambda f: marker(f, lambda m: m["files"].update({"../x": m["files"]["manifest/part-00000"]}))),
            ("번들 수", lambda f: marker(f, lambda m: m["files"].pop("bundles/part-00001"))),
            ("counts", lambda f: marker(f, lambda m: m["counts"].update(ready=3))),
        )
        for name, change in cases:
            with self.subTest(name):
                with tempfile.TemporaryDirectory() as tmp:
                    folder = write_ready(Path(tmp), self.run, self.meta)
                    change(folder)
                    with self.assertRaises(r.PublishRejected):
                        r.read_ready(folder, "run-fixture", APPROVAL)   # 부를 때 바로 거절한다(별을 하나도 내지 않는다)
        with self.assertRaisesRegex(r.PublishRejected, "승인"):
            r.read_ready(write_ready(self.dir, self.run, self.meta), "run-fixture", " ")

    def test_one_broken_star_is_rejected_alone(self):
        # 80 gate가 막을 입력이지만 276도 별 단위로 막는다. 파일 checksum은 맞게 쓴다.
        self.bundle(self.B)["segments"][0]["flux"][0] = 1.5
        got = self.payloads()
        self.assertIsInstance(got[self.B], r.PublishRejected)
        self.assertIn("배열 checksum", str(got[self.B]))
        self.assertIsInstance(got[self.A], dict)

    def test_bundle_that_disagrees_with_the_run_manifest_is_rejected_alone(self):
        self.bundle(self.B)["bundle"]["bundle_version"] = "pv1-other"
        got = self.payloads()
        self.assertIn("run manifest 항목", str(got[self.B]))
        self.assertIsInstance(got[self.A], dict)

    def test_missing_sector_metadata_rejects_that_star(self):
        self.meta[str(self.B)]["observations"] = {}
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


class RunRecordExitTest(unittest.TestCase):
    """publish-run 종료 코드. Airflow는 1이면 같은 명령을 다시 돌리고 65면 멈춘다(끝난 별은 ALREADY_PUBLISHED)."""

    def record(self, *codes, status="published", notify="sent"):
        return {"status": status, "stars": [{"code": c} for c in codes], "notify": {"status": notify}}

    def test_exit_codes(self):
        self.assertEqual(exit_code(self.record("PUBLISHED", "ALREADY_PUBLISHED", "BUNDLE_SUPERSEDED")), 0)
        self.assertEqual(exit_code(self.record("PUBLISHED", "PUBLISH_REJECTED")), 65)
        self.assertEqual(exit_code(self.record("IDEMPOTENCY_CONFLICT")), 65)
        self.assertEqual(exit_code(self.record(status="rejected")), 65)
        # 일시 장애가 있으면 거절이 섞여도 다시 돌린다. 끝난 별은 그대로이고 거절은 다음 실행에 65로 남는다.
        self.assertEqual(exit_code(self.record("PUBLISH_REJECTED", "PUBLISH_ROLLED_BACK")), 1)
        self.assertEqual(exit_code(self.record("PUBLISHED", notify="partial")), 1)
        self.assertEqual(exit_code(self.record("PUBLISHED", notify="skipped_no_token")), 0)
        # current를 그대로 둔 별(튜토리얼 별 등)만 거절이면 정책대로 끝난 run이다.
        kept = self.record("PUBLISHED")
        kept["stars"].append({"code": "PUBLISH_REJECTED", "current_kept": True})
        self.assertEqual(exit_code(kept), 0)

    def test_notify_without_targets_or_token_sends_nothing(self):
        self.assertEqual(notify_record([])["status"], "none")
        with unittest.mock.patch.dict("os.environ", {"INTERNAL_SERVICE_TOKEN": ""}):
            self.assertEqual(notify_record([12]), {"status": "skipped_no_token", "results": []})


if __name__ == "__main__":
    unittest.main()
