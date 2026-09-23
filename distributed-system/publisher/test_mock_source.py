"""mock_source 자기 검사. DB 없이 돈다: python -m unittest test_mock_source (publisher 디렉터리에서)."""

import json
import unittest

from publisher import mock_source


class RetargetTest(unittest.TestCase):
    def setUp(self):
        self.base = json.loads(mock_source.FIXTURE.read_text(encoding="utf-8"))
        self.p = mock_source.retarget(self.base, 900000008)

    def test_every_tic_moves_to_target(self):
        self.assertEqual(self.p["bundle"]["tic_id"], 900000008)
        self.assertTrue(all(s["tic_id"] == 900000008 for s in self.p["segments"]))

    def test_mock_rows_are_marked(self):
        self.assertTrue(self.p["bundle"]["bundle_version"].startswith(mock_source.MARK))
        self.assertTrue(all(s["binning_revision"].startswith(mock_source.MARK) for s in self.p["segments"]))

    def test_checksum_key_follows_renamed_segment(self):
        # load.publish가 이 키로 찾는다. 이름만 바꾸고 키를 두면 KeyError로 적재가 멈춘다.
        s = self.p["segments"][0]
        self.assertIn(f"segment:{s['sector']}:{s['binning_revision']}:flux", self.p["checksums"])

    def test_version_is_deterministic_per_tic(self):
        again = mock_source.retarget(self.base, 900000008)
        other = mock_source.retarget(self.base, 900000027)
        self.assertEqual(self.p["bundle"]["bundle_version"], again["bundle"]["bundle_version"])
        self.assertNotEqual(self.p["bundle"]["bundle_version"], other["bundle"]["bundle_version"])

    def test_base_is_not_mutated(self):
        self.assertEqual(self.base["bundle"]["tic_id"], 259377017)


if __name__ == "__main__":
    unittest.main()
