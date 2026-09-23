"""One-off, explicitly authorized reset of the unused SMS test account.

Run on R760 using /opt/medevidence-v2/.venv/bin/python. Default is read-only.
This is not a general account deletion API. Refuse any changed identity or usage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from datetime import datetime, timezone
import uuid

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

SUBJECT = "subj_9SByOERhCrtBYfVrz4anabAz"
EXTERNAL = "medevidence_test_262"
PROVIDER = "medevidence_billing"
CREDENTIAL = "cred_jyCpN_DBceAY1PHwLlF53w"
UNIFIED = "uck_6B2jkk17buNgoAH2"
PRINCIPAL = "7f3126531677447c998b757d0330b406"
UPSTREAM_KEY = "b3955d8e9c12403aa51be2440e55ebb5"
GW_DB = Path("/data/docker/volumes/codex_gateway_r760_gateway_state/_data/gateway.db")
BACKUP_ROOT = Path("/data/backups/codex-gateway")
GW_DELETE = ["billing_subject_events", "upstream_v2_bindings", "unified_client_keys", "access_credentials", "subjects"]
PG_DELETE = ["internal_idempotency_events", "api_keys", "api_principals"]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def ident(name):
    return '"' + name.replace('"', '""') + '"'


def collect_gateway(db):
    wanted = {
        "subject_id": SUBJECT, "target_user_id": SUBJECT,
        "credential_id": CREDENTIAL, "codex_credential_id": CREDENTIAL,
        "target_credential_id": CREDENTIAL, "rotates_id": CREDENTIAL,
        "unified_key_id": UNIFIED,
    }
    rows = {}
    for item in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        table = item[0]
        columns = {r[1] for r in db.execute(f"PRAGMA table_info({ident(table)})")}
        conditions = [(c, v) for c, v in wanted.items() if c in columns]
        if table == "subjects":
            conditions.append(("id", SUBJECT))
        if not conditions:
            continue
        query = " OR ".join(f"{ident(c)}=?" for c, _ in conditions)
        found = [dict(r) for r in db.execute(f"SELECT * FROM {ident(table)} WHERE {query}", [v for _, v in conditions])]
        if found:
            rows[table] = found
    return rows


def collect_upstream(db):
    rows = {}
    columns = db.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('principal_id','api_key_id')").fetchall()
    tables = {}
    for c in columns:
        tables.setdefault(c["table_name"], []).append(c["column_name"])
    for table, names in tables.items():
        query = sql.SQL("SELECT * FROM {} WHERE ").format(sql.Identifier(table)) + sql.SQL(" OR ").join(sql.SQL("{}=%s").format(sql.Identifier(c)) for c in names)
        found = db.execute(query, [PRINCIPAL if c == "principal_id" else UPSTREAM_KEY for c in names]).fetchall()
        if found:
            rows[table] = found
    return rows


def preflight(gateway, upstream):
    gw = collect_gateway(gateway)
    pg = collect_upstream(upstream)
    require(set(gw) == set(GW_DELETE) | {"admin_audit_events"}, "Unexpected Gateway dependencies or missing account")
    require(all(len(gw[t]) == 1 for t in GW_DELETE), "Gateway account/key/event cardinality changed")
    require(len(gw["admin_audit_events"]) == 2, "Gateway audit history changed")
    s = gw["subjects"][0]
    require((s["external_provider"], s["external_user_id"], s["state"], s["phone_number"], s["created_at"]) == (PROVIDER, EXTERNAL, "active", None, "2026-09-10T01:35:41.090Z"), "Gateway identity changed")
    require(gw["access_credentials"][0]["id"] == CREDENTIAL and gw["unified_client_keys"][0]["id"] == UNIFIED, "Gateway key identity changed")
    binding = gw["upstream_v2_bindings"][0]
    require((binding["v2_user_id"], binding["v2_key_id"]) == (PRINCIPAL, UPSTREAM_KEY), "Upstream binding changed")
    event = gw["billing_subject_events"][0]
    require((event["event_type"], event["status"], event["provider"], event["external_user_id"]) == ("create_subject", "applied", PROVIDER, EXTERNAL), "Billing event changed")
    require(gateway.execute("SELECT count(*) FROM billing_subject_events WHERE provider=? AND external_user_id=?", (PROVIDER, EXTERNAL)).fetchone()[0] == 1, "Additional billing events")
    require(gateway.execute("SELECT count(*) FROM external_subject_registrations WHERE provider=? AND external_user_id=?", (PROVIDER, EXTERNAL)).fetchone()[0] == 0, "Registration exists")
    require(set(pg) == set(PG_DELETE) and all(len(pg[t]) == 1 for t in PG_DELETE), "Upstream account has usage or unexpected dependencies")
    p = pg["api_principals"][0]
    require((p["principal_id"], p["external_provider"], p["external_user_id"], p["status"]) == (PRINCIPAL, "medevidence_backend", SUBJECT, "active"), "Upstream identity changed")
    k = pg["api_keys"][0]
    require(k["api_key_id"] == UPSTREAM_KEY and k["last_used_at"] is None and k["status"] == "active", "Upstream key used or changed")
    e = pg["internal_idempotency_events"][0]
    require((e["idempotency_key"], e["operation"], e["status"]) == (f"medevidence:{SUBJECT}:create_user", "create_user", "succeeded"), "Upstream event changed")
    require(gateway.execute("PRAGMA quick_check").fetchone()[0] == "ok" and not gateway.execute("PRAGMA foreign_key_check").fetchall(), "Gateway integrity failure")
    return gw, pg


def protected_json(path, value):
    data = json.dumps(value, ensure_ascii=False, default=str, indent=2).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, 0o400)
    digest = hashlib.sha256(data).hexdigest()
    require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, "Backup readback failed")
    return digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--gateway-backup")
    parser.add_argument("--gateway-backup-sha256")
    args = parser.parse_args()
    if args.apply:
        backup = Path(args.gateway_backup).resolve()
        require(backup.parent == BACKUP_ROOT and backup.is_file(), "Backup path outside approved root")
        require(hashlib.sha256(backup.read_bytes()).hexdigest() == args.gateway_backup_sha256, "Gateway backup mismatch")
        require(backup.stat().st_mode & 0o777 == 0o400, "Gateway backup permissions invalid")
        require(datetime.now().timestamp() - backup.stat().st_mtime < 1800, "Gateway backup too old")
    env = dict(x.split("=", 1) for x in Path("/proc/2069/environ").read_bytes().decode().split("\0") if "=" in x)
    gateway = sqlite3.connect(f"file:{GW_DB}?mode={'rw' if args.apply else 'ro'}", uri=True, timeout=5)
    gateway.row_factory = sqlite3.Row
    gateway.execute("PRAGMA foreign_keys=ON")
    upstream = psycopg.connect(env["MEDEVIDENCE_DATABASE_URL"], row_factory=dict_row)
    upstream_committed = False
    try:
        upstream.execute("SET LOCAL statement_timeout='15s'")
        upstream.execute("SET LOCAL lock_timeout='5s'")
        if args.apply:
            # Keep both snapshots stable across guard checks and deletion.
            gateway.execute("BEGIN IMMEDIATE")
            for table in PG_DELETE:
                upstream.execute(sql.SQL("SELECT * FROM {} WHERE principal_id=%s FOR UPDATE").format(sql.Identifier(table)), (PRINCIPAL,)).fetchall()
        else:
            gateway.execute("PRAGMA query_only=ON")
            upstream.execute("SET TRANSACTION READ ONLY")
        gw, pg = preflight(gateway, upstream)
        counts = {"gateway": {t: len(r) for t, r in gw.items()}, "upstream": {t: len(r) for t, r in pg.items()}}
        if not args.apply:
            print(json.dumps({"dry_run": True, "subject_id": SUBJECT, "external_user_id": EXTERNAL, "counts": counts}))
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        archive = BACKUP_ROOT / f"test262-reset-{stamp}-{uuid.uuid4().hex[:8]}"
        archive.mkdir(mode=0o700)
        digest = protected_json(archive / "before.json", {"gateway": gw, "upstream": pg, "full_gateway_backup": str(backup)})
        for table in PG_DELETE:
            result = upstream.execute(sql.SQL("DELETE FROM {} WHERE principal_id=%s").format(sql.Identifier(table)), (PRINCIPAL,))
            require(result.rowcount == 1, "Upstream delete count mismatch")
        for table in GW_DELETE:
            column = "id" if table == "subjects" else "subject_id"
            result = gateway.execute(f"DELETE FROM {ident(table)} WHERE {ident(column)}=?", (SUBJECT,))
            require(result.rowcount == 1, "Gateway delete count mismatch")
        audit_id = "audit_test_reset_" + uuid.uuid4().hex
        gateway.execute("INSERT INTO admin_audit_events (id,action,target_user_id,status,params_json,created_at) VALUES (?,?,?,?,?,?)", (audit_id, "reset_unused_billing_test_account", SUBJECT, "succeeded", json.dumps({"provider": PROVIDER, "external_user_id": EXTERNAL, "reason": "User requested fresh SMS signup retest after identity backend added phone", "backup": str(archive), "backup_sha256": digest, "deleted_counts": {"gateway": len(GW_DELETE), "upstream": len(PG_DELETE)}}), datetime.now(timezone.utc).isoformat()))
        require(set(collect_gateway(gateway)) == {"admin_audit_events"}, "Gateway dependencies remain")
        require(not collect_upstream(upstream), "Upstream dependencies remain")
        require(not gateway.execute("PRAGMA foreign_key_check").fetchall(), "Post-delete foreign key violation")
        upstream.commit()
        upstream_committed = True
        try:
            gateway.commit()
        except Exception:
            # Compensate the first commit if SQLite cannot commit.
            for table in reversed(PG_DELETE):
                for row in pg[table]:
                    upstream.execute(sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, row)), sql.SQL(",").join(sql.Placeholder() for _ in row)), list(row.values()))
            upstream.commit()
            raise
        require(gateway.execute("PRAGMA quick_check").fetchone()[0] == "ok", "Post-reset integrity failure")
        result = {"reset": True, "subject_id": SUBJECT, "external_user_id": EXTERNAL, "archive": str(archive), "archive_sha256": digest, "audit_id": audit_id, "deleted": {"gateway_rows": len(GW_DELETE), "upstream_rows": len(PG_DELETE)}, "old_audit_events_preserved": len(gw["admin_audit_events"]), "quick_check": "ok", "foreign_key_violations": 0, "completed_at": datetime.now(timezone.utc).isoformat()}
        protected_json(archive / "result.json", result)
        print(json.dumps(result))
    except Exception as error:
        gateway.rollback()
        upstream.rollback()
        # Do not emit database exception details which may contain credential data.
        print(json.dumps({"reset_failed": True, "error_type": type(error).__name__, "upstream_commit_attempted": upstream_committed}))
        raise SystemExit(1) from None
    finally:
        gateway.close()
        upstream.close()


if __name__ == "__main__":
    main()
