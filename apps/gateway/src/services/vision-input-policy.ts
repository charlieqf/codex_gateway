import { GatewayError, type GatewayImageLimitDetails, type MessageImageInput } from "@codex-gateway/core";

export const visionMaximumImagesPerRequest = 8;
export const visionMaximumImageBytes = 20 * 1_024 * 1_024;
export const visionMaximumInlineBytes = 20 * 1_024 * 1_024;
export const visionDefaultRequestBodyBytes = 30 * 1_024 * 1_024;

export function visionInputLimitError(details: GatewayImageLimitDetails): GatewayError {
  const message = details.kind === "image_count"
    ? `本次请求包含 ${details.actual} 张图片，单次最多允许 ${details.maximum} 张。请减少本轮图片或分批分析。`
    : details.kind === "image_bytes"
      ? "单张图片超过大小限制，请缩小图片后重试。"
      : details.kind === "inline_image_bytes"
        ? "本次请求的内联图片合计超过大小限制，请使用图片上传或分批分析。"
        : "本次请求体超过大小限制，请减少本轮图片或使用图片上传后重试。";
  return new GatewayError({
    code: "invalid_request", httpStatus: 413, message,
    imageLimitDetails: details, recoveryOwner: "client", transformedRetryAllowed: true,
    recommendedAction: details.kind === "image_count" ? "reduce_images_or_batch" : "reduce_image_payload"
  });
}

// Validate the complete parsed image list. Never report the ninth entry as a
// complete count, or count repeated URLs only once: the wire entries are the limit.
export function validateVisionInputLimits(images: readonly MessageImageInput[]): GatewayError | null {
  if (images.length > visionMaximumImagesPerRequest) {
    return visionInputLimitError({ kind: "image_count", actual: images.length, maximum: visionMaximumImagesPerRequest });
  }
  const bytes = images.reduce((sum, image) => sum + inlineImageBytes(image.imageUrl), 0);
  return bytes > visionMaximumInlineBytes
    ? visionInputLimitError({ kind: "inline_image_bytes", actual: bytes, maximum: visionMaximumInlineBytes })
    : null;
}

function inlineImageBytes(url: string): number {
  if (!url.toLowerCase().startsWith("data:image/")) return 0;
  const value = url.slice(url.indexOf(",") + 1);
  return Math.floor(value.length * 3 / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
