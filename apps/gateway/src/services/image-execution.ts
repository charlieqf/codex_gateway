import { type FastifyReply, type FastifyRequest } from "fastify";
import { GatewayError } from "@codex-gateway/core";
import { getGatewayContext } from "../http/context.js";
import { markFirstByte } from "../http/observation.js";
import {
  buildImageGenerationResponse,
  finalizeImageGenerationResult,
  isImageBillingLimitError,
  type ImageGenerationRequest,
  type ImageGenerationProvider
} from "../image-generation.js";
import {
  UpstreamAccountRouter,
  type UpstreamImageLease,
  type ImageProviderOutcome
} from "./upstream-account-router.js";
import type { ImageGenerationBillingFallback } from "../runtime/image-providers.js";
import { requestAffinityKey } from "./chat-request-shaping.js";
import { maxStatelessAttempts } from "../runtime/env.js";
import { sendImageError } from "../http/gateway-errors.js";

export async function generateImageWithAccountPool(
  request: FastifyRequest,
  reply: FastifyReply,
  router: UpstreamAccountRouter,
  input: {
    parsed: ImageGenerationRequest;
    upstreamModel: string;
    timeoutMs: number;
    billingFallbacks: readonly ImageGenerationBillingFallback[];
  }
) {
  const affinityKey = requestAffinityKey(request, router.softAffinity);
  const attemptedAccountIds = new Set<string>();
  let lastError: GatewayError | null = null;
  const abort = createImageRequestAbort(request.gatewayClientDisconnect?.signal, input.timeoutMs);

  try {
    for (let attemptIndex = 0; attemptIndex < maxStatelessAttempts; attemptIndex += 1) {
      const lease = router.beginImage({ affinityKey, excludeAccountIds: attemptedAccountIds });
      if (lease instanceof GatewayError) {
        return sendImageError(request, reply, lastError ?? lease);
      }
      attemptedAccountIds.add(lease.upstreamAccount.id);
      applyImageSelection(request, lease, input.upstreamModel);

      try {
        const result = await runImageGenerationWithAbort(lease.imageProvider, abort, {
          request: input.parsed,
          upstreamModel: input.upstreamModel
        });
        const finalized = await finalizeImageGenerationResult({
          request: input.parsed,
          result
        });
        router.recordImageOutcome(lease.upstreamAccount.id, "success");
        markFirstByte(request);
        return buildImageGenerationResponse({
          request: input.parsed,
          result: finalized
        });
      } catch (err) {
        const error = imageErrorFromUnknown(err);
        const outcome = imageOutcomeFromError(error);
        if (outcome) {
          router.recordImageOutcome(lease.upstreamAccount.id, outcome);
        }
        lastError = error;
        if (isImageBillingLimitError(error) && input.billingFallbacks.length > 0) {
          try {
            return await generateImageWithBillingFallbacks(request, abort, {
              parsed: input.parsed,
              billingFallbacks: input.billingFallbacks
            });
          } catch (fallbackErr) {
            return sendImageError(request, reply, imageErrorFromUnknown(fallbackErr));
          }
        }
        if (
          abort.clientAborted() ||
          abort.timedOut() ||
          !outcome ||
          !isImageRetryableOutcome(outcome) ||
          attemptIndex + 1 >= maxStatelessAttempts
        ) {
          return sendImageError(request, reply, error);
        }
      } finally {
        lease.release();
      }
    }
  } finally {
    abort.cleanup();
  }

  return sendImageError(
    request,
    reply,
    lastError ??
      new GatewayError({
        code: "upstream_unavailable",
        message: "Image generation service is unavailable.",
        httpStatus: 503
      })
  );
}

interface ImageRequestAbort {
  signal: AbortSignal;
  promise: Promise<never>;
  cleanup: () => void;
  clientAborted: () => boolean;
  timedOut: () => boolean;
}

export function createImageRequestAbort(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): ImageRequestAbort {
  const controller = new AbortController();
  let settled = false;
  let rejectAbort!: (error: GatewayError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });

  const abortWith = (reason: Error, error: GatewayError) => {
    if (settled) {
      return;
    }
    settled = true;
    controller.abort(reason);
    rejectAbort(error);
  };
  const abortClient = () =>
    abortWith(
      new Error("client_aborted"),
      new GatewayError({
        code: "client_aborted",
        message: "Client aborted image generation.",
        httpStatus: 499
      })
    );
  const timeout = setTimeout(
    () =>
      abortWith(
        new Error("gateway_image_timeout"),
        new GatewayError({
          code: "upstream_timeout",
          message: "Image generation timed out.",
          httpStatus: 504
        })
      ),
    timeoutMs
  );

  if (parentSignal?.aborted) {
    abortClient();
  } else {
    parentSignal?.addEventListener("abort", abortClient, { once: true });
  }

  return {
    signal: controller.signal,
    promise,
    cleanup: () => {
      settled = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortClient);
    },
    clientAborted: () => isAbortReason(controller.signal.reason, "client_aborted"),
    timedOut: () => isAbortReason(controller.signal.reason, "gateway_image_timeout")
  };
}

