import type { MessageInput, ModelProgressEvent, StreamEvent } from "@codex-gateway/core";

export interface ModelCallProgress {
  phase: "waiting_upstream" | Exclude<ModelProgressEvent, "attempt_started">;
  started_at: string;
  deadline_at: string | null;
  last_model_activity_at: string | null;
  elapsed_ms: number;
  attempt_index: number;
}

// Optional observation must never fail model execution. No timers or I/O.
export function reportModelProgress(observer: MessageInput["onModelProgress"], event: ModelProgressEvent): void {
  try { observer?.(event); } catch { /* Best-effort metadata only. */ }
}

export function reportModelOutput(observer: MessageInput["onModelProgress"], event: StreamEvent): void {
  // Assembled tool_call events may be emitted only at DONE; they are not new
  // upstream activity. The compatible adapter observes raw tool deltas instead.
  if (event.type === "message_delta" && event.text.length > 0) {
    reportModelProgress(observer, "generating");
  }
}

/** Owned by the existing active receipt; discarded at its terminal transition. */
export class ModelCallProgressTracker {
  private readonly startedMono: number;
  private readonly value: Omit<ModelCallProgress, "elapsed_ms" | "last_model_activity_at">;
  private lastModelActivityAt: number | null = null;

  constructor(startedAt: Date, deadlineAt: Date | null,
    private readonly wallNow = Date.now, private readonly monoNow = () => performance.now()) {
    this.startedMono = monoNow();
    this.value = { phase: "waiting_upstream", started_at: startedAt.toISOString(),
      deadline_at: deadlineAt?.toISOString() ?? null, attempt_index: 0 };
  }

  observe(event: ModelProgressEvent): void {
    if (event === "attempt_started") {
      this.value.attempt_index++;
      this.value.phase = "waiting_upstream";
    } else {
      this.value.phase = event;
      if (event === "reasoning" || event === "generating") {
        this.lastModelActivityAt = this.wallNow();
      }
    }
  }

  snapshot(): ModelCallProgress {
    return { ...this.value,
      last_model_activity_at: this.lastModelActivityAt === null ? null : new Date(this.lastModelActivityAt).toISOString(),
      elapsed_ms: Math.max(0, Math.floor(this.monoNow() - this.startedMono)) };
  }
}
