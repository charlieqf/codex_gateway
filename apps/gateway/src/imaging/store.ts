import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImagingError, fingerprint, resourceId, retentionSeconds, type CreateInput, type Kind, type Manifest, type Part, type Resource } from "./contract.js";

export interface ImagingLimits {
  dailyJobs: number;
  activeJobs: number;
  dailyStudies: number;
  activeStudies: number;
}
export const defaultImagingLimits: ImagingLimits = { dailyJobs: 10, activeJobs: 1, dailyStudies: 20, activeStudies: 4 };
export interface Intent {
  subject: string; key: string; kind: Kind; fingerprint: string; input: CreateInput;
  resourceId: string | null; resource: Resource | null; created: number; expires: number;
  revoked: boolean; pendingAction: "cancel" | "delete" | null; errorStatus: number | null; errorCode: string | null;
}
type Row = Record<string, unknown>;

/** Separate database: never migrates or writes the identity, billing or chat stores. */
export class ImagingStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (![0, 1].includes(version) || tables.some(t => !["imaging_intents", "imaging_parts", "imaging_results", "imaging_audit"].includes(String(t.name)))) {
        throw new ImagingError(503, "unavailable");
      }
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS imaging_intents (
          subject TEXT NOT NULL, idem_hash TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
          input_json TEXT NOT NULL, resource_id TEXT UNIQUE, parent_id TEXT, resource_json TEXT,
          state TEXT NOT NULL DEFAULT 'pending', created REAL NOT NULL, expires REAL NOT NULL,
          synced REAL NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, pending_action TEXT,
          error_status INTEGER, error_code TEXT, gpu_seconds REAL,
          PRIMARY KEY(subject, idem_hash));
        CREATE INDEX IF NOT EXISTS imaging_subject_admission ON imaging_intents(subject, kind, created);
        CREATE INDEX IF NOT EXISTS imaging_parent ON imaging_intents(parent_id);
        CREATE TABLE IF NOT EXISTS imaging_parts (
          resource_id TEXT NOT NULL REFERENCES imaging_intents(resource_id) ON DELETE CASCADE,
          part_index INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(resource_id,part_index));
        CREATE TABLE IF NOT EXISTS imaging_results (
          resource_id TEXT PRIMARY KEY REFERENCES imaging_intents(resource_id) ON DELETE CASCADE, manifest_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS imaging_audit (
          id INTEGER PRIMARY KEY, at REAL NOT NULL, subject TEXT, request_id TEXT NOT NULL,
          operation TEXT NOT NULL, resource_id TEXT, status INTEGER NOT NULL, error_code TEXT);
        CREATE INDEX IF NOT EXISTS imaging_audit_retention ON imaging_audit(at);
        PRAGMA user_version=1;`);
      if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) { if (existsSync(file)) chmodSync(file, 0o600); }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  find(subject: string, key: string): Intent | null {
    return this.decode(this.db.prepare("SELECT * FROM imaging_intents WHERE subject=? AND idem_hash=?").get(subject, key));
  }
  get(subject: string, id: string, now: number, includeRevoked = false): Intent {
    const item = this.decode(this.db.prepare("SELECT * FROM imaging_intents WHERE subject=? AND resource_id=?").get(subject, id));
    if (!item || item.expires <= now || (!includeRevoked && (item.revoked || ["deleted", "deleting", "expired"].includes(item.resource?.state ?? "")))) throw new ImagingError(404, "not_found");
    if (!includeRevoked && item.kind === "job") this.get(subject, (item.input as { study_id: string }).study_id, now);
    return item;
  }
  reserve(subject: string, key: string, kind: Kind, input: CreateInput, now: number, limits: ImagingLimits): { intent: Intent; replay: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.find(subject, key);
      const hash = fingerprint(kind, input);
      if (previous) {
        if (previous.fingerprint !== hash || previous.kind !== kind) throw new ImagingError(409, "idempotency_conflict");
        if (previous.expires <= now || previous.revoked) throw new ImagingError(404, "not_found");
        if (!previous.resourceId && previous.errorStatus === 429) {
          const active = this.db.prepare(`SELECT count(*) AS n FROM imaging_intents WHERE subject=? AND kind=? AND expires>? AND
            state IN ('pending','uploading','validating','queued','preprocessing','running','postprocessing','cancel_requested')`).get(subject, kind, now) as Row;
          if (Number(active.n) >= (kind === "job" ? limits.activeJobs : limits.activeStudies)) throw new ImagingError(429, "queue_full");
          this.db.prepare("UPDATE imaging_intents SET state='pending',error_status=NULL,error_code=NULL WHERE subject=? AND idem_hash=?").run(subject, key);
        }
        this.db.exec("COMMIT");
        return { intent: this.find(subject, key)!, replay: true };
      }
      const since = Math.floor(now / 86400) * 86400;
      const daily = this.db.prepare("SELECT count(*) AS n FROM imaging_intents WHERE subject=? AND kind=? AND created>=?").get(subject, kind, since) as Row;
      const active = this.db.prepare(`SELECT count(*) AS n FROM imaging_intents WHERE subject=? AND kind=? AND expires>? AND
        state IN ('pending','uploading','validating','queued','preprocessing','running','postprocessing','cancel_requested')`).get(subject, kind, now) as Row;
      if (Number(daily.n) >= (kind === "job" ? limits.dailyJobs : limits.dailyStudies)) throw new ImagingError(429, "quota_exceeded");
      if (Number(active.n) >= (kind === "job" ? limits.activeJobs : limits.activeStudies)) throw new ImagingError(429, "queue_full");
      const parent = kind === "job" ? (input as { study_id: string }).study_id : null;
      const expires = parent ? Math.min(now + retentionSeconds, this.get(subject, parent, now).expires) : now + retentionSeconds;
      this.db.prepare(`INSERT INTO imaging_intents(subject,idem_hash,kind,fingerprint,input_json,parent_id,created,expires)
        VALUES(?,?,?,?,?,?,?,?)`).run(subject, key, kind, hash, JSON.stringify(input), parent, now, expires);
      this.db.exec("COMMIT");
      return { intent: this.find(subject, key)!, replay: false };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  save(intent: Intent, value: Resource, now: number): Intent {
    const current = this.find(intent.subject, intent.key)!;
    const id = resourceId(value);
    if (current.resourceId && current.resourceId !== id) throw new ImagingError(503, "upstream_protocol_error");
    // A response in flight cannot undo local deletion, cancellation or expiry.
    if (current.revoked || current.expires <= now) return current;
    if (current.pendingAction === "cancel" && !["completed", "failed", "cancelled", "expired"].includes(value.state)) {
      value = { ...value, state: "cancel_requested", ...("job_id" in value ? { stage: "cancel_requested" } : {}) };
    }
    const previous = current.resource;
    if (previous && "job_id" in previous && "job_id" in value && previous.updated_at > value.updated_at) return current;
    if (previous && ["completed", "failed", "cancelled", "rejected", "ready"].includes(previous.state) &&
      ["uploading", "validating", "queued", "preprocessing", "running", "postprocessing"].includes(value.state)) return current;
    const expiry = Math.min(current.expires, value.expires_at);
    value = { ...value, expires_at: expiry };
    this.db.prepare(`UPDATE imaging_intents SET resource_id=?,resource_json=?,state=?,expires=?,synced=?,error_status=NULL,error_code=NULL,
      pending_action=CASE WHEN ? IN ('completed','failed','cancelled','expired') THEN NULL ELSE pending_action END
      WHERE subject=? AND idem_hash=?`).run(id, JSON.stringify(value), value.state, expiry, now, value.state, intent.subject, intent.key);
    return this.find(intent.subject, intent.key)!;
  }
  failure(intent: Intent, error: ImagingError, now: number): void {
    // A definite queue rejection must not unexpectedly become a GPU run during background recovery.
    // Its original key can be resubmitted explicitly after fresh concurrency admission.
    const definitive = error.status !== 503;
    this.db.prepare(`UPDATE imaging_intents SET error_status=?,error_code=?,synced=?,
      state=CASE WHEN resource_id IS NULL AND ? THEN 'rejected' ELSE state END WHERE subject=? AND idem_hash=?`)
      .run(error.status, error.code, now, definitive ? 1 : 0, intent.subject, intent.key);
  }
  action(subject: string, id: string, action: "cancel" | "delete", now: number): Intent {
    const intent = this.get(subject, id, now, action === "delete");
    if (action === "cancel" && ["completed", "failed", "cancelled", "expired"].includes(intent.resource!.state)) return intent;
    const value = { ...intent.resource!, state: action === "delete" ? "deleting" : "cancel_requested",
      ...(action === "cancel" ? { stage: "cancel_requested" } : {}) };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE imaging_intents SET pending_action=?,revoked=?,state=?,resource_json=?,synced=0 WHERE subject=? AND resource_id=?")
        .run(action, action === "delete" ? 1 : 0, value.state, JSON.stringify(value), subject, id);
      if (action === "delete") {
        this.db.prepare("UPDATE imaging_intents SET revoked=1 WHERE subject=? AND parent_id=?").run(subject, id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.find(subject, intent.key)!;
  }
  actionDone(intent: Intent, now: number): void {
    this.db.prepare("UPDATE imaging_intents SET pending_action=NULL,synced=? WHERE subject=? AND idem_hash=?").run(now, intent.subject, intent.key);
    if (intent.pendingAction === "delete") {
      this.db.prepare("UPDATE imaging_intents SET state='expired',expires=? WHERE subject=? AND parent_id=? AND resource_id IS NULL")
        .run(now, intent.subject, intent.resourceId);
    }
  }
  revokedStatus(intent: Intent, state: string, now: number): void {
    this.db.prepare("UPDATE imaging_intents SET state=?,synced=? WHERE subject=? AND idem_hash=? AND revoked=1")
      .run(state, now, intent.subject, intent.key);
  }
  expire(intent: Intent, now: number): void {
    this.db.prepare("UPDATE imaging_intents SET expires=?,state='expired',revoked=1,pending_action=NULL,synced=? WHERE subject=? AND idem_hash=?")
      .run(Math.min(intent.expires, now), now, intent.subject, intent.key);
  }
  syncCandidates(now: number, limit = 8): Intent[] {
    return this.db.prepare(`SELECT * FROM imaging_intents WHERE expires>? AND synced<? AND
      (pending_action IS NOT NULL OR ((revoked=0 OR (kind='job' AND resource_id IS NOT NULL)) AND state IN ('pending','uploading','validating','queued','preprocessing','running','postprocessing','cancel_requested')))
      ORDER BY synced,created LIMIT ?`).all(now, now - 2, limit).map(row => this.decode(row)!);
  }
  touch(intent: Intent, now: number): void {
    this.db.prepare("UPDATE imaging_intents SET synced=? WHERE subject=? AND idem_hash=?").run(now, intent.subject, intent.key);
  }
  saveParts(id: string, parts: Part[]): void {
    const insert = this.db.prepare("INSERT INTO imaging_parts VALUES(?,?,?,?) ON CONFLICT(resource_id,part_index) DO UPDATE SET size=excluded.size,sha256=excluded.sha256");
    for (const part of parts) insert.run(id, part.index, part.size, part.sha256);
  }
  saveManifest(id: string, manifest: Manifest): void {
    const previous = this.db.prepare("SELECT manifest_json FROM imaging_results WHERE resource_id=?").get(id) as Row | undefined;
    const json = JSON.stringify(manifest);
    if (previous && previous.manifest_json !== json) throw new ImagingError(503, "upstream_protocol_error");
    this.db.prepare("INSERT OR IGNORE INTO imaging_results VALUES(?,?)").run(id, json);
  }
  audit(subject: string | null, requestId: string, operation: string, id: string | null, status: number, code: string | null, now: number): void {
    this.db.prepare("INSERT INTO imaging_audit(at,subject,request_id,operation,resource_id,status,error_code) VALUES(?,?,?,?,?,?,?)")
      .run(now, subject, requestId, operation, id, status, code);
  }
  prune(now: number): void {
    // File access expires at 24h. Control/audit tombstones retain 30 days for recovery and quota accounting.
    this.db.prepare("DELETE FROM imaging_audit WHERE id IN (SELECT id FROM imaging_audit WHERE at<? LIMIT 1000)").run(now - 30 * 86400);
    this.db.prepare("DELETE FROM imaging_intents WHERE rowid IN (SELECT rowid FROM imaging_intents WHERE expires<? LIMIT 100)").run(now - 30 * 86400);
  }
  private decode(row: Row | undefined): Intent | null {
    if (!row) return null;
    return { subject: String(row.subject), key: String(row.idem_hash), kind: row.kind as Kind, fingerprint: String(row.fingerprint), input: JSON.parse(String(row.input_json)) as CreateInput,
      resourceId: row.resource_id as string | null, resource: row.resource_json ? JSON.parse(String(row.resource_json)) as Resource : null,
      created: Number(row.created), expires: Number(row.expires), revoked: Boolean(row.revoked), pendingAction: row.pending_action as Intent["pendingAction"], errorStatus: row.error_status as number | null, errorCode: row.error_code as string | null };
  }
}
