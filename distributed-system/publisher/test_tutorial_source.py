"""tutorial_source 자기 검사. DB 없이 돈다: python -m unittest test_tutorial_source (publisher 디렉터리에서).

원천 읽기는 합성 파일로 검사한다. 실제 FITS로 5종 payload까지 만드는 검사는 TUTORIAL_INPUTS에 입력 폴더를 줄 때만 돈다
(FITS는 저장소에 없다. 받는 방법은 README 「튜토리얼 5종」).
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from publisher import tutorial_source as t

FIXTURE_CHECKSUMS = Path(__file__).resolve().parents[2] / "experiments/tess-fixture/checksums.json"


def star(read_spec, *, tic=278956474):
    return {"tic_id": tic, "external": {"rows": [read_spec]}}


class DefinitionTest(unittest.TestCase):
    def setUp(self):
        self.tutorial = t.load_tutorial()

    def test_five_ordered_stars_with_known_intents(self):
        stars = self.tutorial["stars"]
        self.assertEqual([s["seq"] for s in stars], [1, 2, 3, 4, 5])
        self.assertEqual(len({s["tic_id"] for s in stars}), 5)  # 같은 TIC을 두 칸에 두면 진행이 꼬인다
        self.assertTrue(all(s["intent"] in t.DISPOSITION_BY_INTENT for s in stars))

    def test_s2_inputs_are_the_dec01_fixture_files(self):
        # DEC-01: 1·2번 S2는 fixture에 고정한 두 파일만 쓴다.
        fixture = {f["filename"]: f["sha256"] for f in json.loads(FIXTURE_CHECKSUMS.read_text(encoding="utf-8"))["files"]}
        for s in self.tutorial["stars"]:
            if s["product"]["sector"] == 2:
                self.assertEqual(fixture[s["product"]["filename"]], s["product"]["sha256"])


class ReaderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_dv_reader_takes_named_fit_and_harmonic_multiplier(self):
        xml = self.dir / "dv.xml"
        xml.write_text("""<dv:dvTargetResults xmlns:dv="http://www.nasa.gov/2018/TESS/DV" ticId="278956474" simData="false">
  <dv:planetResults planetNumber="2">
    <dv:allTransitsFit fullConvergence="true"><dv:modelParameters>
      <dv:modelParameter name="orbitalPeriodDays" value="9.0"/><dv:modelParameter name="transitEpochBtjd" value="1.0"/>
      <dv:modelParameter name="transitDurationHours" value="1.0"/></dv:modelParameters></dv:allTransitsFit>
    <dv:evenTransitsFit fullConvergence="true"><dv:modelParameters>
      <dv:modelParameter name="orbitalPeriodDays" value="2.5"/><dv:modelParameter name="transitEpochBtjd" value="1330.5"/>
      <dv:modelParameter name="transitDurationHours" value="3.3"/></dv:modelParameters></dv:evenTransitsFit>
  </dv:planetResults>
