import { describe, expect, it } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import { parseChatCompletionRequest, openAIErrorPayload } from "../openai-compat.js";
import { parseResponsesRequest } from "../responses-compat.js";
import { visionMaximumImageBytes, validateVisionInputLimits } from "./vision-input-policy.js";

describe("complete wire image limits", () => {
  it.each(["chat", "responses"])("reports all 12 repeated image entries in %s including tool output", (dialect) => {
    const url = "https://images.example.test/chart.png";
    const parsed = dialect === "chat"
      ? parseChatCompletionRequest({ model: "goldencode", messages: [
          { role: "user", content: Array.from({ length: 8 }, () => ({ type: "image_url", image_url: { url } })) },
          { role: "tool", tool_call_id: "call_image", content: Array.from({ length: 4 }, () => ({ type: "image_url", image_url: { url } })) }
        ] }, "goldencode")
      : parseResponsesRequest({ model: "goldencode", input: [
          { type: "message", role: "user", content: Array.from({ length: 8 }, () => ({ type: "input_image", image_url: url })) },
          { type: "function_call_output", call_id: "call_image", output: Array.from({ length: 4 }, () => ({ type: "input_image", image_url: url })) }
        ] });
    expect(parsed).toBeInstanceOf(GatewayError);
    expect(parsed).toMatchObject({ code: "invalid_request", httpStatus: 413,
      imageLimitDetails: { kind: "image_count", actual: 12, maximum: 8 } });
    expect(openAIErrorPayload(parsed as GatewayError, { requestId: "req-images" })).toMatchObject({ error: {
      code: "invalid_request", request_id: "req-images", image_limit_contract_version: 1,
      image_limit: { kind: "image_count", actual: 12, maximum: 8 }, recovery_owner: "client",
      recommended_action: "reduce_images_or_batch", transformed_retry_allowed: true
    } });
  });

  it("distinguishes a single large image from the total inline payload", () => {
    const over = Buffer.alloc(visionMaximumImageBytes + 1).toString("base64");
    const single = parseChatCompletionRequest({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${over}` } }
    ] }] }, "goldencode");
    expect(single).toMatchObject({ imageLimitDetails: { kind: "image_bytes", actual: visionMaximumImageBytes + 1 } });
    const half = `data:image/png;base64,${Buffer.alloc(visionMaximumImageBytes / 2 + 1).toString("base64")}`;
    expect(validateVisionInputLimits([{ imageUrl: half }, { imageUrl: half }])).toMatchObject({
      imageLimitDetails: { kind: "inline_image_bytes", actual: visionMaximumImageBytes + 2 }
    });
  });

  it("keeps eight images valid and leaves their order and references intact", () => {
    const images = Array.from({ length: 8 }, (_, i) => ({ imageUrl: `https://images.example.test/${i}.png` }));
    const before = structuredClone(images);
    expect(validateVisionInputLimits(images)).toBeNull();
    expect(images).toEqual(before);
  });
});
