import { GatewayError, type LimitKind, type LimitRejection, type RateLimitPolicy } from "@codex-gateway/core";

export interface RateLimitInput {
  credentialId: string;
  policy: RateLimitPolicy;
}

export interface RateLimitPermit {
  release(): void;
}

export interface CredentialRateLimiter {
  acquire(input: RateLimitInput): RateLimitPermit | LimitRejection;
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
  lastSeenMs: number;
}

export class InMemoryCredentialRateLimiter implements CredentialRateLimiter {
  private readonly states = new Map<string, CredentialRateState>();
  private readonly now: () => Date;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  acquire(input: RateLimitInput): RateLimitPermit | LimitRejection {
    const now = this.now();
    const state = this.state(input.credentialId, now);
    state.lastSeenMs = now.getTime();
    const concurrencyLimit = input.policy.concurrentRequests;
    if (concurrencyLimit !== null && state.active >= concurrencyLimit) {
      return rateLimited("concurrency", "Concurrent request limit reached.", 1);
    }

    const minuteWindow = Math.floor(now.getTime() / 60_000);
    if (state.minuteWindow !== minuteWindow) {
      state.minuteWindow = minuteWindow;
      state.minuteCount = 0;
    }
    if (state.minuteCount >= input.policy.requestsPerMinute) {
      const nextMinuteAt = (minuteWindow + 1) * 60_000;
      return rateLimited(
        "request_minute",
        "Requests per minute limit reached.",
        Math.max(1, Math.ceil((nextMinuteAt - now.getTime()) / 1000))
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
      return rateLimited(
        "request_day",
        "Requests per day limit reached.",
        Math.max(1, Math.ceil((nextUtcDay(now).getTime() - now.getTime()) / 1000))
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
        state.lastSeenMs = releasedAt.getTime();
        this.pruneIdleState(input.credentialId, state, releasedAt);
      }
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
      lastSeenMs: now.getTime()
    };
    this.states.set(credentialId, state);
    return state;
  }

  private pruneIdleState(credentialId: string, state: CredentialRateState, now: Date): void {
    if (state.active > 0) {
      return;
    }

    const currentMinuteWindow = Math.floor(now.getTime() / 60_000);
    const currentDayWindow = utcDayWindow(now);
    if (state.minuteWindow !== currentMinuteWindow && state.dayWindow !== currentDayWindow) {
      this.states.delete(credentialId);
    }
  }
}

function rateLimited(
  limitKind: LimitKind,
  message: string,
  retryAfterSeconds: number
): LimitRejection {
  return {
    ok: false,
    limitKind,
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
