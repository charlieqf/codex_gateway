import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalSupportJson, supportHash, type SupportReport } from "./client-support.js";

export const supportSummaryRetentionMs = 30 * 86_400_000;
export const supportDetailsRetentionMs = 7 * 86_400_000;
export interface SupportRow {
  report_id: string;
  failure_id: string;
  subject_id: string | null;
  content_hash: string;
  summary_json: string;
  has_diagnostics: number;
  received_at: number;
}
export class SupportStorageFull extends Error {}

/** Uses the existing client-events connection. File names are derived only from validated IDs and server hashes. */
export class ClientSupportStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly directory: string,
    private readonly limits = { rows: 20_000, bytes: 256 * 1024 * 1024 }
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  get(id: string): SupportRow | undefined {
    return this.db.prepare("SELECT * FROM client_support_reports WHERE report_id = ?").get(id) as SupportRow | undefined;
  }

  list(input: { subjectId?: string; reportId?: string; failureId?: string; since: number; until: number; limit: number }): SupportRow[] {
    const clauses = ["received_at >= ?", "received_at <= ?"];
    const params: (string | number)[] = [input.since, input.until];
    for (const [column, value] of [["subject_id", input.subjectId], ["report_id", input.reportId], ["failure_id", input.failureId]]) {
      if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value); }
    }
    return this.db.prepare(`SELECT * FROM client_support_reports WHERE ${clauses.join(" AND ")} ORDER BY received_at DESC, report_id LIMIT ?`)
      .all(...params, input.limit) as unknown as SupportRow[];
  }

  save(report: SupportReport, subjectId: string | null, receivedAt: number): SupportRow {
    const json = canonicalSupportJson(report);
    const hash = supportHash(json);
    const previous = this.get(report.report_id);
    if (previous && previous.content_hash !== hash) throw new Error("Support report conflict.");
    const { diagnostics, ...summary } = report;
    const row: SupportRow = previous ?? {
      report_id: report.report_id, failure_id: report.failure_id, subject_id: subjectId,
      content_hash: hash, summary_json: JSON.stringify(summary), has_diagnostics: Number(diagnostics !== undefined), received_at: receivedAt
    };
    if (!previous) {
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM client_support_reports").get() as { n: number };
      if (count.n >= this.limits.rows) throw new SupportStorageFull();
    }
    if (row.has_diagnostics) this.writeDetails(row, json);
    // File first: an interrupted DB write leaves a reusable orphan, never a false stored ACK.
    if (!previous) this.db.prepare(`INSERT INTO client_support_reports
      (report_id, failure_id, subject_id, content_hash, summary_json, has_diagnostics, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.report_id, row.failure_id, row.subject_id, row.content_hash, row.summary_json, row.has_diagnostics, row.received_at);
    return row;
  }

  readDetails(row: SupportRow, now: number): string | null {
    if (!row.has_diagnostics || row.received_at + supportDetailsRetentionMs <= now) return null;
    const file = this.file(row);
    if (!existsSync(file)) return null;
    const json = readFileSync(file, "utf8");
    if (supportHash(json) !== row.content_hash) throw new Error("Support detail integrity failed.");
    return json;
  }

  prune(now: number): void {
    const keep = new Set((this.db.prepare("SELECT report_id, content_hash FROM client_support_reports WHERE has_diagnostics = 1 AND received_at > ?")
      .all(now - supportDetailsRetentionMs) as { report_id: string; content_hash: string }[])
      .map(row => `${row.report_id}-${row.content_hash}.json`));
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}-[a-f0-9]{64}(?:\.json|\.[a-f0-9-]{36}\.tmp)$/.test(entry.name)) continue;
      const file = join(this.directory, entry.name);
      // Original received_at governs indexed files; a retry cannot prolong their retention.
      const indexed = this.get(entry.name.slice(0, 36));
      if (!keep.has(entry.name) && ((indexed && indexed.received_at + supportDetailsRetentionMs <= now) ||
          statSync(file).mtimeMs + supportDetailsRetentionMs <= now)) unlinkSync(file);
    }
    this.db.prepare("DELETE FROM client_support_reports WHERE received_at <= ?").run(now - supportSummaryRetentionMs);
  }

  private file(row: Pick<SupportRow, "report_id" | "content_hash">): string {
    return join(this.directory, `${row.report_id}-${row.content_hash}.json`);
  }

  private writeDetails(row: SupportRow, json: string): void {
    const file = this.file(row);
    if (existsSync(file) && supportHash(readFileSync(file, "utf8")) === row.content_hash) return;
    const files = readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isFile());
    const bytes = files.reduce((total, entry) => total + statSync(join(this.directory, entry.name)).size, 0);
    if (files.length >= this.limits.rows || bytes + Buffer.byteLength(json) > this.limits.bytes) throw new SupportStorageFull();
    const temporary = join(this.directory, `${row.report_id}-${row.content_hash}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, json, { mode: 0o600, flag: "wx", flush: true });
      renameSync(temporary, file);
      if (process.platform !== "win32") {
        const fd = openSync(this.directory, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
