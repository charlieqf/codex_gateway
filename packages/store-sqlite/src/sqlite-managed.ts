import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteStoreLogger } from "./types.js";

export function openConfiguredSqliteDatabase(dbPath: string): DatabaseSync {
  ensureSqliteFile(dbPath);
  const db = new DatabaseSync(dbPath);
  configureSqliteDatabase(db);
  return db;
}

export function configureSqliteDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
}

export function applyMigration(
  db: DatabaseSync,
  version: number,
  migration: string | (() => void),
  logger?: SqliteStoreLogger
): void {
  const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version);
  if (existing) {
    return;
  }

  db.exec("BEGIN");
  try {
    if (typeof migration === "string") {
      db.exec(migration);
    } else {
      migration();
    }
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      version,
      new Date().toISOString()
    );
    db.exec("COMMIT");
    logger?.info(`SQLite schema migrated to v${version}.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

export function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function tightenSqliteFilePermissions(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }

  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(file)) {
      chmodSync(file, 0o600);
    }
  }
}

function ensureSqliteFile(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const fd = openSync(dbPath, "a", 0o600);
  closeSync(fd);
  chmodSync(dbPath, 0o600);
}
