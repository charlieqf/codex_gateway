import { describe, expect, it } from "vitest";
import { ProviderQuotaCircuit, quotaCooldownMs } from "./provider-quota-circuit.js";

describe("provider quota recovery", () => {
  it("requires the failed input/output shape, admits one probe, and rejects stale successes", () => {
    let now = 0;
    const circuit = new ProviderQuotaCircuit(300000, () => now);
    const shape = { promptTokens: 36000, maximumOutputTokens: 128000 };
    const stale = circuit.begin(shape);
    circuit.finish(circuit.begin(shape), "quota");
    circuit.finish(stale, "success");
    expect(circuit.allows(shape)).toBe(false);
    now = 300000;
    expect(circuit.allows({ ...shape, maximumOutputTokens: 256 })).toBe(false);
    expect(circuit.allows({ ...shape, promptTokens: 23 })).toBe(false);
    expect(circuit.allows()).toBe(false);
    const probe = circuit.begin(shape);
    expect(circuit.allows(shape)).toBe(false);
    circuit.finish(probe, "other");
    expect(circuit.allows(shape)).toBe(false);
    now += 300000;
    circuit.finish(circuit.begin(shape), "success");
    expect(circuit.allows()).toBe(true);
  });

  it("does not let an older recovery success clear a newer quota failure", () => {
    let now = 0;
    const circuit = new ProviderQuotaCircuit(1000, () => now);
    const shape = { promptTokens: 10, maximumOutputTokens: 4096 };
    const old = circuit.begin(shape);
    circuit.finish(circuit.begin(shape), "quota");
    now = 1000;
    const probe = circuit.begin(shape);
    circuit.finish(old, "quota");
    now = 2000;
    expect(circuit.allows(shape)).toBe(false); // The previous recovery call is still in flight.
    circuit.finish(probe, "success");
    expect(circuit.snapshot().state).toBe("open");
    expect(circuit.blockedUntil).toBe(2000);
    expect(circuit.allows(shape)).toBe(true); // Eligible for a new probe, never a stale full recovery.
  });

  it("validates the opt-in cooldown setting", () => {
    expect(quotaCooldownMs(undefined)).toBeUndefined();
    expect(quotaCooldownMs("0")).toBeUndefined();
    expect(quotaCooldownMs("300")).toBe(300000);
    for (const value of ["-1", "NaN", "1.5", "86401"]) expect(() => quotaCooldownMs(value)).toThrow();
  });
});
