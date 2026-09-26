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
