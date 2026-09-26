"""DEC-01 공급 집계 기록 자기 검사. DB 없이 돈다: python -m unittest test_supply (publisher 디렉터리에서).

DB 조회 SQL과 planetory_app 읽기 권한은 test_load의 SupplyReadTest가 실제 PostgreSQL에서 본다.
"""

import unittest

from publisher.supply import THRESHOLD, supply_record

AT = "2026-09-27T00:00:00Z"


def manifest(statuses, complete=True):
    """statuses: {tic_id: status}. ready TIC마다 판 버전 pv1-<tic>을 가진 79 manifest."""
    return dict(run_id="run-fixture", silver_attempt="silver/fixture", aggregator_version="agg-fixture",
                complete=complete, target_tic_count=len(statuses), candidates_sha256="0" * 64,
                calculation_versions={"ai_model": "none/policy-hold-118"},
                stars=[dict(tic_id=t, status=s, reasons=[]) for t, s in statuses.items()],
                bundles=[dict(tic_id=t, bundle_version=f"pv1-{t}") for t, s in statuses.items() if s == "ready"])


def row(tic, version=None, status="published", discoverable=True):
    return dict(tic_id=tic, service_status=status, bundle_version=version or f"pv1-{tic}", discoverable=discoverable)


READY = list(range(1, THRESHOLD + 1))
TUTORIALS = {seq: 9000 + seq for seq in range(1, 6)}


def record(statuses, rows=None, slots=TUTORIALS, complete=True):
    rows = [row(t) for t, s in statuses.items() if s == "ready"] if rows is None else rows
    seen = {r["tic_id"] for r in rows}
    tutorial_rows = [row(t, "pv1-tutorial") for t in slots.values() if t not in seen]
    return supply_record(manifest(statuses, complete), rows + tutorial_rows, slots, AT)


class SupplyRecordTest(unittest.TestCase):
    def test_hundred_servable_stars_and_five_tutorials_pass(self):
        r = record({t: "ready" for t in READY})
        self.assertEqual((r["verdict"], r["determined"], r["counts"]["supply"]), ("pass", True, THRESHOLD))
        self.assertEqual(r["tutorial"], dict(active_seqs=[1, 2, 3, 4, 5], ready_seqs=[1, 2, 3, 4, 5], complete=True))
        self.assertEqual((r["aggregated_at"], r["run_id"], len(r["manifest_sha256"])), (AT, "run-fixture", 64))

    def test_active_tutorial_star_in_the_run_is_not_general_supply(self):
        slots = {**TUTORIALS, 1: READY[0]}
        r = record({t: "ready" for t in READY}, slots=slots)
        self.assertEqual((r["counts"]["tutorial_excluded"], r["counts"]["supply"]), (1, THRESHOLD - 1))
        self.assertNotIn(READY[0], r["supply_tic_ids"])
        self.assertEqual(r["verdict"], "short")

    def test_inactive_tutorial_slot_fails_the_tutorial_condition(self):
        # 비활성 슬롯은 슬롯 목록에 없다. 그 별은 발견 풀에 풀리므로 일반 공급으로 센다.
        slots = {seq: tic for seq, tic in TUTORIALS.items() if seq != 5}
        r = record({t: "ready" for t in READY}, slots=slots)
        self.assertEqual((r["tutorial"]["complete"], r["counts"]["supply"], r["verdict"]), (False, THRESHOLD, "short"))

    def test_open_run_or_missing_publication_is_undetermined_not_pass(self):
        self.assertEqual(record({t: "ready" for t in READY}, complete=False)["verdict"], "undetermined")
        rows = [row(t) for t in READY[1:]] + [row(READY[0], "pv1-older")]
        r = record({t: "ready" for t in READY}, rows=rows)
        self.assertEqual((r["verdict"], r["publish_missing_tic_ids"]), ("undetermined", [READY[0]]))
        self.assertEqual(record({t: "ready" for t in READY}, rows=[row(t) for t in READY[1:]])["counts"]
                         ["publish_missing"], 1)

    def test_every_status_is_counted_once_and_only_servable_ready_stars_supply(self):
        statuses = {1: "ready", 2: "ready", 3: "ready", 4: "held", 5: "no_signal", 6: "request_failed",
                    7: "rejected", 8: "unprocessed"}
        rows = [row(1), row(2, discoverable=False), row(3, status="hidden"), row(4), row(900_000_008)]
        c = record(statuses, rows=rows, complete=False)["counts"]
        self.assertEqual(c, dict(total=8, ready=3, unprocessed=1, failed=2, held=1, no_signal=1, publish_missing=0,
                                 not_servable=2, tutorial_excluded=0, supply=1))
        self.assertEqual(c["ready"], c["publish_missing"] + c["not_servable"] + c["tutorial_excluded"] + c["supply"])


if __name__ == "__main__":
    unittest.main()
