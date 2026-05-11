import { GatewayError } from "@codex-gateway/core";

export interface UpstreamV2CreateUserInput {
  externalProvider: string;
  externalUserId: string;
  displayName: string;
  metadata?: Record<string, unknown> | null;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface UpstreamV2CreateUserResult {
  status: "created" | "idempotent_replay";
  user: {
    id: string;
    state?: string;
  };
  key: {
    id: string;
    key: string;
    keyPrefix?: string | null;
    issuedAt?: Date | null;
    expiresAt?: Date | null;
  };
}

export interface UpstreamV2RevokeKeyInput {
  externalUserId: string;
  userId: string;
  keyId: string;
  idempotencyKey: string;
  reason?: string | null;
  signal?: AbortSignal;
}

export interface UpstreamV2RevokeKeyResult {
  revoked: boolean;
  key: {
    id: string;
    state?: string;
  };
}

export interface UpstreamV2DisableUserInput {
  externalUserId: string;
  userId: string;
  idempotencyKey: string;
  reason?: string | null;
  signal?: AbortSignal;
}

export interface UpstreamV2DisableUserResult {
  disabled: boolean;
  user: {
    id: string;
    state?: string;
  };
  revokedKeyCount?: number | null;
}

export interface UpstreamV2Client {
  createUser(input: UpstreamV2CreateUserInput): Promise<UpstreamV2CreateUserResult>;
  revokeKey(input: UpstreamV2RevokeKeyInput): Promise<UpstreamV2RevokeKeyResult>;
  disableUser(input: UpstreamV2DisableUserInput): Promise<UpstreamV2DisableUserResult>;
}

export interface HttpUpstreamV2ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class HttpUpstreamV2Client implements UpstreamV2Client {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpUpstreamV2ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async createUser(input: UpstreamV2CreateUserInput): Promise<UpstreamV2CreateUserResult> {
    return this.request({
      path: "/internal/users",
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
      body: {
        external_provider: input.externalProvider,
        external_user_id: input.externalUserId,
        display_name: input.displayName,
        metadata: input.metadata ?? undefined
      },
      parse: parseCreateUserResult
    });
  }

  async revokeKey(input: UpstreamV2RevokeKeyInput): Promise<UpstreamV2RevokeKeyResult> {
    return this.request({
      path: `/internal/users/${encodeURIComponent(input.userId)}/keys/${encodeURIComponent(input.keyId)}/revoke`,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
      body: {
        reason: input.reason ?? undefined
      },
      parse: parseRevokeKeyResult
    });
  }

  async disableUser(input: UpstreamV2DisableUserInput): Promise<UpstreamV2DisableUserResult> {
    return this.request({
      path: `/internal/users/${encodeURIComponent(input.userId)}/disable`,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
      body: {
        reason: input.reason ?? undefined
      },
      parse: parseDisableUserResult
    });
  }

