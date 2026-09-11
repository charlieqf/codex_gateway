import { describe, expect, it } from "vitest";
import { investigationTiming } from "./investigation-timing.js";

describe("whole-request investigation timing", () => {
  it("keeps the 5/8 minute targets separate from the hard deadline, including queue and previous-stage time", () => {
    const createdAt = new Date("2026-09-10T00:00:00Z");
    expect(investigationTiming(createdAt, new Date("2026-09-10T00:08:10Z"), 900_000)).toEqual({
      request_date: "2026-09-10",
      elapsed_ms: 490_000, excellent_threshold_ms: 300000, acceptable_threshold_ms: 480000,
      remaining_hard_deadline_ms: 410_000
    });
  });
});
