import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateWatchdog } from "../scripts/ops/gateway-request-watchdog.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/watchdog/${name}.json`, import.meta.url), "utf8"));
}

describe("gateway request watchdog", () => {
  it("returns ok for a healthy sanitized fixture", () => {
    const result = evaluateWatchdog(fixture("healthy"));
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
    expect(result.events.new).toEqual([]);
  });

  it("classifies emergency and critical conditions without creating real pressure", () => {
    const result = evaluateWatchdog(fixture("emergency"));
    expect(result.status).toBe("emergency");
    expect(result.findings.map((item) => item.key)).toEqual(
      expect.arrayContaining([
        "host.memory_available",
        "host.root_disk",
        "container.oom",
        "container.temporary_state_total",
        "gateway.deadline_residue",
        "gateway.infrastructure_errors",
        "gateway.rate_limit_origin_unknown",
        "upstream.account-a.reauth"
      ])
    );
    expect(result.events.new).toHaveLength(result.findings.length);
  });

  it("deduplicates ongoing incidents and emits resolved events", () => {
    const first = evaluateWatchdog(fixture("emergency"));
    const repeatedInput = {
      ...fixture("emergency"),
      previousBase64: Buffer.from(JSON.stringify(first)).toString("base64")
    };
    repeatedInput.generatedAt = "2026-07-15T00:11:00.000Z";
    const repeated = evaluateWatchdog(repeatedInput);
    expect(repeated.events.new).toEqual([]);
    expect(repeated.events.ongoing.length).toBeGreaterThan(0);

    const recoveredInput = { ...fixture("healthy"), previous: repeated };
    recoveredInput.generatedAt = "2026-07-15T00:12:00.000Z";
    const recovered = evaluateWatchdog(recoveredInput);
    expect(recovered.status).toBe("ok");
    expect(recovered.events.resolved.length).toBe(repeated.findings.length);
  });

  it("requires five consecutive samples for the host memory warning", () => {
    let previous;
    let result;
    for (let index = 0; index < 5; index += 1) {
      const input = fixture("healthy");
      input.generatedAt = `2026-07-15T00:0${index}:00.000Z`;
      input.host.memAvailableBytes = 2 * 1024 ** 3;
      input.previous = previous;
      result = evaluateWatchdog(input);
      previous = result;
    }
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "host.memory_available", severity: "warning" })])
    );
  });

  it("escalates a second consecutive unhealthy container sample", () => {
    const firstInput = fixture("healthy");
    firstInput.container.health = "unhealthy";
    const first = evaluateWatchdog(firstInput);
    expect(first.findings).toContainEqual(
      expect.objectContaining({ key: "container.health", severity: "warning" })
    );

    const secondInput = fixture("healthy");
    secondInput.generatedAt = "2026-07-15T00:01:00.000Z";
    secondInput.container.health = "unhealthy";
    secondInput.previous = first;
    const second = evaluateWatchdog(secondInput);
    expect(second.findings).toContainEqual(
      expect.objectContaining({ key: "container.health", severity: "critical" })
    );
    expect(second.events.escalated).toContainEqual(
      expect.objectContaining({ key: "container.health", severity: "critical" })
    );
  });

  it("detects ten-minute disk, SQLite, and restart growth from saved samples", () => {
    const baseline = evaluateWatchdog(fixture("healthy"));
    const input = fixture("healthy");
    input.generatedAt = "2026-07-15T00:10:00.000Z";
    input.host.diskUsedBytes += 6 * 1024 ** 3;
    input.persistentState.primaryDbBytes += 600 * 1024 ** 2;
    input.container.restartCount = 2;
    input.previous = baseline;
    const result = evaluateWatchdog(input);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "host.disk_growth", severity: "critical" }),
        expect.objectContaining({ key: "gateway.sqlite_growth", severity: "critical" }),
        expect.objectContaining({ key: "container.restarts", severity: "critical" })
      ])
    );
  });
});
