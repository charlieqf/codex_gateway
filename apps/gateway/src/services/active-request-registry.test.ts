import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveRequestRegistry } from "./active-request-registry.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ActiveRequestRegistry", () => {
  it("tracks ages, first byte, deadlines and routing updates", () => {
    let now = new Date("2026-07-14T00:00:00.000Z");
    const registry = new ActiveRequestRegistry({ now: () => now });
    const request = registry.begin({
      requestId: "req-1",
      publicModelId: "max",
      upstreamRuntime: "codex",
      upstreamAccountId: "acct-1",
      startedAt: now,
      deadlineAt: new Date(now.getTime() + 10_000)
    });

    now = new Date(now.getTime() + 12_000);
    expect(registry.snapshot()).toMatchObject({
      inflightRequests: 1,
      inflightByModel: { max: 1 },
      oldestInflightAgeSeconds: 12,
      oldestWaitingFirstByteAgeSeconds: 12,
      deadlineExceededRequests: 1,
      oldestDeadlineExceededAgeSeconds: 2
    });

    request.markFirstByte();
    request.update({ upstreamRuntime: "openrouter", upstreamAccountId: "acct-2" });
    expect(registry.snapshot()).toMatchObject({
      inflightByRuntime: { openrouter: 1 },
      oldestWaitingFirstByteAgeSeconds: null,
      requests: [{ upstreamAccountId: "acct-2" }]
    });

    request.finish();
    request.finish();
    expect(registry.snapshot().inflightRequests).toBe(0);
  });

  it("atomically publishes a sanitized runtime snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-active-requests-"));
    temporaryDirectories.push(directory);
    const snapshotPath = join(directory, "ops-runtime.json");
    const now = new Date("2026-07-14T00:00:00.000Z");
    const registry = new ActiveRequestRegistry({ snapshotPath, now: () => now });

    const request = registry.begin({
      requestId: "req-public",
      publicModelId: "goldencode",
      upstreamRuntime: "pool",
      upstreamAccountId: null,
      startedAt: now,
      deadlineAt: null
    });
    const published = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    expect(published).toMatchObject({ schemaVersion: 1, inflightRequests: 1 });
    expect(readFileSync(snapshotPath, "utf8")).not.toContain("prompt");

    request.finish();
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toMatchObject({ inflightRequests: 0 });
  });
});
