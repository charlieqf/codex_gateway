import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateGatewaySessionInput,
  GatewaySession
} from "@codex-gateway/core";
import { sessionColumns } from "./columns.js";
import { rowToSession } from "./row-mappers.js";

export function create(
  db: DatabaseSync,
  input: CreateGatewaySessionInput
): GatewaySession {
  const now = input.now ?? new Date();
  const session: GatewaySession = {
    id: `sess_${randomUUID()}`,
    subjectId: input.subjectId,
    upstreamAccountId: input.upstreamAccountId,
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: now,
    updatedAt: now
  };

  db.prepare(
    `INSERT INTO sessions (
      id, subject_id, upstream_account_id, provider_session_ref, title, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.subjectId,
    session.upstreamAccountId,
    session.providerSessionRef,
    session.title,
    session.state,
    session.createdAt.toISOString(),
    session.updatedAt.toISOString()
  );

  return session;
}

export function list(db: DatabaseSync, subjectId: string): GatewaySession[] {
  const rows = db
    .prepare(
      `SELECT ${sessionColumns}
       FROM sessions
       WHERE subject_id = ?
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all(subjectId);

  return rows.map(rowToSession);
}

export function get(db: DatabaseSync, id: string): GatewaySession | null {
  const row = db
    .prepare(
      `SELECT ${sessionColumns}
       FROM sessions
       WHERE id = ?`
    )
    .get(id);

  return row ? rowToSession(row) : null;
}

export function setProviderSessionRef(
  db: DatabaseSync,
  id: string,
  providerSessionRef: string
): GatewaySession | null {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `UPDATE sessions
     SET provider_session_ref = ?, updated_at = ?
     WHERE id = ?`
  ).run(providerSessionRef, updatedAt, id);

  return get(db, id);
}
