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
      active: 0
    };
    this.states.set(credentialId, state);
    return state;
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
