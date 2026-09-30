import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../imaging/contract.js";
import { ClinicalError, retention, terminal, type Input, type Job } from "./contract.js";

export type Action = "cancel" | "delete" | "complete";
export type Intent = { subject: string; key: string; fingerprint: string; input: Input | null; id: string | null; job: Job | null;
  created: number; expires: number; state: string; revoked: boolean; action: Action | null; errorStatus: number | null; errorCode: string | null };
export type Limits = { dailyJobs: number; activeJobs: number };
type Row = Record<string, unknown>;

export class ClinicalStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (Number(this.db.prepare("PRAGMA user_version").get()!.user_version) > 1 || tables.some(t => !["clinical_intents", "clinical_inputs", "clinical_audit"].includes(String(t.name)))) throw new ClinicalError(503, "unavailable");
      this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS clinical_intents (
          subject TEXT NOT NULL, idem_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, resource_id TEXT UNIQUE, resource_json TEXT,
          created REAL NOT NULL, expires REAL NOT NULL, synced REAL NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending',
          revoked INTEGER NOT NULL DEFAULT 0, pending_action TEXT, error_status INTEGER, error_code TEXT,
          PRIMARY KEY(subject,idem_hash));
        CREATE INDEX IF NOT EXISTS clinical_admission ON clinical_intents(subject,created);
        CREATE TABLE IF NOT EXISTS clinical_inputs (
          subject TEXT NOT NULL, idem_hash TEXT NOT NULL, input_json TEXT NOT NULL, expires REAL NOT NULL,
          PRIMARY KEY(subject,idem_hash), FOREIGN KEY(subject,idem_hash) REFERENCES clinical_intents(subject,idem_hash) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS clinical_audit (id INTEGER PRIMARY KEY, at REAL NOT NULL, subject TEXT, request_id TEXT NOT NULL,
          operation TEXT NOT NULL, resource_id TEXT, status INTEGER NOT NULL, error_code TEXT);
        PRAGMA user_version=1;`);
      if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
  private query(where: string, values: (string | number)[]): Intent | null {
    const row = this.db.prepare(`SELECT i.*,p.input_json FROM clinical_intents i LEFT JOIN clinical_inputs p USING(subject,idem_hash) WHERE ${where}`).get(...values) as Row | undefined;
    if (!row) return null;
    return { subject: String(row.subject), key: String(row.idem_hash), fingerprint: String(row.fingerprint), input: row.input_json ? JSON.parse(String(row.input_json)) as Input : null,
      id: row.resource_id as string | null, job: row.resource_json ? JSON.parse(String(row.resource_json)) as Job : null, created: Number(row.created), expires: Number(row.expires),
      state: String(row.state), revoked: Boolean(row.revoked), action: row.pending_action as Action | null, errorStatus: row.error_status as number | null, errorCode: row.error_code as string | null };
  }
  find(subject: string, key: string) { return this.query("i.subject=? AND i.idem_hash=?", [subject, key]); }
  get(subject: string, id: string, now: number, includeRevoked = false) {
    const intent = this.query("i.subject=? AND i.resource_id=?", [subject, id]);
    if (!intent || intent.expires <= now || (!includeRevoked && intent.revoked)) throw new ClinicalError(404, "not_found");
    return intent;
  }
  reserve(subject: string, key: string, input: Input, now: number, limits: Limits) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const hash = sha256(JSON.stringify(input)), previous = this.find(subject, key);
      if (previous && previous.fingerprint !== hash) throw new ClinicalError(409, "idempotency_conflict");
      if (previous && (previous.expires <= now || previous.revoked)) throw new ClinicalError(404, "not_found");
      if (!previous || (!previous.id && previous.errorStatus === 429)) {
        const active = this.db.prepare("SELECT count(*) AS n FROM clinical_intents WHERE subject=? AND expires>? AND state IN ('pending','uploading','queued','running','cancel_requested','deleting')").get(subject, now)!;
        if (Number(active.n) >= limits.activeJobs) throw new ClinicalError(429, "queue_full");
      }
      if (!previous) {
        const daily = this.db.prepare("SELECT count(*) AS n FROM clinical_intents WHERE subject=? AND created>=?").get(subject, Math.floor(now / 86400) * 86400)!;
        if (Number(daily.n) >= limits.dailyJobs) throw new ClinicalError(429, "quota_exceeded");
        this.db.prepare("INSERT INTO clinical_intents(subject,idem_hash,fingerprint,created,expires) VALUES(?,?,?,?,?)").run(subject, key, hash, now, now + retention);
        this.db.prepare("INSERT INTO clinical_inputs VALUES(?,?,?,?)").run(subject, key, JSON.stringify(input), now + retention);
      } else if (!previous.id && previous.errorStatus === 429) this.db.prepare("UPDATE clinical_intents SET state='pending',error_status=NULL,error_code=NULL WHERE subject=? AND idem_hash=?").run(subject, key);
      this.db.exec("COMMIT");
      return { intent: this.find(subject, key)!, replay: Boolean(previous) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  save(intent: Intent, job: Job, now: number) {
    const current = this.find(intent.subject, intent.key)!;
    if (current.id && current.id !== job.job_id) throw new ClinicalError(503, "upstream_protocol_error");
    if (current.revoked || current.expires <= now) return current;
    if (current.job && (current.job.updated_at > job.updated_at || (terminal.has(current.state) && !terminal.has(job.state)))) return current;
    if (current.job?.artifacts && JSON.stringify(current.job.artifacts) !== JSON.stringify(job.artifacts)) throw new ClinicalError(503, "upstream_protocol_error");
    if (current.action === "cancel" && !terminal.has(job.state)) job = { ...job, state: "cancel_requested" };
    job = { ...job, expires_at: Math.min(current.expires, job.expires_at) };
    this.db.prepare(`UPDATE clinical_intents SET resource_id=?,resource_json=?,state=?,expires=?,synced=?,error_status=NULL,error_code=NULL,
      pending_action=CASE WHEN ? THEN NULL ELSE pending_action END WHERE subject=? AND idem_hash=?`)
      .run(job.job_id, JSON.stringify(job), job.state, job.expires_at, now, terminal.has(job.state) ? 1 : 0, intent.subject, intent.key);
    return this.find(intent.subject, intent.key)!;
  }
  failure(intent: Intent, status: number, code: string, now: number) {
    this.db.prepare("UPDATE clinical_intents SET error_status=?,error_code=?,synced=?,state=CASE WHEN resource_id IS NULL AND ? THEN 'rejected' ELSE state END WHERE subject=? AND idem_hash=?")
      .run(status, code, now, status !== 503 ? 1 : 0, intent.subject, intent.key);
  }
  action(subject: string, id: string, action: Action, now: number) {
    const intent = this.get(subject, id, now, action === "delete");
    if (intent.revoked || (action === "cancel" && terminal.has(intent.state))) return intent;
    if (action !== "delete" && intent.action && intent.action !== action) throw new ClinicalError(409, "state_conflict");
    const job = { ...intent.job!, ...(action === "delete" ? { state: "deleting" } : action === "cancel" ? { state: "cancel_requested" } : {}) };
    this.db.prepare("UPDATE clinical_intents SET pending_action=?,revoked=?,state=?,resource_json=?,synced=0 WHERE subject=? AND idem_hash=?")
      .run(action, action === "delete" ? 1 : 0, job.state, JSON.stringify(job), subject, intent.key);
    if (action === "delete") this.db.prepare("DELETE FROM clinical_inputs WHERE subject=? AND idem_hash=?").run(subject, intent.key);
    return this.find(subject, intent.key)!;
  }
  actionDone(intent: Intent, now: number) {
    this.db.prepare("UPDATE clinical_intents SET pending_action=NULL,synced=?,state=CASE WHEN revoked=1 THEN 'deleted' ELSE state END WHERE subject=? AND idem_hash=?").run(now, intent.subject, intent.key);
  }
  clearAction(intent: Intent) { this.db.prepare("UPDATE clinical_intents SET pending_action=NULL WHERE subject=? AND idem_hash=?").run(intent.subject, intent.key); }
  expire(intent: Intent, now: number) {
    this.db.prepare("UPDATE clinical_intents SET revoked=1,state='expired',expires=?,pending_action=NULL WHERE subject=? AND idem_hash=?").run(Math.min(now, intent.expires), intent.subject, intent.key);
    this.db.prepare("DELETE FROM clinical_inputs WHERE subject=? AND idem_hash=?").run(intent.subject, intent.key);
  }
  candidates(now: number): Intent[] {
    const rows = this.db.prepare(`SELECT subject,idem_hash FROM clinical_intents WHERE expires>? AND synced<? AND
      (pending_action IS NOT NULL OR (revoked=0 AND state IN ('pending','uploading','queued','running','cancel_requested'))) ORDER BY synced,created LIMIT 8`).all(now, now - 2);
    return rows.map(r => this.find(String(r.subject), String(r.idem_hash))!);
  }
  touch(intent: Intent, now: number) { this.db.prepare("UPDATE clinical_intents SET synced=? WHERE subject=? AND idem_hash=?").run(now, intent.subject, intent.key); }
  prune(now: number) {
    // Sensitive inputs never share the 30-day control/audit tombstone retention.
    const removed = this.db.prepare("DELETE FROM clinical_inputs WHERE expires<=?").run(now);
    this.db.prepare("DELETE FROM clinical_intents WHERE rowid IN (SELECT rowid FROM clinical_intents WHERE expires<? LIMIT 100)").run(now - 30 * retention);
    this.db.prepare("DELETE FROM clinical_audit WHERE id IN (SELECT id FROM clinical_audit WHERE at<? LIMIT 1000)").run(now - 30 * retention);
    if (removed.changes) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  audit(subject: string | null, request: string, operation: string, id: string | null, status: number, code: string | null, now: number) {
    this.db.prepare("INSERT INTO clinical_audit(at,subject,request_id,operation,resource_id,status,error_code) VALUES(?,?,?,?,?,?,?)").run(now, subject, request, operation, id, status, code);
  }
}
