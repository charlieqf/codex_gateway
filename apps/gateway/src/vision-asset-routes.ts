import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { GatewayError } from "@codex-gateway/core";
import { getGatewayContext } from "./http/context.js";
import { markGatewayError } from "./http/observation.js";
import {
  visionAssetMaximumBytes,
  visionAssetMaximumImagesPerRequest,
  type VisionAssetCreateInput,
  type VisionAssetReadGrant,
  type VisionAssetService,
  type VisionAssetUploadGrant
} from "./services/vision-asset-service.js";

export interface VisionAssetRouteOptions {
  service: VisionAssetService | null;
  authorize?: (
    request: FastifyRequest
  ) => GatewayError | null | Promise<GatewayError | null>;
}

const routeBodyLimitBytes = 16_384;

export function registerVisionAssetRoutes(
  app: FastifyInstance,
  options: VisionAssetRouteOptions
): void {
  app.post<{ Body: unknown }>(
    "/gateway/vision/assets",
    { bodyLimit: routeBodyLimitBytes },
    async (request, reply) => {
      applyPrivateResponseHeaders(reply);
      const service = availableService(options.service);
      if (service instanceof GatewayError) {
        return sendVisionAssetError(request, reply, service);
      }
      const authorizationError = await authorize(request, options.authorize);
      if (authorizationError) {
        return sendVisionAssetError(request, reply, authorizationError);
      }
      const input = parseCreateRequest(request.body);
      if (input instanceof GatewayError) {
        return sendVisionAssetError(request, reply, input);
      }
      try {
        const { subject } = getGatewayContext(request);
        const grant = service.createAsset(subject.id, input);
        return reply.code(201).send(uploadGrantResponse(grant));
      } catch (error) {
        return handleVisionAssetFailure(request, reply, error);
      }
    }
  );

  app.post<{ Params: { assetId: string }; Body: unknown }>(
    "/gateway/vision/assets/:assetId/complete",
    { bodyLimit: routeBodyLimitBytes },
    async (request, reply) => {
      applyPrivateResponseHeaders(reply);
      const service = availableService(options.service);
      if (service instanceof GatewayError) {
        return sendVisionAssetError(request, reply, service);
      }
      const authorizationError = await authorize(request, options.authorize);
      if (authorizationError) {
        return sendVisionAssetError(request, reply, authorizationError);
      }
      const bodyError = validateEmptyBody(request.body);
      if (bodyError) {
        return sendVisionAssetError(request, reply, bodyError);
      }
      try {
        const { subject } = getGatewayContext(request);
        const grant = await service.completeAsset(
          subject.id,
          request.params.assetId
        );
        return reply.send(readGrantResponse(grant));
      } catch (error) {
        return handleVisionAssetFailure(request, reply, error);
      }
    }
  );

  app.post<{ Params: { assetId: string }; Body: unknown }>(
    "/gateway/vision/assets/:assetId/read-url",
    { bodyLimit: routeBodyLimitBytes },
    async (request, reply) => {
      applyPrivateResponseHeaders(reply);
      const service = availableService(options.service);
      if (service instanceof GatewayError) {
        return sendVisionAssetError(request, reply, service);
      }
      const authorizationError = await authorize(request, options.authorize);
      if (authorizationError) {
        return sendVisionAssetError(request, reply, authorizationError);
      }
      const bodyError = validateEmptyBody(request.body);
      if (bodyError) {
        return sendVisionAssetError(request, reply, bodyError);
      }
      try {
        const { subject } = getGatewayContext(request);
        const grant = await service.createReadUrl(
          subject.id,
          request.params.assetId
        );
        return reply.send(readGrantResponse(grant));
      } catch (error) {
        return handleVisionAssetFailure(request, reply, error);
      }
    }
  );

  app.delete<{ Params: { assetId: string } }>(
    "/gateway/vision/assets/:assetId",
    async (request, reply) => {
      applyPrivateResponseHeaders(reply);
      const service = availableService(options.service);
      if (service instanceof GatewayError) {
        return sendVisionAssetError(request, reply, service);
      }
      const authorizationError = await authorize(request, options.authorize);
      if (authorizationError) {
        return sendVisionAssetError(request, reply, authorizationError);
      }
      try {
        const { subject } = getGatewayContext(request);
        await service.deleteAsset(subject.id, request.params.assetId);
        return reply.code(204).send();
      } catch (error) {
        return handleVisionAssetFailure(request, reply, error);
      }
    }
  );
}

