"""125 local, transaction-rolled-back DB projection check; never publishes."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import secrets
from ipaddress import ip_address

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb

from .canonical import array_checksum, normalize_array
from .connection_replay import audit, entry, read, write
from .roundtrip import DEFAULT_URL, MIGRATIONS

NUMERIC = {"period_days", "epoch_btjd", "duration_hours", "depth_ppm", "bls_power",
           "flux_scatter", "base_days", "period_min_days", "period_max_days"}


def local_connection_parameters(url):
    """Reject libpq routing overrides and pin localhost before connecting."""
    try:
        params = conninfo_to_dict(url)
    except psycopg.Error:
        raise ValueError("local_database_required") from None
    if (params.get("host") not in ("127.0.0.1", "localhost", "::1")
            or "hostaddr" in params or "service" in params
            or any(os.environ.get(k) for k in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"))):
        raise ValueError("local_database_required")
    params["hostaddr"] = "::1" if params["host"] == "::1" else "127.0.0.1"
    params["connect_timeout"] = 5
    return params


def require_local_connection(conn):
    # libpq's connected address, not a server-side address behind Docker NAT.
    try:
        local = ip_address(conn.info.hostaddr).is_loopback
    except (ValueError, TypeError):
        local = False
    if not local:
        raise ValueError("connected_database_not_local")


def insert_and_compare(cur, table, row, checks):
    columns = list(row)
    values = [Jsonb(v) if isinstance(v, dict) or k == "gaps" else
              Decimal(repr(float(v))) if k in NUMERIC and v is not None else v
              for k, v in row.items()]
    cur.execute(sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING {}").format(
        sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, columns)),
        sql.SQL(",").join(sql.Placeholder() for _ in columns),
        sql.SQL(",").join(map(sql.Identifier, columns))), values)
    returned = dict(zip(columns, cur.fetchone(), strict=True))
    for key, expected in row.items():
        actual = returned[key]
        if key in NUMERIC and actual is not None:
            actual = float(actual)
        if key == "fetched_on":
            actual = actual.isoformat()
        if actual != expected:
            raise ValueError(f"roundtrip_mismatch:{table}:{key}")
        checks.append(f"{table}:{key}")
    return returned


def run(folder, report):
    # This harness accepts the local development DB only. Never print its URL.
    url = os.environ.get("DATABASE_URL", DEFAULT_URL)
    parameters = local_connection_parameters(url)
    verified = audit(folder)
    evidence = read(folder / "report.json")
    if evidence.get("fixture_ids_only") is not True or evidence.get("controlled_labels_only") is not True:
        raise ValueError("controlled_fixture_required")
    files = [folder / c["controlled_file"] for c in evidence["curves"] if "controlled_file" in c]
    if not files:
        raise ValueError("no_controlled_payloads")
    results = []
    for path in files:
        if str(path.resolve()) not in verified:
            raise ValueError("unregistered_payload")
        obj = read(path)
        if obj.get("status") != "validated" or obj.get("publishable") is not False:
            raise ValueError("invalid_staging_proposal")
        p = obj["payload"]
        if p["ai_results"]:
            raise ValueError("internal_ai_forbidden")
        schema, checks = "gold125_" + secrets.token_hex(6), []
        conn = psycopg.connect(**parameters)
        try:
            require_local_connection(conn)
            with conn.cursor() as cur:
                cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
                cur.execute(sql.SQL("SET LOCAL search_path TO {}, public").format(sql.Identifier(schema)))
                for migration in MIGRATIONS:
                    cur.execute(migration.read_text(encoding="utf-8"))
                cur.execute("SET LOCAL extra_float_digits = 3")
            with conn.cursor(binary=True) as cur:
                insert_and_compare(cur, "stars", dict(tic_id=p["bundle"]["tic_id"], confirmed_count=0,
                                                       service_status="hidden"), checks)
                bundle = dict(p["bundle"], status="staging")
                insert_and_compare(cur, "publication_bundles", bundle, checks)
                for segment in p["segments"]:
                    row = insert_and_compare(cur, "light_curve_segments", segment, checks)
                    values = normalize_array(row["flux"])
                    expected = bundle["manifest"]["array_checksums"][f"segment:{row['id']}:flux"]
                    if array_checksum(values) != expected:
                        raise ValueError("db_flux_checksum_mismatch")
                pg = insert_and_compare(cur, "periodograms", p["periodogram"], checks)
                if array_checksum(normalize_array(pg["power"], allow_null=False)) != bundle["manifest"]["array_checksums"][f"periodogram:{bundle['id']}:power"]:
                    raise ValueError("db_power_checksum_mismatch")
                for row in p["candidates"]:
                    insert_and_compare(cur, "candidates", row, checks)
                applied_at = datetime.now(timezone.utc)
                for row in p["candidate_dispositions"]:
                    insert_and_compare(cur, "candidate_dispositions", dict(row, applied_at=applied_at), checks)
                for row in p.get("candidate_aliases", []):
                    insert_and_compare(cur, "candidate_aliases", row, checks)
                for row in p.get("history_proposals", []):
                    projected = {k: row[k] for k in ("candidate_id", "bundle_id", "field", "old_value",
                                                     "new_value", "rule_version", "reason")}
                    insert_and_compare(cur, "candidate_status_history", dict(projected, changed_at=applied_at), checks)
                for row in p["external_statuses"]:
                    insert_and_compare(cur, "external_signal_references",
                                       {k: v for k, v in row.items() if k != "candidate_key"}, checks)
                cur.execute("SELECT count(*) FROM publication_bundles WHERE status='current'")
                if cur.fetchone()[0] != 0:
                    raise ValueError("unexpected_current")
            results.append(dict(file=path.name, checks=len(checks), passed=True, rolled_back=True))
        finally:
            # Schema, migration effects and INSERTs share one transaction.
            # No COMMIT or DROP statement: rollback removes this test's changes.
            conn.rollback()
            conn.close()
    for e in verified.values():
        if entry(e["path"])["sha256"] != e["sha256"]:
            raise ValueError("payload_changed_during_db_check")
    report.parent.mkdir(parents=True, exist_ok=True)
    write(report, dict(task="S15P21C206-125", passed=True, fixtures=results,
        migrations=[entry(p) for p in MIGRATIONS], inputs=list(verified.values()),
        code=[entry(Path(__file__))],
        production_verified=False, current_transition_tested=False,
        scope="local fresh schema, controlled labels/IDs, rollback only"))
    print(f"PASS: {len(results)} payloads; all transactions rolled back; {report}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection-run", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        raise ValueError("report_already_exists")
    run(args.connection_run.resolve(), args.report)


if __name__ == "__main__":
    main()
