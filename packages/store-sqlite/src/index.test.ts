import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Subject, Subscription } from "@codex-gateway/core";
import { createSqliteStore, type SqliteGatewayStore } from "./index.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteGatewayStore", () => {
  it("migrates idempotently and persists sessions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-gateway-store-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "gateway.db");

    const first = createSeededStore(dbPath);
    const session = first.create({
      subjectId: "subj_1",
      subscriptionId: "sub_openai_codex"
    });
    expect(session.providerSessionRef).toBeNull();

    const updated = first.setProviderSessionRef(session.id, "thread_1");
    expect(updated?.providerSessionRef).toBe("thread_1");
    first.close();

    const second = createSeededStore(dbPath);
    expect(second.get(session.id)?.providerSessionRef).toBe("thread_1");
    expect(second.list("subj_1").map((item) => item.id)).toEqual([session.id]);
    second.close();
  });

  it("returns null when updating an unknown session", () => {
    const store = createSeededStore(":memory:");
    expect(store.setProviderSessionRef("missing", "thread_1")).toBeNull();
    store.close();
  });
});

function createSeededStore(dbPath: string): SqliteGatewayStore {
  const store = createSqliteStore({ path: dbPath });
  store.upsertSubject(subject());
  store.upsertSubscription(subscription());
  return store;
}

function subject(): Subject {
  return {
    id: "subj_1",
    label: "Test Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function subscription(): Subscription {
  return {
    id: "sub_openai_codex",
    provider: "openai-codex",
    label: "Codex",
    credentialRef: "CODEX_HOME",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

