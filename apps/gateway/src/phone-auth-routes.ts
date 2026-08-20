import { createHash } from "node:crypto";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { GatewayError } from "@codex-gateway/core";
import {
  applyPrivateResponseHeaders,
  desktopVersionGateError,
  sendDesktopVersionGateError,
  type DesktopVersionGate
} from "./desktop-version-gate.js";
import { markGatewayError } from "./http/observation.js";
import type { CredentialRateLimiter } from "./services/rate-limiter.js";
import type { PhoneAuthService } from "./services/phone-auth-service.js";

export interface PhoneAuthRouteOptions {
  service: PhoneAuthService | null;
  versionGate: DesktopVersionGate;
  loginRateLimiter: CredentialRateLimiter;
  phoneRequestsPerMinute: number;
  ipRequestsPerMinute: number;
}

interface LoginBody {
  phone: string;
  deviceId: string;
}

interface RefreshBody {
  refreshToken: string;
  deviceId: string;
}

const routeConfig = {
  public: true,
  skipRateLimit: true
} as const;

const phoneAuthContractPaths = new Set([
  "/gateway/auth/v1/login/start",
  "/gateway/auth/v1/token/refresh",
  "/gateway/auth/v1/logout",
  "/gateway/auth/v1/session/bootstrap",
  "/gateway/account/v1/current"
]);

export function registerPhoneAuthRoutes(
  app: FastifyInstance,
  options: PhoneAuthRouteOptions
): void {
  app.post<{ Body: unknown }>(
    "/gateway/auth/v1/login/start",
    {
      config: routeConfig,
      bodyLimit: 4_096,
      errorHandler: phoneAuthContractErrorHandler
    },
    async (request, reply) => {
      const preflight = phoneAuthPreflight(request, reply, options);
      if (preflight) {
        return preflight;
      }
      const body = parseLoginBody(request.body);
      if (body instanceof GatewayError) {
        return sendPhoneAuthError(request, reply, body);
      }
      const service = options.service;
      if (!service) {
        return sendPhoneAuthError(request, reply, phoneAuthUnavailable());
      }

      let phoneHash: string;
      try {
        phoneHash = service.phoneHash(body.phone);
      } catch (error) {
        return sendPhoneAuthFailure(request, reply, error);
      }
      const permits = acquireLoginPermits(request, phoneHash, options);
      if (permits instanceof GatewayError) {
        try {
          service.recordLoginRateLimit(phoneHash, request.id);
        } catch (error) {
          return sendPhoneAuthFailure(request, reply, error);
        }
        return sendPhoneAuthError(request, reply, permits);
      }
      try {
        return service.login({
          phone: body.phone,
          deviceId: body.deviceId,
          requestId: request.id
        });
      } catch (error) {
        return sendPhoneAuthFailure(request, reply, error);
      } finally {
        permits.release();
      }
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/auth/v1/token/refresh",
    {
      config: routeConfig,
      bodyLimit: 4_096,
      errorHandler: phoneAuthContractErrorHandler
    },
    async (request, reply) => {
      const preflight = phoneAuthPreflight(request, reply, options);
      if (preflight) {
        return preflight;
      }
      const body = parseRefreshBody(request.body);
      if (body instanceof GatewayError) {
        return sendPhoneAuthError(request, reply, body);
      }
      const service = options.service;
      if (!service) {
        return sendPhoneAuthError(request, reply, phoneAuthUnavailable());
      }
      try {
        return service.refresh({
          refreshToken: body.refreshToken,
          deviceId: body.deviceId,
          requestId: request.id
        });
      } catch (error) {
        return sendPhoneAuthFailure(request, reply, error);
      }
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/auth/v1/logout",
    {
      config: routeConfig,
      bodyLimit: 128,
      errorHandler: phoneAuthContractErrorHandler
    },
    async (request, reply) => {
      const preflight = phoneAuthPreflight(request, reply, options);
      if (preflight) {
        return preflight;
      }
      const bodyError = validateEmptyBody(request.body);
      if (bodyError) {
        return sendPhoneAuthError(request, reply, bodyError);
      }
      const token = accessBearer(request);
      if (token instanceof GatewayError) {
        return sendPhoneAuthError(request, reply, token);
      }
      const service = options.service;
      if (!service) {
        return sendPhoneAuthError(request, reply, phoneAuthUnavailable());
      }
      try {
        service.logout(token, request.id);
        return reply.code(204).send();
      } catch (error) {
        return sendPhoneAuthFailure(request, reply, error);
      }
    }
  );

  app.post<{ Body: unknown }>(
    "/gateway/auth/v1/session/bootstrap",
    {
      config: routeConfig,
      bodyLimit: 128,
      errorHandler: phoneAuthContractErrorHandler
    },
    async (request, reply) => {
      const preflight = phoneAuthPreflight(request, reply, options);
      if (preflight) {
        return preflight;
      }
      const bodyError = validateEmptyBody(request.body);
      if (bodyError) {
        return sendPhoneAuthError(request, reply, bodyError);
      }
      const token = accessBearer(request);
      if (token instanceof GatewayError) {
        return sendPhoneAuthError(request, reply, token);
      }
      const service = options.service;
      if (!service) {
        return sendPhoneAuthError(request, reply, phoneAuthUnavailable());
      }
      try {
        return service.bootstrap(token, request.id);
      } catch (error) {
        return sendPhoneAuthFailure(request, reply, error);
      }
    }
  );

  app.get(
    "/gateway/account/v1/current",
    { config: routeConfig, errorHandler: phoneAuthContractErrorHandler },
    async (request, reply) => {
      const preflight = phoneAuthPreflight(request, reply, options);
      if (preflight) {
        return preflight;
      }
      const token = accessBearer(request);
      if (token instanceof GatewayError) {
        return sendPhoneAuthError(request, reply, token);
      }
      const service = options.service;
      if (!service) {
        return sendPhoneAuthError(request, reply, phoneAuthUnavailable());
      }
      try {
        return service.accountCurrent(token, request.id);
      } catch (error) {
        return sendPhoneAuthFailure(request, reply, error);
      }
    }
  );
}

export function phoneAuthContractErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (
    error.statusCode === 400 ||
    error.statusCode === 413 ||
    error.statusCode === 415
  ) {
    sendPhoneAuthError(request, reply, invalidRequest());
    return;
  }
  throw error;
}

export function sendPhoneAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError
): FastifyReply {
  markGatewayError(request, error);
  applyPrivateResponseHeaders(reply);
  if (error.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(error.retryAfterSeconds));
  }
  return reply.code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id,
      ...(error.retryAfterSeconds !== undefined
        ? { retry_after_seconds: error.retryAfterSeconds }
        : {})
    }
  });
}

