import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  extractAccessCredentialPrefix,
  GatewayError,
  verifyAccessCredentialToken,
  type CredentialAuthStore,
  type ProviderAdapter,
  type Subscription
} from "@codex-gateway/core";
import type { GatewayRequestContext } from "./context.js";

export interface DevAuthOptions {
  accessToken: string | undefined;
  context: GatewayRequestContext;
}

export async function devAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: DevAuthOptions
) {
  if (request.routeOptions.config?.public) {
    return;
  }

  const error = authenticateDevBearer(request, options.accessToken);
  if (error) {
    sendGatewayError(reply, error);
    return;
  }

  request.gatewayContext = options.context;
}

export interface CredentialAuthOptions {
  store: CredentialAuthStore;
  provider: ProviderAdapter;
  subscription: Subscription;
  now?: () => Date;
}

export async function credentialAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CredentialAuthOptions
) {
  if (request.routeOptions.config?.public) {
    return;
  }

  const result = authenticateCredentialBearer(request, options);
  if (result instanceof GatewayError) {
    sendGatewayError(reply, result);
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
    return tokenError;
  }

  const subject = options.store.getSubject(credential.subjectId);
  if (!subject || subject.state !== "active") {
    return new GatewayError({
      code: "invalid_credential",
      message: "Invalid access credential.",
      httpStatus: 401
    });
  }

  return {
    subject,
    subscription: options.subscription,
    provider: options.provider,
    scope: credential.scope,
    credential: {
      id: credential.id,
      prefix: credential.prefix,
      label: credential.label,
      expiresAt: credential.expiresAt
    }
  };
}

function sendGatewayError(reply: FastifyReply, error: GatewayError): void {
  reply.code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  });
}

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