function parseCreateRequest(body: unknown): VisionAssetCreateInput | GatewayError {
  if (!isRecord(body)) {
    return invalidRequest("Request body must be a JSON object.");
  }
  const allowedKeys = new Set(["content_type", "size_bytes", "sha256"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return invalidRequest(
      "Request body may only include content_type, size_bytes and sha256."
    );
  }
  if (body.content_type !== "image/png" && body.content_type !== "image/jpeg") {
    return new GatewayError({
      code: "unsupported_format",
      message: "content_type must be image/png or image/jpeg.",
      httpStatus: 400
    });
  }
  if (
    !Number.isSafeInteger(body.size_bytes) ||
    (body.size_bytes as number) < 1 ||
    (body.size_bytes as number) > visionAssetMaximumBytes
  ) {
    return new GatewayError({
      code: "unsupported_size",
      message: `size_bytes must be between 1 and ${visionAssetMaximumBytes}.`,
      httpStatus: 400
    });
  }
  if (typeof body.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/u.test(body.sha256)) {
    return invalidRequest(
      "sha256 must be a 64-character hexadecimal digest."
    );
  }
  return {
    contentType: body.content_type,
    sizeBytes: body.size_bytes as number,
    sha256: body.sha256.toLowerCase()
  };
}

function validateEmptyBody(body: unknown): GatewayError | null {
  if (body === undefined || body === null) {
    return null;
  }
  if (isRecord(body) && Object.keys(body).length === 0) {
    return null;
  }
  return invalidRequest("Request body must be empty.");
}

function availableService(
  service: VisionAssetService | null
): VisionAssetService | GatewayError {
  return (
    service ??
    new GatewayError({
      code: "service_unavailable",
      message: "Vision asset storage is not configured.",
      httpStatus: 503
    })
  );
}

async function authorize(
  request: FastifyRequest,
  authorizer: VisionAssetRouteOptions["authorize"]
): Promise<GatewayError | null> {
  if (!authorizer) {
    return null;
  }
  try {
    return await authorizer(request);
  } catch {
    return new GatewayError({
      code: "service_unavailable",
      message: "Vision asset authorization is temporarily unavailable.",
      httpStatus: 503
    });
  }
}

function uploadGrantResponse(grant: VisionAssetUploadGrant) {
  return {
    asset_id: grant.assetId,
    state: "pending_upload",
    content_type: grant.contentType,
    size_bytes: grant.sizeBytes,
    sha256: grant.sha256,
    upload: {
      method: "PUT",
      url: grant.uploadUrl,
      headers: grant.uploadHeaders,
      expires_at: grant.uploadExpiresAt.toISOString()
    },
    asset_expires_at: grant.assetExpiresAt.toISOString(),
    limits: {
      maximum_bytes: visionAssetMaximumBytes,
      maximum_images_per_model_request: visionAssetMaximumImagesPerRequest
    }
  };
}

function readGrantResponse(grant: VisionAssetReadGrant) {
  return {
    asset_id: grant.assetId,
    state: "ready",
    content_type: grant.contentType,
    size_bytes: grant.sizeBytes,
    sha256: grant.sha256,
    image_url: grant.imageUrl,
    read_url_expires_at: grant.readUrlExpiresAt.toISOString(),
    asset_expires_at: grant.assetExpiresAt.toISOString()
  };
}

function handleVisionAssetFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply {
  if (error instanceof GatewayError) {
    return sendVisionAssetError(request, reply, error);
  }
  request.log.error(
    {
      request_id: request.id,
      error_type:
        error instanceof Error && error.name ? error.name : "UnknownError"
    },
    "Vision asset request failed."
  );
  return sendVisionAssetError(
    request,
    reply,
    new GatewayError({
      code: "service_unavailable",
      message: "Vision asset storage is temporarily unavailable.",
      httpStatus: 503
    })
  );
}

function sendVisionAssetError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: GatewayError
): FastifyReply {
  markGatewayError(request, error);
  return reply.code(error.httpStatus).send({
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  });
}

function applyPrivateResponseHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function invalidRequest(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus: 400
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