export async function runImageGenerationWithAbort(
  provider: ImageGenerationProvider,
  abort: ImageRequestAbort,
  input: {
    request: ImageGenerationRequest;
    upstreamModel: string;
  }
) {
  return Promise.race([
    provider.generate({
      ...input,
      signal: abort.signal
    }),
    abort.promise
  ]);
}

export async function generateImageWithBillingFallbacks(
  request: FastifyRequest,
  abort: ImageRequestAbort,
  input: {
    parsed: ImageGenerationRequest;
    billingFallbacks: readonly ImageGenerationBillingFallback[];
  }
) {
  let lastError: GatewayError | null = null;
  for (let index = 0; index < input.billingFallbacks.length; index += 1) {
    const fallback = input.billingFallbacks[index];
    applyImageAttemptAttribution(request, {
      provider: fallback.provider,
      upstreamModel: fallback.upstreamModel,
      upstreamAccountId: fallback.accountId
    });
    try {
      const result = await runImageGenerationWithAbort(fallback.provider, abort, {
        request: input.parsed,
        upstreamModel: fallback.upstreamModel
      });
      const finalized = await finalizeImageGenerationResult({
        request: input.parsed,
        result
      });
      markFirstByte(request);
      return buildImageGenerationResponse({
        request: input.parsed,
        result: finalized
      });
    } catch (err) {
      const error = imageErrorFromUnknown(err);
      lastError = error;
      if (!isImageFallbackRetryableError(error) || index + 1 >= input.billingFallbacks.length) {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new GatewayError({
      code: "upstream_unavailable",
      message: "Image generation service is unavailable.",
      httpStatus: 503
    })
  );
}

export function imageErrorFromUnknown(err: unknown): GatewayError {
  return err instanceof GatewayError
    ? err
    : new GatewayError({
        code: "upstream_unavailable",
        message: "Image generation service is unavailable.",
        httpStatus: 503
      });
}

function isAbortReason(reason: unknown, message: string): boolean {
  return reason instanceof Error && reason.message === message;
}

function applyImageSelection(
  request: FastifyRequest,
  selection: UpstreamImageLease,
  upstreamModel: string
): void {
  const context = getGatewayContext(request);
  request.gatewayContext = {
    ...context,
    upstreamAccount: selection.upstreamAccount
  };
  applyImageAttemptAttribution(request, {
    provider: selection.imageProvider,
    upstreamModel,
    upstreamAccountId: selection.upstreamAccount.id
  });
}

export function applyImageAttemptAttribution(
  request: FastifyRequest,
  input: {
    provider: ImageGenerationProvider;
    upstreamModel: string;
    upstreamAccountId: string | null;
  }
): void {
  request.gatewayObservedUpstreamAccount = {
    id: input.upstreamAccountId,
    provider: input.provider.providerKind
  };
  request.gatewayUpstreamModel = input.upstreamModel;
}

function imageOutcomeFromError(error: GatewayError): ImageProviderOutcome | null {
  if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
    return "key_invalid";
  }
  if (isImageBillingLimitError(error)) {
    return "service_error";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  if (error.code === "upstream_timeout") {
    return "upstream_timeout";
  }
  if (error.code === "content_policy_violation") {
    return "content_policy_violation";
  }
  if (error.code === "invalid_request") {
    return "invalid_request";
  }
  if (error.code === "upstream_unavailable" || error.code === "service_unavailable") {
    return "service_error";
  }
  return null;
}

function isImageRetryableOutcome(outcome: ImageProviderOutcome): boolean {
  return (
    outcome === "rate_limited" ||
    outcome === "service_error" ||
    outcome === "upstream_timeout" ||
    outcome === "key_invalid"
  );
}

export function isImageFallbackRetryableError(error: GatewayError): boolean {
  if (isImageBillingLimitError(error)) {
    return true;
  }
  const outcome = imageOutcomeFromError(error);
  return outcome !== null && isImageRetryableOutcome(outcome);
}
