import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { billingPayloadHash, GatewayError, validateTokenCreditGrant,
  type GrantTokenCreditsInput, type TokenCreditEvent, type TokenCreditWallet } from "@codex-gateway/core";
import { runInTransaction } from "./sql.js";

export const tokenCreditSchema = `
  CREATE TABLE token_credit_accounts (
    subject_id TEXT PRIMARY KEY REFERENCES subjects(id),
    granted_tokens INTEGER NOT NULL DEFAULT 0 CHECK (granted_tokens BETWEEN 0 AND 9007199254740991),
    charged_tokens INTEGER NOT NULL DEFAULT 0 CHECK (charged_tokens BETWEEN 0 AND 9007199254740991)
  );
  CREATE TABLE token_credit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    subject_id TEXT NOT NULL REFERENCES token_credit_accounts(subject_id),
    provider TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    external_order_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN ('gift', 'topup')),
    tokens INTEGER NOT NULL CHECK (tokens BETWEEN 1 AND 9007199254740991),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(provider, external_event_id)
  );
  CREATE UNIQUE INDEX token_credit_topup_order ON token_credit_events(provider, external_order_id) WHERE event_type = 'topup';
  CREATE INDEX token_credit_events_subject ON token_credit_events(subject_id, sequence);
  -- Permanent accounting evidence, independent of request-log retention.
  CREATE TABLE token_credit_debits (
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    subject_id TEXT NOT NULL REFERENCES token_credit_accounts(subject_id),
    tokens INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('initial', 'correction')),
    created_at TEXT NOT NULL,
    UNIQUE(reservation_id, phase)
  );
  CREATE INDEX token_credit_debits_subject ON token_credit_debits(subject_id, created_at);
  ALTER TABLE token_reservations ADD COLUMN credit_enabled INTEGER NOT NULL DEFAULT 0 CHECK (credit_enabled IN (0, 1));
  ALTER TABLE token_reservations ADD COLUMN credit_reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (credit_reserved_tokens >= 0);
  ALTER TABLE token_reservations ADD COLUMN final_credit_tokens INTEGER CHECK (final_credit_tokens >= 0);
  CREATE INDEX token_credit_pending ON token_reservations(subject_id, expires_at)
    WHERE credit_enabled = 1 AND finalized_at IS NULL;
`;

interface EventRow {
  sequence: number;
  id: string; idempotency_key: string; payload_hash: string; subject_id: string; provider: string;
  external_event_id: string; external_order_id: string | null; event_type: "gift" | "topup";
  tokens: number; reason: string; created_at: string;
}
function event(row: EventRow): TokenCreditEvent {
  return { id: row.id, idempotencyKey: row.idempotency_key, subjectId: row.subject_id,
    provider: row.provider, externalEventId: row.external_event_id, externalOrderId: row.external_order_id,
    eventType: row.event_type, tokens: row.tokens, reason: row.reason, createdAt: row.created_at };
}
function requireSubject(db: DatabaseSync, id: string): { state: string } {
  const row = db.prepare("SELECT state FROM subjects WHERE id = ?").get(id) as { state: string } | undefined;
  if (!row) throw new GatewayError({ code: "subject_not_found", httpStatus: 404, message: "Subject does not exist." });
  return row;
}

/** Missing account means credits have never been enabled for this subject. */
export function findWallet(db: DatabaseSync, subjectId: string, now: Date): TokenCreditWallet | null {
  const row = db.prepare(`SELECT granted_tokens, charged_tokens,
    (SELECT COALESCE(SUM(credit_reserved_tokens), 0) FROM token_reservations
      WHERE subject_id = ? AND credit_enabled = 1 AND kind = 'reservation' AND finalized_at IS NULL AND expires_at > ?) AS reserved
    FROM token_credit_accounts WHERE subject_id = ?`).get(subjectId, now.toISOString(), subjectId) as
    { granted_tokens: number; charged_tokens: number; reserved: number } | undefined;
  if (!row) return null;
  const balance = row.granted_tokens - row.charged_tokens;
  return { subjectId, grantedTokens: row.granted_tokens, chargedTokens: row.charged_tokens,
    balanceTokens: balance, reservedTokens: row.reserved, availableTokens: Math.max(0, balance - row.reserved) };
}

export function getWallet(db: DatabaseSync, subjectId: string, now = new Date()): TokenCreditWallet {
  requireSubject(db, subjectId);
  return findWallet(db, subjectId, now) ?? { subjectId, grantedTokens: 0, chargedTokens: 0,
    balanceTokens: 0, reservedTokens: 0, availableTokens: 0 };
}
export function getEvent(db: DatabaseSync, key: string): TokenCreditEvent | null {
  const row = db.prepare("SELECT * FROM token_credit_events WHERE idempotency_key = ?").get(key) as EventRow | undefined;
  return row ? event(row) : null;
}
export function listEvents(db: DatabaseSync, input: { subjectId: string; limit?: number; cursor?: string }) {
  requireSubject(db, input.subjectId);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 ||
    (input.cursor !== undefined && (!/^[1-9][0-9]*$/.test(input.cursor) || !Number.isSafeInteger(Number(input.cursor))))) {
    throw new GatewayError({ code: "invalid_request", httpStatus: 400, message: "Invalid limit or cursor." });
  }
  const rows = db.prepare("SELECT * FROM token_credit_events WHERE subject_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
    .all(input.subjectId, Number(input.cursor ?? 0), limit + 1) as unknown as EventRow[];
  return { events: rows.slice(0, limit).map(event), nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null };
}

