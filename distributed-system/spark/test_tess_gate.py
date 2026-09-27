"""80 게시 준비 gate: 실제 합성 별의 125 payload와 79 manifest가 검사를 통과하고, 한 곳이라도 바뀌면 실패하는지 본다."""
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tess_gate as gate  # noqa: E402
import tess_gold  # noqa: E402
from astro_kernel.candidate_aggregation import combine  # noqa: E402
from test_tess_gold import APPROVALS, TIC, products, silver_fixture, toi_csv, toi_source  # noqa: E402

SCHEMA = json.loads((ROOT / "contracts" / "gold" / "publication-candidates.schema.json").read_text(encoding="utf-8"))


def roundtrip(value):
    return json.loads(json.dumps(value, sort_keys=True, separators=(",", ":")))


class GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        checksums, _, _, row, iteration = silver_fixture()
        sources = {"nea_toi": toi_source(toi_csv((2, "2.01", 3.0, 2458356.0)))}
        star = tess_gold.star(TIC, iteration, row, product_checksums=checksums,
                              deliveries=tess_gold.deliveries(TIC, sources), required_sources=["nea_toi"],
                              approvals=APPROVALS)
        assert star["status"] == "ready", star["reasons"]
        cls.payload = roundtrip(star["payload"])
        cls.line = roundtrip(dict(tic_id=TIC, payload=star["payload"],  # one bundles line as stored
                                  metadata=tess_gold.metadata(star["payload"], products(checksums))))
        out = combine(run_id="20260927T010000Z", silver_attempt="/lake/silver/fixture", targets=[TIC],
                      stars=[tess_gold.light(star)], **tess_gold.RUN_POLICY)
        cls.manifest, cls.candidates = roundtrip(out["manifest"]), roundtrip(out["candidates"])
        cls.marker = {k: cls.manifest[k] for k in ("run_id", "target_tic_count", "counts", "candidate_count",
                                                   "candidates_sha256")}

    def test_a_real_payload_passes_and_any_change_is_caught(self):
        self.assertEqual(gate.verify_payload(self.payload), [])
        for mutate, expected in ((lambda p: p["segments"][0]["flux"].__setitem__(0, 0.5), "array checksum"),
                                 (lambda p: p["candidates"][0].__setitem__("period_days", 9.9), "record checksum"),
                                 (lambda p: p["bundle"]["manifest"]["input_snapshot_ids"].append("x:sha256:" + "0" * 64),
                                  "bundle_version"),
                                 (lambda p: p["segments"][0].__setitem__("tic_id", 1), "another star")):
            broken = deepcopy(self.payload)
            mutate(broken)
            self.assertTrue(any(expected in e for e in gate.verify_payload(broken)), expected)

    def test_bundle_lines_must_agree_with_manifest_candidates_and_metadata(self):
        entry = self.manifest["bundles"][0]
        active = [c["candidate_id"] for c in self.candidates]
        self.assertEqual(gate.check_bundle(self.line, entry, active), [])
        self.assertIn("candidate table", " ".join(gate.check_bundle(self.line, entry, active[:-1] + [1])))
        self.assertIn("not in the manifest", gate.check_bundle(self.line, None, active)[0])
        self.assertIn("manifest entry",
                      " ".join(gate.check_bundle(self.line, dict(entry, bundle_version="pv1-x"), active)))
        self.assertIn("line tic_id", " ".join(gate.check_bundle(dict(self.line, tic_id=1), entry, active)))
        self.assertIn("malformed", gate.check_bundle(dict(self.line, payload={}), entry, active)[0])
        self.assertIn("malformed", gate.check_bundle(gate.parse("not json"), entry, active)[0])
        for mutate in (lambda m: m["observations"].pop("3"), lambda m: m["observations"]["3"].update(cadence="2min"),
                       lambda m: m["observations"]["4"].update(source_version=""), lambda m: m["star"].pop("tmag")):
            line = deepcopy(self.line)
            mutate(line["metadata"])
            self.assertIn("metadata", " ".join(gate.check_bundle(line, entry, active)))

    def test_manifest_must_be_valid_complete_and_match_the_attempt(self):
        check = gate.validator(SCHEMA, "manifest")
        self.assertEqual(gate.check_manifest(self.manifest, self.marker, check), [])
        self.assertIn("differs", gate.check_manifest(self.manifest, dict(self.marker, candidate_count=0), check)[0])
        incomplete = dict(self.manifest, complete=False)
        self.assertTrue(any("incomplete" in e for e in gate.check_manifest(incomplete, self.marker, check)))
        broken = {k: v for k, v in self.manifest.items() if k != "stars"}
        self.assertTrue(gate.check_manifest(broken, self.marker, check)[0].startswith("manifest:"))

    def test_candidate_lines_are_schema_checked_and_hashed_like_79(self):
        check = gate.validator(SCHEMA, "candidate")
        lines = [gate.parse(tess_gold._dumps(c)) for c in self.candidates]  # as the candidates output stores them
        self.assertTrue(lines and all(gate.check_candidate(line, check) == [] for line in lines))
        broken = deepcopy(lines[0])
        broken["ai"]["score"] = 0.9
        self.assertTrue(gate.check_candidate(broken, check))
        self.assertTrue(gate.check_candidate(gate.parse("[1, 2]"), check))
        ordered = sorted(lines, key=lambda c: (c["tic_id"], c["candidate_id"]))
        self.assertEqual(gate.stream_hash(gate.canonical(c) for c in ordered), self.manifest["candidates_sha256"])
        self.assertEqual(gate.stream_hash([]), tess_gold.content_hash([]))


if __name__ == "__main__":
    unittest.main()
