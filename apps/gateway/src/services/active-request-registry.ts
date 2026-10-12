import { renameSync, writeFileSync } from "node:fs";

export interface ActiveRequestInput {
  requestId: string;
  publicModelId: string;
  upstreamRuntime: string;
  upstreamAccountId: string | null;
  startedAt: Date;
  deadlineAt: Date | null;
}

export interface ActiveRequestUpdate {
  upstreamRuntime?: string;
  upstreamAccountId?: string | null;
}

interface ActiveRequestRecord extends ActiveRequestInput {
  firstByteAt: Date | null;
  emittedAlerts: Set<string>;
}

export interface ActiveRequestAlert {
  id: string;
  kind: "waiting_for_delivery" | "deadline_cleanup_overdue";
  requestId: string;
  publicModelId: string;
  upstreamRuntime: string;
  ageSeconds: number;
}

export interface ActiveRequestSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  inflightRequests: number;
  inflightByModel: Record<string, number>;
  inflightByRuntime: Record<string, number>;
  oldestInflightAgeSeconds: number | null;
  oldestWaitingFirstByteAgeSeconds: number | null;
  deadlineExceededRequests: number;
  oldestDeadlineExceededAgeSeconds: number | null;
  alerts: ActiveRequestAlert[];
  requests: Array<{
    requestId: string;
    publicModelId: string;
    upstreamRuntime: string;
    upstreamAccountId: string | null;
    startedAt: string;
    firstByteAt: string | null;
    deadlineAt: string | null;
    ageSeconds: number;
    waitingFirstByteSeconds: number | null;
    deadlineExceededSeconds: number | null;
  }>;
}

export interface ActiveRequestHandle {
  markFirstByte(at?: Date): void;
  update(update: ActiveRequestUpdate): void;
  finish(): void;
}

export interface ActiveRequestRegistryOptions {
  now?: () => Date;
  snapshotPath?: string | null;
  onSnapshotWriteError?: (error: unknown) => void;
  onAlert?: (alert: ActiveRequestAlert) => void;
  warningAfterMs?: number;
  deadlineGraceMs?: number;
}

export class ActiveRequestRegistry {
  private readonly active = new Map<string, ActiveRequestRecord>();
  private readonly now: () => Date;
  private readonly snapshotPath: string | null;
  private readonly onSnapshotWriteError?: (error: unknown) => void;
  private readonly onAlert?: (alert: ActiveRequestAlert) => void;
  private readonly warningAfterMs: number;
  private readonly deadlineGraceMs: number;

  constructor(options: ActiveRequestRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.snapshotPath = options.snapshotPath?.trim() || null;
    this.onSnapshotWriteError = options.onSnapshotWriteError;
    this.onAlert = options.onAlert;
    this.warningAfterMs = options.warningAfterMs ?? 300_000;
    this.deadlineGraceMs = options.deadlineGraceMs ?? 30_000;
    this.writeSnapshot();
  }

  begin(input: ActiveRequestInput): ActiveRequestHandle {
    this.active.set(input.requestId, { ...input, firstByteAt: null, emittedAlerts: new Set() });
    this.writeSnapshot();
    let finished = false;

    return {
      markFirstByte: (at = this.now()) => {
        const record = this.active.get(input.requestId);
        if (!record || record.firstByteAt) {
          return;
        }
        record.firstByteAt = at;
        this.writeSnapshot();
      },
      update: (update) => {
        const record = this.active.get(input.requestId);
        if (!record) {
          return;
        }
        if (update.upstreamRuntime !== undefined) {
          record.upstreamRuntime = update.upstreamRuntime;
        }
        if (update.upstreamAccountId !== undefined) {
          record.upstreamAccountId = update.upstreamAccountId;
        }
        this.writeSnapshot();
      },
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        this.active.delete(input.requestId);
        this.writeSnapshot();
      }
    };
  }

  /** Called by a bounded timer, never per SSE chunk. Warnings do not cancel work. */
  poll(): void {
    for (const alert of this.snapshot().alerts) {
      const record = this.active.get(alert.requestId);
      if (!record || record.emittedAlerts.has(alert.kind)) continue;
      record.emittedAlerts.add(alert.kind);
      try { this.onAlert?.(alert); } catch { /* Observation must not affect inference. */ }
    }
    this.writeSnapshot();
  }

  snapshot(at = this.now()): ActiveRequestSnapshot {
    const nowMs = at.getTime();
    const requests = [...this.active.values()]
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
      .map((record) => {
        const ageSeconds = elapsedSeconds(nowMs, record.startedAt);
        const waitingFirstByteSeconds = record.firstByteAt
          ? null
          : elapsedSeconds(nowMs, record.startedAt);
        const deadlineExceededSeconds =
          record.deadlineAt && nowMs > record.deadlineAt.getTime()
            ? elapsedSeconds(nowMs, record.deadlineAt)
            : null;
        return {
          requestId: record.requestId,
          publicModelId: record.publicModelId,
          upstreamRuntime: record.upstreamRuntime,
          upstreamAccountId: record.upstreamAccountId,
          startedAt: record.startedAt.toISOString(),
          firstByteAt: record.firstByteAt?.toISOString() ?? null,
          deadlineAt: record.deadlineAt?.toISOString() ?? null,
          ageSeconds,
          waitingFirstByteSeconds,
          deadlineExceededSeconds
        };
      });

    return {
      schemaVersion: 1,
      generatedAt: at.toISOString(),
      inflightRequests: requests.length,
      inflightByModel: countBy(requests, (request) => request.publicModelId),
      inflightByRuntime: countBy(requests, (request) => request.upstreamRuntime),
      oldestInflightAgeSeconds: maximum(requests.map((request) => request.ageSeconds)),
      oldestWaitingFirstByteAgeSeconds: maximum(
        requests.map((request) => request.waitingFirstByteSeconds)
      ),
      deadlineExceededRequests: requests.filter(
        (request) => request.deadlineExceededSeconds !== null
      ).length,
      oldestDeadlineExceededAgeSeconds: maximum(
        requests.map((request) => request.deadlineExceededSeconds)
      ),
      alerts: requests.flatMap(request => {
        const kinds: ActiveRequestAlert["kind"][] = [];
        if (request.waitingFirstByteSeconds !== null && request.waitingFirstByteSeconds * 1000 >= this.warningAfterMs)
          kinds.push("waiting_for_delivery");
        if (request.deadlineExceededSeconds !== null && request.deadlineExceededSeconds * 1000 >= this.deadlineGraceMs)
          kinds.push("deadline_cleanup_overdue");
        return kinds.map(kind => ({ id: `${kind}:${request.requestId}`, kind,
          requestId: request.requestId, publicModelId: request.publicModelId,
          upstreamRuntime: request.upstreamRuntime, ageSeconds: request.ageSeconds }));
      }),
      requests
    };
  }

  private writeSnapshot(): void {
    if (!this.snapshotPath) {
      return;
    }
    const temporaryPath = `${this.snapshotPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      renameSync(temporaryPath, this.snapshotPath);
    } catch (error) {
      this.onSnapshotWriteError?.(error);
    }
  }
}

function elapsedSeconds(nowMs: number, startedAt: Date): number {
  return Math.max(0, Math.floor((nowMs - startedAt.getTime()) / 1_000));
}

function maximum(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const itemKey = key(value);
    counts[itemKey] = (counts[itemKey] ?? 0) + 1;
  }
  return counts;
}