export function grant(db: DatabaseSync, input: GrantTokenCreditsInput) {
  validateTokenCreditGrant(input);
  const now = input.now ?? new Date();
  const payloadHash = billingPayloadHash({ subjectId: input.subjectId, provider: input.provider,
    externalEventId: input.externalEventId, externalOrderId: input.externalOrderId ?? null,
    eventType: input.eventType, tokens: input.tokens, reason: input.reason });
  return runInTransaction(db, "BEGIN IMMEDIATE", () => {
    const previous = db.prepare("SELECT * FROM token_credit_events WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as EventRow | undefined;
    const conflict = (): never => { throw new GatewayError({ code: "idempotency_conflict", httpStatus: 409,
      message: "Credit event conflicts with an existing idempotency key, business event or topup order. Retry the original request with its original key." }); };
    if (previous) {
      if (previous.payload_hash !== payloadHash) conflict();
      return { event: event(previous), wallet: getWallet(db, input.subjectId, now), idempotentReplay: true };
    }
    if (db.prepare(`SELECT 1 FROM token_credit_events WHERE provider = ? AND
      (external_event_id = ? OR (event_type = 'topup' AND ? = 'topup' AND external_order_id = ?))`)
      .get(input.provider, input.externalEventId, input.eventType, input.externalOrderId ?? null)) conflict();
    if (requireSubject(db, input.subjectId).state !== "active") throw new GatewayError({ code: "account_disabled", httpStatus: 409,
      message: "Cannot grant Token credits to an inactive subject." });
    const before = db.prepare("SELECT granted_tokens FROM token_credit_accounts WHERE subject_id = ?")
      .get(input.subjectId) as { granted_tokens: number } | undefined;
    if (!Number.isSafeInteger((before?.granted_tokens ?? 0) + input.tokens)) throw new GatewayError({ code: "invalid_request", httpStatus: 400,
      message: "Cumulative granted tokens would exceed the safe integer range." });
    db.prepare(`INSERT INTO token_credit_accounts(subject_id, granted_tokens) VALUES (?, ?)
      ON CONFLICT(subject_id) DO UPDATE SET granted_tokens = granted_tokens + excluded.granted_tokens`).run(input.subjectId, input.tokens);
    const id = `tc_${randomUUID().replaceAll("-", "")}`;
    db.prepare(`INSERT INTO token_credit_events(id, idempotency_key, payload_hash, subject_id, provider,
      external_event_id, external_order_id, event_type, tokens, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.idempotencyKey, payloadHash, input.subjectId, input.provider, input.externalEventId,
        input.externalOrderId ?? null, input.eventType, input.tokens, input.reason, now.toISOString());
    return { event: getEvent(db, input.idempotencyKey)!, wallet: findWallet(db, input.subjectId, now)!, idempotentReplay: false };
  });
}

interface CreditSettlement {
  reservationId: string;
  requestId: string;
  subjectId: string;
  /** Complete corrected charge, not an increment. */
  tokens: number;
  phase: "initial" | "correction";
  now: Date;
}

/** The request finalizer owns commit/rollback for all ledgers together. */
export function settleChargeInTransaction(db: DatabaseSync, input: CreditSettlement): void {
  if (!db.isTransaction) throw new Error("Token credit settlement requires an accounting transaction.");
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) throw new Error("Invalid Token credit charge.");

  let previousTokens = 0;
  if (input.phase === "correction") {
    // The credit ledger owns its prior charge. Do not reconstruct it from a
    // request summary or require the caller to pass duplicate accounting state.
    const original = db.prepare(`SELECT tokens, subject_id, request_id FROM token_credit_debits
      WHERE reservation_id = ? AND phase = 'initial'`).get(input.reservationId) as
      { tokens: number; subject_id: string; request_id: string } | undefined;
    if (!original || original.subject_id !== input.subjectId || original.request_id !== input.requestId) {
      throw new Error("Original Token credit settlement is missing or belongs to another request.");
    }
    previousTokens = original.tokens;
  }
  const delta = input.tokens - previousTokens;
  const updated = db.prepare(`UPDATE token_credit_accounts SET charged_tokens = charged_tokens + ?
    WHERE subject_id = ? AND charged_tokens + ? BETWEEN 0 AND 9007199254740991`)
    .run(delta, input.subjectId, delta);
  if (Number(updated.changes) !== 1) {
    throw new Error("Token credit account is missing or its charge would exceed the safe integer range.");
  }
  db.prepare(`INSERT INTO token_credit_debits(id, reservation_id, request_id, subject_id, tokens, phase, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `tcd_${randomUUID().replaceAll("-", "")}`, input.reservationId, input.requestId,
      input.subjectId, delta, input.phase, input.now.toISOString()
    );
}
