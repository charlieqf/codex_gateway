import { describe, expect, it } from "vitest";
import {
  isResearchRunTransitionAllowed,
  researchRunStatuses
} from "./research.js";

describe("Research run state machine", () => {
  it("allows only the frozen Phase 0 transitions", () => {
    const allowed = new Set([
      "queued->running",
      "queued->cancelled",
      "running->running",
      "running->queued",
      "running->needs_input",
      "running->succeeded",
      "running->failed",
      "running->cancelled",
      "needs_input->queued",
      "needs_input->failed",
      "needs_input->cancelled",
      "succeeded->expired",
      "failed->expired",
      "cancelled->expired"
    ]);

    for (const from of researchRunStatuses) {
      for (const to of researchRunStatuses) {
        expect(
          isResearchRunTransitionAllowed(from, to),
          `${from}->${to}`
        ).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });
});
