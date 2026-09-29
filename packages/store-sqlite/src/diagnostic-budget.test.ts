import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ClientDiagnosticEventRecord } from "@codex-gateway/core";
import { createSqliteClientEventsStore } from "./client-events-store.js";

const now = new Date("2026-09-29T01:00:00Z");
const record = (overrides: Partial<ClientDiagnosticEventRecord> = {}): ClientDiagnosticEventRecord => ({
    id: randomUUID(), eventId: randomUUID(), requestId: randomUUID(), credentialId: "first-key", subjectId: "synthetic",
    scope: "code", sessionId: null, messageId: null, toolCallId: null, providerId: null, modelId: null,
    category: "http", action: "poll", status: "ok", method: null, path: null, monoMs: null, durationMs: null,
    httpStatus: null, errorCode: null, errorMessage: null, metadataJson: "{}", appName: "medevidence-desktop",
    appVersion: "synthetic", createdAt: now, receivedAt: now, ...overrides });

it("persists unique-event budgets across restart and credential rotation, with bounded terminal reserve", () => {
  const filename = path.join(tmpdir(), `gateway-diagnostic-budget-${randomUUID()}.db`);
  let store = createSqliteClientEventsStore({ path: filename });
  try {
    expect(store.insertBudgetedClientDiagnosticEvent(record(), 1)).toMatchObject({ accepted: true, remaining: 0 });
    store.close(); store = createSqliteClientEventsStore({ path: filename });
    expect(store.insertBudgetedClientDiagnosticEvent(record({ credentialId: "rotated-key" }), 1).accepted).toBe(false);
    // Arbitrary error-labelled polling cannot claim reserved terminal capacity.
    expect(store.insertBudgetedClientDiagnosticEvent(record({ status: "error" }), 1).accepted).toBe(false);
    const terminal = { category: "agent_turn", action: "turn", status: "error" as const };
    expect(store.insertBudgetedClientDiagnosticEvent(record(terminal), 1)).toMatchObject({ accepted: true, lane: "terminal" });
    expect(store.insertBudgetedClientDiagnosticEvent(record(terminal), 1).accepted).toBe(false);
    expect(store.insertBudgetedClientDiagnosticEvent(record({ receivedAt: new Date("2026-09-30T00:00:00Z") }), 1).accepted).toBe(true);
  } finally {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
  }
});

it.each(["error", "timeout", "aborted"] as const)("reserves and counts transport_attempt %s events", status => {
  const store = createSqliteClientEventsStore({ path: ":memory:" });
  try {
    expect(store.insertBudgetedClientDiagnosticEvent(record(), 1).accepted).toBe(true);
    // Normal or unrelated action shapes must not consume the terminal reserve.
    for (const event of [
      { category: "provider_stream", action: "transport_attempt", status: "ok" as const },
      { category: "provider_stream", action: "transport_attempt", status: "started" as const },
      { category: "tool", action: "transport_attempt", status }
    ]) expect(store.insertBudgetedClientDiagnosticEvent(record(event), 1)).toMatchObject({ accepted: false, lane: "normal" });
    const event = record({ category: "provider_stream", action: "transport_attempt", status });
    expect(store.insertBudgetedClientDiagnosticEvent(event, 1)).toMatchObject({ accepted: true, remaining: 0, lane: "terminal" });
    expect(store.getClientDiagnosticEvent(event.subjectId, event.eventId)?.status).toBe(status);
    // Counting persisted transport events must share the incoming-event classification.
    expect(store.insertBudgetedClientDiagnosticEvent(record({ category: "agent_turn", action: "turn", status: "error" }), 1))
      .toMatchObject({ accepted: false, lane: "terminal" });
  } finally { store.close(); }
});
