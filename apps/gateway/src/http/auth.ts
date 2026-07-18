import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  checkAccessCredentialState,
  extractAccessCredentialPrefix,
  extractUnifiedClientKeyPrefix,
  GatewayError,
  verifyAccessCredentialToken,
  verifyUnifiedClientKeyToken,
  type CredentialAuthStore,
  type ProviderAdapter,
  type UnifiedClientKeyStore,
  type UpstreamAccount
} from "@codex-gateway/core";
import type { GatewayRequestContext } from "./context.js";
import { researchErrorPayload } from "./error-response.js";
import { markGatewayError } from "./observation.js";
import { openAIErrorPayload } from "../openai-compat.js";

export interface DevAuthOptions {
  accessToken: string | undefined;
  context: GatewayRequestContext;
}

export async function devAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: DevAuthOptions
) {
  if (request.routeOptions.config?.public || request.routeOptions.config?.skipAuth) {
    return;
  }

  const error = authenticateDevBearer(request, options.accessToken);
  if (error) {
    sendGatewayError(request, reply, error);
    return;
  }

  request.gatewayContext = options.context;
}

export interface CredentialAuthOptions {
  store: CredentialAuthStore;
  unifiedClientKeyStore?: UnifiedClientKeyStore;
  provider: ProviderAdapter;
  upstreamAccount: UpstreamAccount;
  now?: () => Date;
}

export async function credentialAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CredentialAuthOptions
) {
  if (request.routeOptions.config?.public || request.routeOptions.config?.skipAuth) {
    return;
  }

  const result = authenticateCredentialBearer(request, options);
  if (result instanceof GatewayError) {
    sendGatewayError(request, reply, result);
    return;
  }

  request.gatewayContext = result;
}

function authenticateDevBearer(
  request: FastifyRequest,
  accessToken: string | undefined
): GatewayError | null {
  if (!accessToken) {
    return new GatewayError({
      code: "service_unavailable",
      message: "Gateway dev access token is not configured.",
      httpStatus: 503
    });
  }

  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "Missing access credential.",
      httpStatus: 401
    });
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !safeEqual(token ?? "", accessToken)) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  return null;
}

function authenticateCredentialBearer(
  request: FastifyRequest,
  options: CredentialAuthOptions
): GatewayRequestContext | GatewayError {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "Missing access credential.",
      httpStatus: 401
    });
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  const unifiedPrefix = extractUnifiedClientKeyPrefix(token);
  if (unifiedPrefix) {
    return authenticateUnifiedClientKey(token, unifiedPrefix, request, options);
  }

  const prefix = extractAccessCredentialPrefix(token);
  if (!prefix) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  const credential = options.store.getAccessCredentialByPrefix(prefix);
  if (!credential) {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  const tokenError = verifyAccessCredentialToken(token, credential, options.now?.() ?? new Date());
  if (tokenError) {
    if (tokenError.code !== "invalid_credential") {
      request.gatewayObservedCredential = {
        id: credential.id,
        subjectId: credential.subjectId,
        scope: credential.scope
      };
    }
    return tokenError;
  }

  const subject = options.store.getSubject(credential.subjectId);
  if (!subject || subject.state !== "active") {
    request.gatewayObservedCredential = {
      id: credential.id,
      subjectId: credential.subjectId,
      scope: credential.scope
    };
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  return {
    subject,
    upstreamAccount: options.upstreamAccount,
    provider: options.provider,
    scope: credential.scope,
    credential: {
      id: credential.id,
      prefix: credential.prefix,
      label: credential.label,
      expiresAt: credential.expiresAt,
      rate: credential.rate,
      allowedPublicModels: credential.allowedPublicModels
    }
  };
}

function authenticateUnifiedClientKey(
  token: string,
  prefix: string,
  request: FastifyRequest,
  options: CredentialAuthOptions
): GatewayRequestContext | GatewayError {
  const unifiedStore = options.unifiedClientKeyStore;
  if (!unifiedStore) {
    return invalidCredential();
  }

  const now = options.now?.() ?? new Date();
  const record = unifiedStore.getUnifiedClientKeyByPrefix(prefix);
  if (!record) {
    return invalidCredential();
  }

  const unifiedError = verifyUnifiedClientKeyToken(token, record, now);
  if (unifiedError) {
    if (unifiedError.code !== "invalid_credential") {
      const backingCredential = options.store.getAccessCredentialByPrefix(
        record.codexCredentialPrefix
      );
      if (
        backingCredential &&
        backingCredential.id === record.codexCredentialId &&
        backingCredential.subjectId === record.subjectId
      ) {
        request.gatewayObservedCredential = {
          id: backingCredential.id,
          subjectId: backingCredential.subjectId,
          scope: backingCredential.scope
        };
      }
    }
    return unifiedError;
  }

  const subject = options.store.getSubject(record.subjectId);
  if (!subject || subject.state !== "active") {
    return invalidCredential();
  }

  const credential = options.store.getAccessCredentialByPrefix(record.codexCredentialPrefix);
  if (
    !credential ||
    credential.id !== record.codexCredentialId ||
    credential.subjectId !== record.subjectId
  ) {
    return invalidCredential();
  }

  const credentialStateError = checkAccessCredentialState(credential, now);
  if (credentialStateError) {
    request.gatewayObservedCredential = {
      id: credential.id,
      subjectId: credential.subjectId,
      scope: credential.scope
    };
    return credentialStateError;
  }

  return {
    subject,
    upstreamAccount: options.upstreamAccount,
    provider: options.provider,
    scope: credential.scope,
    credential: {
      id: credential.id,
      prefix: credential.prefix,
      label: credential.label,
      expiresAt: credential.expiresAt,
      rate: credential.rate,
      allowedPublicModels: credential.allowedPublicModels
    }
  };
}

function invalidCredential(): GatewayError {
  return new GatewayError({
    code: "invalid_credential",
    message: "Invalid access credential.",
    httpStatus: 401
  });
}

function sendGatewayError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError
): void {
  markGatewayError(request, error);
  reply.code(error.httpStatus).send(errorPayload(request, error));
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function errorPayload(request: FastifyRequest, error: GatewayError) {
  const dialect = request.routeOptions.config?.responseDialect;
  if (
    dialect === "research" ||
    request.url.startsWith("/gateway/research/v1/")
  ) {
    return researchErrorPayload(error, { requestId: request.id });
  }
  if (dialect === "openai" || (!dialect && request.url.startsWith("/v1/"))) {
    return openAIErrorPayload(error, { requestId: request.id });
  }

  return {
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  };
}
