import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GatewayError } from "@codex-gateway/core";
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
    reply.code(error.httpStatus).send({
      error: {
        code: error.code,
        message: error.message,
        retry_after_seconds: error.retryAfterSeconds
      }
    });
    return;
  }

  request.gatewayContext = options.context;
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

function safeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}
