import { randomUUID } from "node:crypto";
import { GatewayError, isRecord, type FeaturePolicy } from "@codex-gateway/core";
import sharp from "sharp";

const supportedSizes = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
const supportedFormats = ["png", "jpeg", "webp"] as const;
const supportedQualities = ["low", "medium", "high", "auto"] as const;
const defaultInternalModel = "medcode-image-default";
const defaultUpstreamModel = "gpt-image-2";
const defaultImageSize = "1024x1024";
const defaultImageQuality = "low";
const defaultOutputFormat = "jpeg";
const supportedTargetSizes = ["1024x1024", "1080x1080", "1024x1536", "1536x1024"] as const;

export type ImageGenerationSize = (typeof supportedSizes)[number];
export type ImageGenerationOutputFormat = (typeof supportedFormats)[number];
export type ImageGenerationQuality = (typeof supportedQualities)[number];
export type ImageGenerationTargetSize = (typeof supportedTargetSizes)[number];

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  size: ImageGenerationSize;
  outputSize: ImageGenerationTargetSize;
  quality: ImageGenerationQuality;
  outputFormat: ImageGenerationOutputFormat;
  outputCompression?: number;
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

export interface XAIImageGenerationProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  resolution?: "1k" | "2k";
}

export interface GeminiImageGenerationProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  imageSize?: "512" | "1K" | "2K" | "4K";
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

  const parsedSize = parseImageSize(body.size, body.prompt);
  if (parsedSize instanceof GatewayError) {
    return parsedSize;
  }

  const quality = body.quality === undefined || body.quality === "auto" ? defaultImageQuality : body.quality;
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

  const imageOutputFormat = outputFormat as ImageGenerationOutputFormat;
  const outputCompression = parseOutputCompression(body.output_compression, imageOutputFormat);
  if (outputCompression instanceof GatewayError) {
    return outputCompression;
  }

  const metadata = parseMetadata(body.metadata);
  if (metadata instanceof GatewayError) {
    return metadata;
  }

  return {
    prompt: body.prompt,
    model,
    size: parsedSize.upstreamSize,
    outputSize: parsedSize.outputSize,
    quality: quality as ImageGenerationQuality,
    outputFormat: imageOutputFormat,
    ...(outputCompression === undefined ? {} : { outputCompression }),
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
  if (!isImageQualityAllowed(imagePolicy.allowedQualities, request.quality)) {
    return new GatewayError({
      code: "unsupported_quality",
      message: `Unsupported image quality: ${request.quality}.`,
      httpStatus: 400
    });
  }
  if (!isImageFormatAllowed(imagePolicy.allowedFormats, request.outputFormat)) {
    return new GatewayError({
      code: "unsupported_format",
      message: `Unsupported image output_format: ${request.outputFormat}.`,
      httpStatus: 400
    });
  }
  return modelMap[request.model] ?? defaultUpstreamModel;
}

export function isImageBillingLimitError(error: GatewayError): boolean {
  return (
    error.upstreamStatus !== undefined &&
    (error.code === "invalid_request" || error.code === "upstream_unavailable") &&
    isBillingLimitText(error.message)
  );
}

function isImageQualityAllowed(allowed: string[], quality: ImageGenerationQuality): boolean {
  return allowed.includes(quality) || (quality === defaultImageQuality && allowed.includes("auto"));
}