export function isPhoneAuthContractRoute(method: string, url: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const path = url.split("?", 1)[0] ?? url;
  return (
    (normalizedMethod === "POST" &&
      phoneAuthContractPaths.has(path) &&
      path !== "/gateway/account/v1/current") ||
    (normalizedMethod === "GET" && path === "/gateway/account/v1/current")
  );
}

function phoneAuthPreflight(
  request: FastifyRequest,
  reply: FastifyReply,
  options: PhoneAuthRouteOptions
): FastifyReply | null {
  applyPrivateResponseHeaders(reply);
  const gateError = desktopVersionGateError(request, options.versionGate);
  return gateError
    ? sendDesktopVersionGateError(request, reply, options.versionGate, gateError)
    : null;
}

function parseLoginBody(value: unknown): LoginBody | GatewayError {
  if (!hasExactKeys(value, ["phone", "client", "device_id", "contract_version"])) {
    return invalidRequest();
  }
  if (
    typeof value.phone !== "string" ||
    !/^1[3-9][0-9]{9}$/u.test(value.phone) ||
    value.client !== "medevidence-desktop" ||
    !validDeviceId(value.device_id) ||
    value.contract_version !== 1
  ) {
    return invalidRequest();
  }
  return { phone: value.phone, deviceId: value.device_id };
}

function parseRefreshBody(value: unknown): RefreshBody | GatewayError {
  if (
    !hasExactKeys(value, [
      "refresh_token",
      "client",
      "device_id",
      "contract_version"
    ])
  ) {
    return invalidRequest();
  }
  if (
    typeof value.refresh_token !== "string" ||
    !/^rft_[A-Za-z0-9_-]{64}$/u.test(value.refresh_token) ||
    value.client !== "medevidence-desktop" ||
    !validDeviceId(value.device_id) ||
    value.contract_version !== 1
  ) {
    return invalidRequest();
  }
  return {
    refreshToken: value.refresh_token,
    deviceId: value.device_id
  };
}

function validateEmptyBody(value: unknown): GatewayError | null {
  if (
    value === undefined ||
    (isRecord(value) && Object.keys(value).length === 0)
  ) {
    return null;
  }
  return invalidRequest();
}

function accessBearer(request: FastifyRequest): string | GatewayError {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "Missing access token.",
      httpStatus: 401
    });
  }
  const parts = authorization.split(/\s+/u);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer" || !parts[1]) {
    return new GatewayError({
      code: "access_token_invalid",
      message: "The access token or Session is invalid.",
      httpStatus: 401
    });
  }
  return parts[1];
}

function acquireLoginPermits(
  request: FastifyRequest,
  phoneHash: string,
  options: PhoneAuthRouteOptions
): { release(): void } | GatewayError {
  const ipHash = createHash("sha256").update(request.ip).digest("base64url");
  const ipPermit = options.loginRateLimiter.acquire({
    credentialId: `phone-auth:ip:${ipHash}`,
    policy: loginPolicy(options.ipRequestsPerMinute)
  });
  if (!("release" in ipPermit)) {
    return authRateLimited(ipPermit.error.retryAfterSeconds ?? 60);
  }
  const phonePermit = options.loginRateLimiter.acquire({
    credentialId: `phone-auth:phone:${phoneHash}`,
    policy: loginPolicy(options.phoneRequestsPerMinute)
  });
  if (!("release" in phonePermit)) {
    ipPermit.release();
    return authRateLimited(phonePermit.error.retryAfterSeconds ?? 60);
  }
  return {
    release: () => {
      ipPermit.release();
      phonePermit.release();
    }
  };
}

function loginPolicy(requestsPerMinute: number) {
  return {
    requestsPerMinute,
    requestsPerDay: null,
    concurrentRequests: null
  };
}

function validDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7E]{16,128}$/u.test(value);
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendPhoneAuthFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply {
  if (error instanceof GatewayError) {
    return sendPhoneAuthError(request, reply, error);
  }
  request.log.error({ request_id: request.id }, "Phone auth request failed.");
  return sendPhoneAuthError(request, reply, phoneAuthUnavailable());
}

function invalidRequest(): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message: "Request does not match contract version 1.",
    httpStatus: 400
  });
}

function authRateLimited(retryAfterSeconds: number): GatewayError {
  return new GatewayError({
    code: "auth_rate_limited",
    message: "Too many login attempts.",
    httpStatus: 429,
    retryAfterSeconds
  });
}

function phoneAuthUnavailable(): GatewayError {
  return new GatewayError({
    code: "service_unavailable",
    message: "Phone authentication is unavailable.",
    httpStatus: 503
  });
}
