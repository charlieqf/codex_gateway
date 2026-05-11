import { randomUUID } from "node:crypto";
import { GatewayError, isRecord, type FeaturePolicy } from "@codex-gateway/core";

const supportedSizes = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
const supportedFormats = ["png", "jpeg", "webp"] as const;
const supportedQualities = ["auto"] as const;
const defaultInternalModel = "medcode-image-default";
const defaultUpstreamModel = "gpt-image-2";
const defaultOutputFormat = "png";

export type ImageGenerationSize = (typeof supportedSizes)[number];
export type ImageGenerationOutputFormat = (typeof supportedFormats)[number];
export type ImageGenerationQuality = (typeof supportedQualities)[number];

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  outputFormat: ImageGenerationOutputFormat;
  metadata: Record<string, string>;
}

export interface ImageGenerationUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  id?: string;
  created?: number;
  model?: string;
  data: Array<{
    b64_json: string;
    mime_type?: string;
  }>;
  usage?: ImageGenerationUsage;
}

export interface ImageGenerationProvider {
  generate(input: {
    request: ImageGenerationRequest;
    upstreamModel: string;
    signal?: AbortSignal;
  }): Promise<ImageGenerationResult>;
}

export interface OpenAIImageGenerationProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function parseImageGenerationRequest(
  body: unknown,
  input: {
    maxPromptChars: number;
    defaultModel?: string;
  }
): ImageGenerationRequest | GatewayError {
  if (!isRecord(body)) {
    return imageInvalidRequest("Request body must be a JSON object.");
  }

  if (body.n !== undefined) {
    return imageInvalidRequest("n is not supported for image generation MVP.");
  }
  if (body.output_compression !== undefined) {
    return imageInvalidRequest("output_compression is not supported for image generation MVP.");
  }

  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return imageInvalidRequest("prompt must be a non-empty string.");
  }
  if (body.prompt.length > input.maxPromptChars) {
    return imageInvalidRequest(`prompt must be at most ${input.maxPromptChars} characters.`);
  }

  const model =
    typeof body.model === "string" && body.model.length > 0
      ? body.model
      : input.defaultModel ?? defaultInternalModel;
  if (model !== defaultInternalModel) {
    return new GatewayError({
      code: "unsupported_model",
      message: `Unsupported image model: ${model}.`,
      httpStatus: 400
    });
  }

  const size = body.size ?? "auto";
  if (!supportedSizes.includes(size as ImageGenerationSize)) {
    return new GatewayError({
      code: "unsupported_size",
      message: `Unsupported image size: ${String(size)}.`,
      httpStatus: 400
    });
  }

  const quality = body.quality ?? "auto";
  if (!supportedQualities.includes(quality as ImageGenerationQuality)) {
    return new GatewayError({
      code: "unsupported_quality",
      message: `Unsupported image quality: ${String(quality)}.`,
      httpStatus: 400
    });
  }

  const outputFormat = body.output_format ?? defaultOutputFormat;
  if (!supportedFormats.includes(outputFormat as ImageGenerationOutputFormat)) {
    return new GatewayError({
      code: "unsupported_format",
      message: `Unsupported image output_format: ${String(outputFormat)}.`,
      httpStatus: 400
    });
  }

  const metadata = parseMetadata(body.metadata);
  if (metadata instanceof GatewayError) {
    return metadata;
  }

  return {
    prompt: body.prompt,
    model,
    size: size as ImageGenerationSize,
    quality: quality as ImageGenerationQuality,
    outputFormat: outputFormat as ImageGenerationOutputFormat,
    metadata
  };
}

export function resolveImageUpstreamModel(
  request: ImageGenerationRequest,
  featurePolicy: FeaturePolicy,
  modelMap: Record<string, string>
): string | GatewayError {
  const imagePolicy = featurePolicy.imageGeneration;
  if (
    !featurePolicy.capabilities.includes("image_generation") ||
    !imagePolicy ||
    !imagePolicy.enabled
  ) {
    return new GatewayError({
      code: "plan_capability_required",
      message: "This credential is not entitled for image generation.",
      httpStatus: 403
    });
  }
  if (!imagePolicy.allowedModels.includes(request.model)) {
    return new GatewayError({
      code: "unsupported_model",
      message: `Unsupported image model: ${request.model}.`,
      httpStatus: 400
    });
  }
  if (!imagePolicy.allowedSizes.includes(request.size)) {
    return new GatewayError({
      code: "unsupported_size",
      message: `Unsupported image size: ${request.size}.`,
      httpStatus: 400
    });
  }
  if (!imagePolicy.allowedQualities.includes(request.quality)) {
    return new GatewayError({
      code: "unsupported_quality",
      message: `Unsupported image quality: ${request.quality}.`,
      httpStatus: 400
    });
  }
  if (!imagePolicy.allowedFormats.includes(request.outputFormat)) {
    return new GatewayError({
      code: "unsupported_format",
      message: `Unsupported image output_format: ${request.outputFormat}.`,
      httpStatus: 400
    });
  }
  return modelMap[request.model] ?? defaultUpstreamModel;
}

export function buildImageGenerationResponse(input: {
  request: ImageGenerationRequest;
  result: ImageGenerationResult;
  createdAt?: Date;
}) {
  const created = input.result.created ?? Math.floor((input.createdAt ?? new Date()).getTime() / 1000);
  return {
    id: input.result.id ?? `imgreq_${randomUUID().replaceAll("-", "")}`,
    model: input.request.model,
    created,
    data: input.result.data.map((item) => ({
      b64_json: item.b64_json,
      mime_type: item.mime_type ?? mimeTypeForFormat(input.request.outputFormat)
    })),
    ...(input.result.usage ? { usage: input.result.usage } : {})
  };
}

