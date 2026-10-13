import { describe, expect, it } from "vitest";
import { ModelCallProgressTracker } from "./model-call-progress.js";

describe("model call progress observations", () => {
  it("keeps one budget across retries and elapsed time independent of wall clock changes", () => {
    const start = new Date("2026-10-13T02:00:00.000Z");
    let wall = start.getTime(), mono = 100;
    const tracker = new ModelCallProgressTracker(start, new Date(wall + 900_000), () => wall, () => mono);
    expect(tracker.snapshot()).toMatchObject({ attempt_index: 0, last_model_activity_at: null });
    tracker.observe("attempt_started");
    mono += 650_000; wall += 650_000;
    tracker.observe("reasoning");
    const activity = tracker.snapshot().last_model_activity_at;
    tracker.observe("validating");
    tracker.observe("retrying");
    tracker.observe("attempt_started");
    wall -= 60_000; mono += 1000;
    expect(tracker.snapshot()).toEqual({ phase: "waiting_upstream", started_at: start.toISOString(),
      deadline_at: "2026-10-13T02:15:00.000Z", last_model_activity_at: activity,
      elapsed_ms: 651_000, attempt_index: 2 });
  });
});
