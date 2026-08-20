import { GatewayError, type LimitKind, type LimitRejection, type RateLimitPolicy } from "@codex-gateway/core";

export interface RateLimitInput {
  credentialId: string;
  policy: RateLimitPolicy;
}

export interface RateLimitPermit {
  release(): void;
}

export type RateLimitResetWindow = "minute" | "day";

export interface RateLimitResetInput {
  credentialId: string;
  windows: RateLimitResetWindow[];
}

export interface RateLimitResetSnapshot {
  minuteCount: number;
  dayCount: number;
  active: number;
  minuteWindow: number;
  dayWindow: string;
}

export interface RateLimitResetResult {
  credentialId: string;
  windows: RateLimitResetWindow[];
  found: boolean;
  before: RateLimitResetSnapshot | null;
  after: RateLimitResetSnapshot | null;
}

export interface CredentialRateLimiter {
  acquire(input: RateLimitInput): RateLimitPermit | LimitRejection;
  reset?(input: RateLimitResetInput): RateLimitResetResult;
}

interface RateLimiterOptions {
  now?: () => Date;
}

interface CredentialRateState {
  minuteWindow: number;
  minuteCount: number;
  dayWindow: string;
  dayCount: number;
  active: number;
  retainThroughDay: boolean;
}

export class InMemoryCredentialRateLimiter implements CredentialRateLimiter {
  private readonly states = new Map<string, CredentialRateState>();
  private readonly now: () => Date;
  private lastPrunedMinuteWindow: number | null = null;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  acquire(input: RateLimitInput): RateLimitPermit | LimitRejection {
    const now = this.now();
    this.pruneIdleStates(now);
    const state = this.state(input.credentialId, now);
    state.retainThroughDay ||= input.policy.requestsPerDay !== null;
    const concurrencyLimit = input.policy.concurrentRequests;
    if (concurrencyLimit !== null && state.active >= concurrencyLimit) {
      return rateLimited(
        "concurrency",
        `Concurrent request limit reached: ${state.active} of ${concurrencyLimit} requests are active.`,
        1,
        {
          scope: "credential",
          window: "concurrency",
          limit: concurrencyLimit,
          used: state.active,
          requested: 1
        }
      );
    }

    const minuteWindow = Math.floor(now.getTime() / 60_000);
    if (state.minuteWindow !== minuteWindow) {
      state.minuteWindow = minuteWindow;
      state.minuteCount = 0;
    }
    if (state.minuteCount >= input.policy.requestsPerMinute) {
      const nextMinuteAt = (minuteWindow + 1) * 60_000;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((nextMinuteAt - now.getTime()) / 1000)
      );
      return rateLimited(
        "request_minute",
        `Request frequency limit reached: ${state.minuteCount} of ${input.policy.requestsPerMinute} requests used in the current minute. Retry in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
        {
          scope: "credential",
          window: "minute",
          limit: input.policy.requestsPerMinute,
          used: state.minuteCount,
          requested: 1
        }
      );
    }

    const dayWindow = utcDayWindow(now);
    if (state.dayWindow !== dayWindow) {
      state.dayWindow = dayWindow;
      state.dayCount = 0;
    }
    if (
      input.policy.requestsPerDay !== null &&
      state.dayCount >= input.policy.requestsPerDay
    ) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((nextUtcDay(now).getTime() - now.getTime()) / 1000)
      );
      return rateLimited(
        "request_day",
        `Daily request quota reached: ${state.dayCount} of ${input.policy.requestsPerDay} requests used in the current UTC day. Retry in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
        {
          scope: "credential",
          window: "day",
          limit: input.policy.requestsPerDay,
          used: state.dayCount,
          requested: 1
        }
      );
    }

    state.active += 1;
    state.minuteCount += 1;
    state.dayCount += 1;
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        state.active = Math.max(0, state.active - 1);
        const releasedAt = this.now();
        this.pruneIdleState(input.credentialId, state, releasedAt);
      }
    };
  }

  reset(input: RateLimitResetInput): RateLimitResetResult {
    const now = this.now();
    const state = this.states.get(input.credentialId);
    const windows = normalizeResetWindows(input.windows);
    if (!state) {
      return {
        credentialId: input.credentialId,
        windows,
        found: false,
        before: null,
        after: null
      };
    }

    const before = resetSnapshot(state);
    if (windows.includes("minute")) {
      state.minuteWindow = Math.floor(now.getTime() / 60_000);
      state.minuteCount = 0;
    }
    if (windows.includes("day")) {
      state.dayWindow = utcDayWindow(now);
      state.dayCount = 0;
    }
    return {
      credentialId: input.credentialId,
      windows,
      found: true,
      before,
      after: resetSnapshot(state)
    };
  }

  private state(credentialId: string, now: Date): CredentialRateState {
    const existing = this.states.get(credentialId);
    if (existing) {
      return existing;
    }

    const state = {
      minuteWindow: Math.floor(now.getTime() / 60_000),
      minuteCount: 0,
      dayWindow: utcDayWindow(now),
      dayCount: 0,
      active: 0,
      retainThroughDay: false
    };
    this.states.set(credentialId, state);
    return state;
  }

  private pruneIdleState(credentialId: string, state: CredentialRateState, now: Date): void {
    if (state.active === 0 && stateWindowExpired(state, now)) {
      this.states.delete(credentialId);
    }
  }

  private pruneIdleStates(now: Date): void {
    const minuteWindow = Math.floor(now.getTime() / 60_000);
    if (this.lastPrunedMinuteWindow === minuteWindow) {
      return;
    }
    this.lastPrunedMinuteWindow = minuteWindow;
    for (const [credentialId, state] of this.states) {
      this.pruneIdleState(credentialId, state, now);
    }
  }
}

function stateWindowExpired(state: CredentialRateState, now: Date): boolean {
  return state.retainThroughDay
    ? state.dayWindow !== utcDayWindow(now)
    : state.minuteWindow !== Math.floor(now.getTime() / 60_000);
}

function normalizeResetWindows(windows: RateLimitResetWindow[]): RateLimitResetWindow[] {
  return Array.from(new Set(windows));
}

function resetSnapshot(state: CredentialRateState): RateLimitResetSnapshot {
  return {
    minuteWindow: state.minuteWindow,
    minuteCount: state.minuteCount,
    dayWindow: state.dayWindow,
    dayCount: state.dayCount,
    active: state.active
  };
}

function rateLimited(
  limitKind: LimitKind,
  message: string,
  retryAfterSeconds: number,
  details: NonNullable<LimitRejection["details"]>
): LimitRejection {
  return {
    ok: false,
    limitKind,
    details,
    error: new GatewayError({
      code: "rate_limited",
      message,
      httpStatus: 429,
      retryAfterSeconds
    })
  };
}

function utcDayWindow(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}