</dv:dvTargetResults>""", encoding="utf-8")
        [row] = t.external_rows(star({"read": "dv_xml", "external_id": "B", "planet": 2, "fit": "evenTransitsFit",
                                      "period_multiplier": 2, "label": "FP"}), xml)
        self.assertEqual((row["period_days"], row["epoch_btjd"], row["duration_hours"]), (5.0, 1330.5, 3.3))
        self.assertEqual((row["tic_id"], row["time_system"], row["raw_disposition"]), ("278956474", "BTJD-TDB", "FP"))

    def test_dv_reader_rejects_other_star(self):
        xml = self.dir / "dv.xml"
        xml.write_text('<dvTargetResults ticId="1" simData="false"/>', encoding="utf-8")
        with self.assertRaises(t.TutorialError):
            t.external_rows(star({"read": "dv_xml", "external_id": "A", "planet": 1, "fit": "allTransitsFit",
                                  "label": "FP"}), xml)

    def test_archive_row_needs_tdb(self):
        csv = self.dir / "ps.csv"
        header = "pl_name,tic_id,pl_orbper,pl_tranmid,pl_trandur,pl_tranmid_systemref,tran_flag\n"
        spec = {"read": "pscomppars", "pl_name": "X b", "label": "CP"}
        csv.write_text(header + '"X b","TIC 7",4.4,2458851.5,3.8,"BJD-TDB",1\n', encoding="utf-8")
        [row] = t.external_rows(star(spec, tic=7), csv)
        self.assertEqual((row["external_id"], row["epoch_btjd"], row["raw_disposition"]), ("X b", 1851.5, "CP"))
        # 116: BJD만 적힌 행은 TDB로 추정하지 않는다.
        csv.write_text(header + '"X b","TIC 7",4.4,2458851.5,3.8,"BJD",1\n', encoding="utf-8")
        with self.assertRaises(t.TutorialError):
            t.external_rows(star(spec, tic=7), csv)


class SyntheticBuildTest(unittest.TestCase):
    """합성 SPOC FITS 한 개로 119→125와 to_payload를 끝까지 돈다. 실제 FITS가 없는 CI에서 커널 호출이 깨지면 잡는다.

    수치 정답(실제 5종의 후보·라벨)은 BuildTest가 본다. 여기서는 경로가 이어지는지만 본다.
    """

    PERIOD, EPOCH, DURATION_H, DEPTH = 3.3, 1355.0, 3.0, 0.005

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def fits_file(self, tic: int) -> Path:
        import numpy as np
        from astropy.io import fits

        time = 1354.0 + np.arange(0, 26.0, 2 / 1440)
        flux = 1000 * (1 + np.random.default_rng(7).normal(0, 0.0005, time.size))
        flux[np.abs((time - self.EPOCH + self.PERIOD / 2) % self.PERIOD - self.PERIOD / 2) < self.DURATION_H / 48] *= 1 - self.DEPTH
        primary = fits.PrimaryHDU()
        primary.header.update(TICID=tic, SECTOR=3, PROCVER="spoc-synthetic", TEFF=5800.0, RADIUS=1.0, TESSMAG=10.0)
        table = fits.BinTableHDU.from_columns([
            fits.Column(name="TIME", format="D", array=time),
            fits.Column(name="PDCSAP_FLUX", format="E", unit="e-/s", array=flux),
            fits.Column(name="PDCSAP_FLUX_ERR", format="E", unit="e-/s", array=np.full(time.size, 0.5)),
            fits.Column(name="QUALITY", format="J", array=np.zeros(time.size, dtype=np.int32)),
            fits.Column(name="CADENCENO", format="J", array=np.arange(time.size, dtype=np.int32))])
        table.header.update(TIMESYS="TDB", BJDREFI=2457000, BJDREFF=0.0, TIMEUNIT="d", TIMEDEL=2 / 1440)
        path = self.dir / "synthetic_lc.fits"
        fits.HDUList([primary, table]).writeto(path)
        return path

    def test_synthetic_star_reaches_payload(self):
        try:
            import astropy  # noqa: F401  BLS 선택 의존성. CI validate:astro-kernel에는 있다.
        except ImportError:
            self.skipTest("astropy가 없다")
        import hashlib

        tic = 999999001
        sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731
        fits_path = self.fits_file(tic)
        (self.dir / "source.txt").write_text("synthetic", encoding="utf-8")
        tutorial = t.load_tutorial()
        definition = {
            "seq": 1, "intent": "deep_confirmed", "tic_id": tic, "name": "synthetic",
            "product": {"filename": fits_path.name, "sector": 3, "sha256": sha(fits_path), "procver": "spoc-synthetic"},
            "external": {"source": "archive", "file": "source.txt", "sha256": sha(self.dir / "source.txt"),
                         "retrieved_at": "2026-09-27T00:00:00Z", "uri": "synthetic://", "table": "synthetic",
                         "time_evidence": "synthetic BTJD-TDB",
                         "rows": [{"read": "manual", "external_id": "S b", "period_days": self.PERIOD,
                                   "epoch_btjd": self.EPOCH, "duration_hours": self.DURATION_H, "label": "CP"}]}}

        result, attributes = t.assemble_star(definition, self.dir, tutorial, "unittest-only")
        p = t.to_payload(result, definition, attributes, {"source": "tutorial", "seq": 1})

        [c] = p["candidates"]
        self.assertAlmostEqual(c["record"]["period_days"], self.PERIOD, delta=0.05)
        self.assertEqual((c["disposition"]["disposition"], c["external"]["external_id"]), ("confirmed", "S b"))
        self.assertEqual(p["bundle"]["manifest"]["publish"]["payload_digest"], p["bundle"]["payload_digest"])
        again, _ = t.assemble_star(definition, self.dir, tutorial, "unittest-only")
        self.assertEqual(t.to_payload(again, definition, attributes, {})["bundle"]["payload_digest"],
                         p["bundle"]["payload_digest"])  # 같은 입력이면 같은 판이다(재실행이 ALREADY_PUBLISHED)


@unittest.skipUnless(os.environ.get("TUTORIAL_INPUTS"), "TUTORIAL_INPUTS에 FITS·원천 폴더를 주면 돈다")
class BuildTest(unittest.TestCase):
    def test_five_payloads_match_their_intent(self):
        payloads = t.build(Path(os.environ["TUTORIAL_INPUTS"]), "unittest-only")
        tutorial = {s["tic_id"]: s for s in t.load_tutorial()["stars"]}
        self.assertEqual(len(payloads), 5)
        for p in payloads:
            wanted = t.DISPOSITION_BY_INTENT[tutorial[p["tic_id"]]["intent"]]
            self.assertEqual(p["star"]["service_status"], "published")
            self.assertTrue(p["candidates"])
            self.assertTrue(all(c["disposition"]["disposition"] == wanted and c["external"] for c in p["candidates"]))
            self.assertTrue(all(c["record"]["discoverable"] for c in p["candidates"]))
            self.assertEqual(p["bundle"]["manifest"]["publish"]["payload_digest"], p["bundle"]["payload_digest"])


if __name__ == "__main__":
    unittest.main()