export function parseImageModelMap(value: string | undefined): Record<string, string> {
  if (!value) {
    return { [defaultInternalModel]: defaultUpstreamModel };
  }
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("MEDCODE_IMAGE_MODEL_MAP_JSON must be a JSON object.");
  }
  const result: Record<string, string> = {};
  for (const [key, upstreamModel] of Object.entries(parsed)) {
    if (typeof upstreamModel !== "string" || upstreamModel.length === 0) {
      throw new Error("MEDCODE_IMAGE_MODEL_MAP_JSON values must be non-empty strings.");
    }
    result[key] = upstreamModel;
  }
  return result;
}

export function maxPromptCharsFromEnv(value: string | undefined): number {
  if (!value) {
    return 12_000;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("MEDCODE_IMAGE_MAX_PROMPT_CHARS must be a positive integer.");
  }
  return parsed;
}

export class OpenAIImageGenerationProvider implements ImageGenerationProvider {
  constructor(private readonly options: OpenAIImageGenerationProviderOptions) {}

  async generate(input: {
    request: ImageGenerationRequest;
    upstreamModel: string;
    signal?: AbortSignal;
  }): Promise<ImageGenerationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("upstream_timeout")), this.timeoutMs);
    const abortFromParent = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: input.upstreamModel,
          prompt: input.request.prompt,
          size: input.request.size,
          quality: input.request.quality,
          output_format: input.request.outputFormat
        }),
        signal: controller.signal
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        throw normalizeOpenAIImageError(response.status, payload);
      }
      return parseOpenAIImageResult(payload, input.request.outputFormat);
    } catch (err) {
      if (err instanceof GatewayError) {
        throw err;
      }
      if (controller.signal.aborted) {
        throw new GatewayError({
          code: "upstream_timeout",
          message: "Image generation timed out.",
          httpStatus: 504
        });
      }
      throw new GatewayError({
        code: "upstream_unavailable",
        message: "Image generation service is unavailable.",
        httpStatus: 503
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortFromParent);
    }
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 180_000;
  }
}

function parseMetadata(value: unknown): Record<string, string> | GatewayError {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return imageInvalidRequest("metadata must be a JSON object when provided.");
  }
  const allowed = new Set(["client", "session_id", "message_id", "tool_call_id"]);
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) {
      return imageInvalidRequest(`metadata.${key} is not supported.`);
    }
    if (typeof item !== "string" || item.length > 256) {
      return imageInvalidRequest(`metadata.${key} must be a string up to 256 characters.`);
    }
    metadata[key] = item;
  }
  return metadata;
}

function imageInvalidRequest(message: string): GatewayError {
  return new GatewayError({
    code: "invalid_request",
    message,
    httpStatus: 400
  });
}

function mimeTypeForFormat(format: ImageGenerationOutputFormat): string {
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "webp") {
    return "image/webp";
  }
  return "image/png";
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseOpenAIImageResult(
  payload: unknown,
  outputFormat: ImageGenerationOutputFormat
): ImageGenerationResult {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw upstreamShapeError();
  }
  const data = payload.data.map((item) => {
    if (!isRecord(item) || typeof item.b64_json !== "string" || item.b64_json.length === 0) {
      throw upstreamShapeError();
    }
    return {
      b64_json: item.b64_json,
      mime_type: mimeTypeForFormat(outputFormat)
    };
  });
  if (data.length === 0) {
    throw upstreamShapeError();
  }

  return {
    created: typeof payload.created === "number" ? Math.trunc(payload.created) : undefined,
    data,
    usage: isRecord(payload.usage) ? (payload.usage as ImageGenerationUsage) : undefined
  };
}

function upstreamShapeError(): GatewayError {
  return new GatewayError({
    code: "upstream_unavailable",
    message: "Image generation service returned an unexpected response.",
    httpStatus: 503
  });
}

function normalizeOpenAIImageError(status: number, payload: unknown): GatewayError {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
  const rawCode = typeof error.code === "string" ? error.code : "";
  const rawMessage = typeof error.message === "string" ? error.message : "";
  const normalizedMessage = publicUpstreamErrorMessage(rawMessage);

  if (status === 429) {
    return new GatewayError({
      code: "rate_limited",
      message: normalizedMessage ?? "Image generation rate limit reached.",
      httpStatus: 429,
      retryAfterSeconds: 60,
      upstreamStatus: status
    });
  }
  if (status === 400 && /policy|safety|moderation/i.test(`${rawCode} ${rawMessage}`)) {
    return new GatewayError({
      code: "content_policy_violation",
      message: normalizedMessage ?? "Image generation request was rejected by content policy.",
      httpStatus: 400,
      upstreamStatus: status
    });
  }
  if (status === 400) {
    return new GatewayError({
      code: "invalid_request",
      message: normalizedMessage ?? "Image generation request was invalid.",
      httpStatus: 400,
      upstreamStatus: status
    });
  }
  return new GatewayError({
    code: "upstream_unavailable",
    message: "Image generation service is unavailable.",
    httpStatus: status === 401 || status === 403 ? 503 : Math.max(500, Math.min(status, 599)),
    upstreamStatus: status
  });
}

function publicUpstreamErrorMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}
