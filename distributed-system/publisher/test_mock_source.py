"""mock_source 자기 검사. DB 없이 돈다: python -m unittest test_mock_source (publisher 디렉터리에서).

astro_kernel이 import되어야 한다(이미지에는 설치돼 있다. 로컬은 PYTHONPATH에 libs/astro-kernel을 둔다).
"""

import json
import unittest

from astro_kernel.gold_canonical import array_checksum, normalize_array

from publisher import mock_source

TIC = 900000008


class ToiPayloadTest(unittest.TestCase):
    def setUp(self):
        self.src = json.loads(mock_source.FIXTURE.read_text(encoding="utf-8"))
        self.p = mock_source.toi270_payload(self.src, TIC)

    def test_every_tic_moves_to_target(self):
        self.assertEqual(self.p["tic_id"], TIC)
        self.assertTrue(all(s["tic_id"] == TIC for s in self.p["segments"]))

    def test_does_not_overwrite_existing_star(self):
        # star가 없으면 load.publish_star는 별 행을 upsert하지 않고 존재만 확인한다.
        self.assertIsNone(self.p["star"])

    def test_every_mock_row_is_marked(self):
        # mock_purge.sql이 지우는 기준이다. 하나라도 빠지면 그 행은 삭제 절차에서 남는다.
        self.assertTrue(self.p["bundle"]["bundle_version"].startswith(mock_source.MARK))
        for s in self.p["segments"]:
            self.assertTrue(s["binning_revision"].startswith(mock_source.MARK))
            self.assertTrue(s["observation"]["source_version"].startswith(mock_source.MARK))

    def test_checksums_match_arrays(self):
        # load._verify_staging이 DB에서 다시 읽어 이 값과 대조한다.
        for s in self.p["segments"]:
            self.assertEqual(s["checksum"], array_checksum(normalize_array(s["flux"])))
        pg = self.p["periodogram"]
        self.assertEqual(pg["checksum"], array_checksum(normalize_array(pg["power"], allow_null=False)))
        self.assertEqual(set(self.p["bundle"]["manifest"]["record_checksums"]),
                         {"candidates", "external_statuses", "ai_results"})

    def test_candidates_carry_what_the_loader_reads(self):
        for c in self.p["candidates"]:
            self.assertEqual(set(c), {"record", "disposition", "external", "ai"})
            self.assertEqual(set(c["disposition"]), {"disposition", "answer_class", "planet_truth", "source_refs"})

    def test_digest_is_deterministic_per_tic(self):
        again = mock_source.toi270_payload(self.src, TIC)
        other = mock_source.toi270_payload(self.src, 900000027)
        self.assertEqual(self.p["bundle"]["payload_digest"], again["bundle"]["payload_digest"])
        self.assertEqual(self.p["bundle"]["bundle_version"], again["bundle"]["bundle_version"])
        self.assertNotEqual(self.p["bundle"]["bundle_version"], other["bundle"]["bundle_version"])
        self.assertEqual(self.p["bundle"]["manifest"]["publish"]["payload_digest"], self.p["bundle"]["payload_digest"])

    def test_source_is_not_mutated(self):
        self.assertEqual(self.src["bundle"]["tic_id"], 259377017)


if __name__ == "__main__":
    unittest.main()
