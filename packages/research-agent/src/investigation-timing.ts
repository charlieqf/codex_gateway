/** Whole-request timing supplied by the Worker; it does not change the hard deadline. */
export interface InvestigationTiming {
  request_date?: string;
  elapsed_ms: number;
  excellent_threshold_ms: 300000;
  acceptable_threshold_ms: 480000;
  remaining_hard_deadline_ms: number;
}

export function investigationTiming(createdAt: Date, now: Date, hardDeadlineMs: number): InvestigationTiming {
  const elapsed = Math.max(0, now.getTime() - createdAt.getTime());
  return {
    request_date: createdAt.toISOString().slice(0, 10),
    elapsed_ms: elapsed,
    excellent_threshold_ms: 300000,
    acceptable_threshold_ms: 480000,
    remaining_hard_deadline_ms: Math.max(0, hardDeadlineMs - elapsed)
  };
}

export const investigationTimingGuidance = "When service_timing is provided, it measures the whole request, including earlier stages and queue time. A complete result within 5 minutes is excellent; within 8 minutes is acceptable. These are performance targets, not permission to invent facts or skip the applicable factual checks. Prefer useful evidence and batch independent reads; reserve time to prepare and check the requested deliverables. Passing 8 minutes calls for latency diagnosis, not a claim that the person is absent. The separate hard deadline remains enforced by the Worker.";