  private async request<T>(input: {
    path: string;
    idempotencyKey: string;
    body: Record<string, unknown>;
    signal?: AbortSignal;
    parse: (payload: unknown) => T;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("upstream_timeout")), this.timeoutMs);
    const abortFromParent = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}${input.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey
        },
        body: JSON.stringify(input.body),
        signal: controller.signal
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        throw mapUpstreamError(response, payload);
      }
      return input.parse(payload);
    } catch (err) {
      if (err instanceof GatewayError) {
        throw err;
      }
      throw new GatewayError({
        code: "upstream_unavailable",
        message: "MedEvidence v2 provisioning is unavailable.",
        httpStatus: 502
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

export function resolveUpstreamV2Client(env: NodeJS.ProcessEnv): UpstreamV2Client | null {
  const baseUrl = env.GATEWAY_UPSTREAM_V2_BASE_URL?.trim();
  const token = env.GATEWAY_UPSTREAM_V2_TOKEN?.trim();
  if (!baseUrl && !token) {
    return null;
  }
  if (!baseUrl || !token) {
    throw new Error("GATEWAY_UPSTREAM_V2_BASE_URL and GATEWAY_UPSTREAM_V2_TOKEN must be set together.");
  }
  return new HttpUpstreamV2Client({
    baseUrl,
    token,
    timeoutMs: parseTimeout(env.GATEWAY_UPSTREAM_V2_TIMEOUT_MS)
  });
}

function parseCreateUserResult(payload: unknown): UpstreamV2CreateUserResult {
  if (!isRecord(payload)) {
    throw invalidUpstreamPayload();
  }
  const status = payload.status === "idempotent_replay" ? "idempotent_replay" : "created";
  const userInput = payload.user ?? payload.v2_user;
  const keyInput = payload.key;
  if (!isRecord(userInput) || typeof userInput.id !== "string" || !isRecord(keyInput)) {
    throw invalidUpstreamPayload();
  }
  if (typeof keyInput.id !== "string" || typeof keyInput.key !== "string") {
    throw invalidUpstreamPayload();
  }
  return {
    status,
    user: {
      id: userInput.id,
      state: typeof userInput.state === "string" ? userInput.state : undefined
    },
    key: {
      id: keyInput.id,
      key: keyInput.key,
      keyPrefix:
        typeof keyInput.key_prefix === "string"
          ? keyInput.key_prefix
          : prefixForV2Key(keyInput.key),
      issuedAt: parseOptionalDate(keyInput.issued_at),
      expiresAt: parseOptionalDate(keyInput.expires_at)
    }
  };
}

function parseRevokeKeyResult(payload: unknown): UpstreamV2RevokeKeyResult {
  if (!isRecord(payload)) {
    throw invalidUpstreamPayload();
  }
  const keyInput = payload.key;
  if (!isRecord(keyInput) || typeof keyInput.id !== "string") {
    throw invalidUpstreamPayload();
  }
  return {
    revoked: payload.revoked !== false,
    key: {
      id: keyInput.id,
      state: typeof keyInput.state === "string" ? keyInput.state : undefined
    }
  };
}

function parseDisableUserResult(payload: unknown): UpstreamV2DisableUserResult {
  if (!isRecord(payload)) {
    throw invalidUpstreamPayload();
  }
  const userInput = payload.user ?? payload.v2_user;
  if (!isRecord(userInput) || typeof userInput.id !== "string") {
    throw invalidUpstreamPayload();
  }
  return {
    disabled: payload.disabled !== false,
    user: {
      id: userInput.id,
      state: typeof userInput.state === "string" ? userInput.state : undefined
    },
    revokedKeyCount: typeof payload.revoked_key_count === "number" ? payload.revoked_key_count : null
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError({
      code: "upstream_unavailable",
      message: "MedEvidence v2 returned a non-JSON response.",
      httpStatus: 502
    });
  }
}

function mapUpstreamError(response: Response, payload: unknown): GatewayError {
  const errorCode = upstreamErrorCode(payload);
  if (response.status === 400) {
    return new GatewayError({
      code: "invalid_request",
      message: upstreamMessage(payload, "MedEvidence v2 rejected the provisioning request."),
      httpStatus: 400
    });
  }
  if (response.status === 401 || response.status === 403) {
    return new GatewayError({
      code: "upstream_unavailable",
      message: "MedEvidence v2 provisioning auth failed.",
      httpStatus: 502
    });
  }
  if (response.status === 409) {
    if (errorCode === "idempotency_conflict") {
      return new GatewayError({
        code: "idempotency_conflict",
        message: upstreamMessage(payload, "MedEvidence v2 idempotency conflict."),
        httpStatus: 409
      });
    }
    if (errorCode === "principal_already_exists") {
      return new GatewayError({
        code: "subject_already_exists",
        message: upstreamMessage(payload, "MedEvidence v2 principal already exists."),
        httpStatus: 409
      });
    }
    if (errorCode === "idempotency_in_progress") {
      return new GatewayError({
        code: "idempotency_in_progress",
        message: upstreamMessage(payload, "MedEvidence v2 idempotency request is still in progress."),
        httpStatus: 409,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) ?? 1
      });
    }
    if (errorCode === "idempotency_expired") {
      return new GatewayError({
        code: "idempotency_expired",
        message: upstreamMessage(payload, "MedEvidence v2 idempotency result has expired."),
        httpStatus: 409
      });
    }
    return new GatewayError({
      code: "upstream_unavailable",
      message: upstreamMessage(payload, "MedEvidence v2 provisioning conflict."),
      httpStatus: 502
    });
  }
  if (response.status === 429) {
    return new GatewayError({
      code: "rate_limited",
      message: upstreamMessage(payload, "MedEvidence v2 provisioning is rate limited."),
      httpStatus: 429,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) ?? 1
    });
  }
  return new GatewayError({
    code: "upstream_unavailable",
    message: upstreamMessage(payload, "MedEvidence v2 provisioning failed."),
    httpStatus: 502
  });
}

function upstreamErrorCode(payload: unknown): string | null {
  if (isRecord(payload) && typeof payload.error_code === "string") {
    return payload.error_code;
  }
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string") {
    return payload.error.code;
  }
  return null;
}

function upstreamMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

function invalidUpstreamPayload(): GatewayError {
  return new GatewayError({
    code: "upstream_unavailable",
    message: "MedEvidence v2 provisioning response is invalid.",
    httpStatus: 502
  });
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("GATEWAY_UPSTREAM_V2_TIMEOUT_MS must be a positive integer.");
  }
  return parsed;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function parseOptionalDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function prefixForV2Key(value: string): string | null {
  if (value.startsWith("mev2_live_")) {
    return value.slice(0, Math.min(value.length, 24));
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