function isImageFormatAllowed(
  allowed: string[],
  outputFormat: ImageGenerationOutputFormat
): boolean {
  return allowed.includes(outputFormat) || (outputFormat === defaultOutputFormat && allowed.includes("png"));
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

export async function finalizeImageGenerationResult(input: {
  request: ImageGenerationRequest;
  result: ImageGenerationResult;
}): Promise<ImageGenerationResult> {
  const hasSvgOutput = input.result.data.some((item) => item.mime_type?.startsWith("image/svg+xml"));
  if (input.request.outputSize === input.request.size && !hasSvgOutput) {
    return input.result;
  }

  const { width, height } = sizeDimensions(input.request.outputSize);
  const data = await Promise.all(
    input.result.data.map(async (item) => {
      try {
        const resized = await encodeRasterImage({
          source: Buffer.from(item.b64_json, "base64"),
          width,
          height,
          format: input.request.outputFormat,
          outputCompression: input.request.outputCompression
        });
        return {
          b64_json: resized.toString("base64"),
          mime_type: mimeTypeForFormat(input.request.outputFormat)
        };
      } catch {
        throw upstreamShapeError();
      }
    })
  );

  return {
    ...input.result,
    data
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
          output_format: input.request.outputFormat,
          ...(input.request.outputCompression === undefined
            ? {}
            : { output_compression: input.request.outputCompression })
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
        if (isClientAbortReason(controller.signal.reason)) {
          throw new GatewayError({
            code: "client_aborted",
            message: "Client aborted image generation.",
            httpStatus: 499
          });
        }
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

export class XAIImageGenerationProvider implements ImageGenerationProvider {
  constructor(private readonly options: XAIImageGenerationProviderOptions) {}

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
          response_format: "b64_json",
          aspect_ratio: aspectRatioForSize(input.request.size),
          resolution: this.options.resolution ?? "1k"
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
        if (isClientAbortReason(controller.signal.reason)) {
          throw new GatewayError({
            code: "client_aborted",
            message: "Client aborted image generation.",
            httpStatus: 499
          });
        }
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
    return (this.options.baseUrl ?? "https://api.x.ai").replace(/\/+$/, "");
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 180_000;
  }
}

export class GeminiImageGenerationProvider implements ImageGenerationProvider {
  constructor(private readonly options: GeminiImageGenerationProviderOptions) {}

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
      const response = await fetch(`${this.baseUrl}/interactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.options.apiKey
        },
        body: JSON.stringify({
          model: input.upstreamModel,
          input: [
            {
              type: "text",
              text: input.request.prompt
            }
          ],
          response_format: {
            type: "image",
            mime_type: mimeTypeForFormat(input.request.outputFormat),
            aspect_ratio: aspectRatioForSize(input.request.size),
            image_size: this.options.imageSize ?? "1K"
          }
        }),
        signal: controller.signal
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        throw normalizeOpenAIImageError(response.status, payload);
      }
      return parseGeminiImageResult(payload, input.request.outputFormat);
    } catch (err) {
      if (err instanceof GatewayError) {
        throw err;
      }
      if (controller.signal.aborted) {
        if (isClientAbortReason(controller.signal.reason)) {
          throw new GatewayError({
            code: "client_aborted",
            message: "Client aborted image generation.",
            httpStatus: 499
          });
        }
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
    return (this.options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/+$/,
      ""
    );
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 180_000;
  }
}

function isClientAbortReason(reason: unknown): boolean {
  return reason instanceof Error && reason.message === "client_aborted";
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

function parseImageSize(
  value: unknown,
  prompt: string
): { upstreamSize: ImageGenerationSize; outputSize: ImageGenerationTargetSize } | GatewayError {
  const promptWants1080 = promptRequests1080Square(prompt);
  if (value === undefined || value === "auto") {
    return {
      upstreamSize: defaultImageSize,
      outputSize: promptWants1080 ? "1080x1080" : defaultImageSize
    };
  }
  const normalized = typeof value === "string" ? normalizeSizeText(value) : String(value);
  if (normalized === "auto") {
    return {
      upstreamSize: defaultImageSize,
      outputSize: promptWants1080 ? "1080x1080" : defaultImageSize
    };
  }
  if (normalized === "1080x1080") {
    return {
      upstreamSize: defaultImageSize,
      outputSize: "1080x1080"
    };
  }
  if (!supportedSizes.includes(normalized as ImageGenerationSize)) {
    return new GatewayError({
      code: "unsupported_size",
      message: `Unsupported image size: ${String(value)}.`,
      httpStatus: 400
    });
  }
  return {
    upstreamSize: normalized as ImageGenerationSize,
    outputSize:
      promptWants1080 && normalized === defaultImageSize ? "1080x1080" : (normalized as ImageGenerationTargetSize)
  };
}

function normalizeSizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s*[x×*]\s*/u, "x");
}

function promptRequests1080Square(prompt: string): boolean {
  return /1080\s*(?:x|×|\*)\s*1080/iu.test(prompt) || /1080\s*(?:px|像素)?\s*(?:方图|正方形|square)/iu.test(prompt);
}

function parseOutputCompression(
  value: unknown,
  outputFormat: ImageGenerationOutputFormat
): number | undefined | GatewayError {
  if (value === undefined) {
    return undefined;
  }
  if (outputFormat === "png") {
    return imageInvalidRequest("output_compression is only supported for jpeg and webp output.");
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    return imageInvalidRequest("output_compression must be an integer from 0 to 100.");
  }
  return value;
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

function aspectRatioForSize(size: ImageGenerationSize): string {
  if (size === "1024x1536") {
    return "2:3";
  }
  if (size === "1536x1024") {
    return "3:2";
  }
  if (size === "auto") {
    return "auto";
  }
  return "1:1";
}

function sizeDimensions(size: ImageGenerationTargetSize): { width: number; height: number } {
  const [width, height] = size.split("x").map((part) => Number.parseInt(part, 10));
  return { width, height };
}

async function encodeRasterImage(input: {
  source: Buffer;
  width: number;
  height: number;
  format: ImageGenerationOutputFormat;
  outputCompression?: number;
}): Promise<Buffer> {
  const image = sharp(input.source).resize(input.width, input.height, {
    fit: "fill",
    kernel: "lanczos3"
  });
  const quality = qualityFromCompression(input.outputCompression);
  if (input.format === "jpeg") {
    return image.jpeg({ ...(quality === undefined ? {} : { quality }) }).toBuffer();
  }
  if (input.format === "webp") {
    return image.webp({ ...(quality === undefined ? {} : { quality }) }).toBuffer();
  }
  return image.png().toBuffer();
}

function qualityFromCompression(outputCompression: number | undefined): number | undefined {
  if (outputCompression === undefined) {
    return undefined;
  }
  return Math.min(100, Math.max(1, 100 - outputCompression));
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

function parseGeminiImageResult(
  payload: unknown,
  outputFormat: ImageGenerationOutputFormat
): ImageGenerationResult {
  if (!isRecord(payload)) {
    throw upstreamShapeError();
  }

  const directImage =
    imageDataFromGeminiBlock(payload.output_image, outputFormat) ??
    imageDataFromGeminiBlock(payload.outputImage, outputFormat);
  if (directImage) {
    return {
      data: [directImage]
    };
  }

  const data: ImageGenerationResult["data"] = [];
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) {
      continue;
    }
    const parts = Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      const image =
        imageDataFromGeminiBlock(part.inlineData, outputFormat) ??
        imageDataFromGeminiBlock(part.inline_data, outputFormat);
      if (image) {
        data.push(image);
      }
    }
  }
  if (data.length === 0) {
    throw upstreamShapeError();
  }
  return { data };
}

function imageDataFromGeminiBlock(
  value: unknown,
  outputFormat: ImageGenerationOutputFormat
): ImageGenerationResult["data"][number] | null {
  if (!isRecord(value) || typeof value.data !== "string" || value.data.length === 0) {
    return null;
  }
  const mimeType =
    typeof value.mime_type === "string"
      ? value.mime_type
      : typeof value.mimeType === "string"
        ? value.mimeType
        : mimeTypeForFormat(outputFormat);
  return {
    b64_json: value.data,
    mime_type: mimeType
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
  const rawStatus = typeof error.status === "string" ? error.status : "";
  const rawMessage = typeof error.message === "string" ? error.message : "";
  const normalizedMessage = publicUpstreamErrorMessage(rawMessage);
  const billingText = `${rawCode} ${rawStatus} ${rawMessage}`;

  if ((status === 400 || status === 402 || status === 403 || status === 429) && isBillingLimitText(billingText)) {
    return new GatewayError({
      code: "upstream_unavailable",
      message: normalizedMessage ?? "Image generation billing limit reached.",
      httpStatus: 503,
      upstreamStatus: status
    });
  }
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

function isBillingLimitText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("billing hard limit") ||
    lower.includes("hard limit has been reached") ||
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient quota") ||
    lower.includes("quota exceeded") ||
    (lower.includes("resource_exhausted") && lower.includes("quota")) ||
    (lower.includes("billing") && lower.includes("limit"))
  );
}
