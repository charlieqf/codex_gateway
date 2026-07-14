import { GatewayError } from "@codex-gateway/core";

export interface ChatRequestTimeoutPolicy {
  defaultMs: number;
  runtimes: Record<string, number>;
  models: Record<string, number>;
}

export interface ChatRequestDeadline {
  signal: AbortSignal;
  deadlineAt: Date | null;
  cleanup(): void;
}

export function parseChatRequestTimeoutPolicy(
  env: NodeJS.ProcessEnv,
  onWarning?: (message: string) => void
): ChatRequestTimeoutPolicy {
  const fallback = parseTimeoutMs(env.MEDCODE_CHAT_REQUEST_TIMEOUT_MS, 0);
  const raw = env.MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON?.trim();
  if (!raw) {
    return { defaultMs: fallback, runtimes: {}, models: {} };
  }

  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) {
      throw new Error("must be a JSON object");
    }
    return {
      defaultMs: parseTimeoutValue(value.defaultMs, fallback, "defaultMs"),
      runtimes: parseTimeoutMap(value.runtimes, "runtimes"),
      models: parseTimeoutMap(value.models, "models")
    };
  } catch (error) {
    onWarning?.(
      `Ignoring MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON: ${
        error instanceof Error ? error.message : String(error)
      }.`
    );
    return { defaultMs: fallback, runtimes: {}, models: {} };
  }
}

export function resolveChatRequestTimeoutMs(
  policy: ChatRequestTimeoutPolicy,
  publicModelId: string,
  upstreamRuntime: string
): number {
  return policy.models[publicModelId] ?? policy.runtimes[upstreamRuntime] ?? policy.defaultMs;
}

export function createChatRequestDeadline(options: {
  timeoutMs: number;
  parentSignals?: Array<AbortSignal | undefined>;
  now?: Date;
}): ChatRequestDeadline {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let timer: NodeJS.Timeout | null = null;

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of options.parentSignals ?? []) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }

  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
  const deadlineAt = timeoutMs > 0 ? new Date((options.now ?? new Date()).getTime() + timeoutMs) : null;
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(
        new GatewayError({
          code: "upstream_timeout",
          message: "MedCode service timed out.",
          httpStatus: 504
        })
      );
    }, timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    deadlineAt,
    cleanup: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseTimeoutValue(value: unknown, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function parseTimeoutMap(value: unknown, field: string): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const result: Record<string, number> = {};
  for (const [key, timeout] of Object.entries(value)) {
    if (!key.trim()) {
      throw new Error(`${field} contains an empty key`);
    }
    result[key] = parseTimeoutValue(timeout, 0, `${field}.${key}`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
