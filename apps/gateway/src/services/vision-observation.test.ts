import { GatewayError } from "@codex-gateway/core";
import { describe, expect, it } from "vitest";
import { parseChatCompletionRequest } from "../openai-compat.js";
import { parseResponsesRequest } from "../responses-compat.js";
import { beginVisionObservation, visionObservationSnapshot } from "./vision-observation.js";

const png = "data:image/png;base64,aGVsbG8=";
const other = "data:image/png;base64,d29ybGQ=";

function image(url: string, detail?: "auto" | "low" | "high") {
  return { type: "image_url", image_url: { url, ...(detail ? { detail } : {}) } };
}

function observeChat(body: unknown) {
  const observation = beginVisionObservation();
  const parsed = parseChatCompletionRequest(body, "goldencode", observation);
  return { parsed, snapshot: visionObservationSnapshot(observation) };
}

function observeResponses(body: unknown) {
  const observation = beginVisionObservation();
  const parsed = parseResponsesRequest(body, undefined, observation);
  return { parsed, snapshot: visionObservationSnapshot(observation) };
}

describe("vision observation on the chat completions entry", () => {
  it("splits history images from the last user message", () => {
    const { parsed, snapshot } = observeChat({
      model: "goldencode",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }, image(png)] },
        { role: "assistant", content: [{ type: "text", text: "ok" }, image(other)] },
        { role: "user", content: [{ type: "text", text: "follow up, no image" }] }
      ]
    });

    expect(parsed).not.toBeInstanceOf(GatewayError);
    expect(snapshot).toMatchObject({
      completeness: "complete",
      wireImageCount: 2,
      imagesInLastUserMessage: 0,
      imagesOutsideLastUserMessage: 2,
      lastUserMessagePresent: true
    });
  });

  it("counts a synthetic tool-media carrier as inside, since it is the last user message", () => {
    // OpenAI-compatible clients hoist tool-result media into a trailing user
    // message, so `inside` is a wire position, never "the user just uploaded".
    const { snapshot } = observeChat({
      model: "goldencode",
      messages: [
        { role: "user", content: [{ type: "text", text: "analyse" }, image(png)] },
        { role: "assistant", content: null },
        {
          role: "user",
          content: [{ type: "text", text: "Attached media from tool result:" }, image(other)]
        }
      ]
    });

    expect(snapshot).toMatchObject({
      wireImageCount: 2,
      imagesInLastUserMessage: 1,
      imagesOutsideLastUserMessage: 1
    });
  });

  it("reports no user carrier when every image sits outside one", () => {
    const { snapshot } = observeChat({
      model: "goldencode",
      messages: [{ role: "assistant", content: [image(png)] }]
    });

    expect(snapshot).toMatchObject({
      completeness: "complete",
      wireImageCount: 1,
      imagesInLastUserMessage: 0,
      imagesOutsideLastUserMessage: 1,
      lastUserMessagePresent: false
    });
  });

  it("records an exact zero only after a complete scan", () => {
    const { snapshot } = observeChat({
      model: "goldencode",
      messages: [{ role: "user", content: "text only" }]
    });

    expect(snapshot).toMatchObject({
      completeness: "complete",
      wireImageCount: 0,
      imagesInLastUserMessage: 0,
      imagesOutsideLastUserMessage: 0
    });
  });

  it("reports unavailable rather than zero when the body never reached scanning", () => {
    for (const body of [null, "nope", {}, { model: "goldencode", messages: [] }]) {
      const { parsed, snapshot } = observeChat(body);
      expect(parsed).toBeInstanceOf(GatewayError);
      expect(snapshot).toMatchObject({
        completeness: "unavailable",
        scannedImageCount: 0,
        wireImageCount: null,
        lastUserMessagePresent: null,
        detailCounts: null
      });
    }
  });

  it("reports partial for a malformed container wherever it sits in the list", () => {
    // The same class of rejection must not read as `unavailable` at index 0 and
    // `partial` at index 1, so the scan is marked on entry, not per valid message.
    for (const messages of [
      [{}],
      [{ role: "user", content: [image(png)] }, {}]
    ]) {
      const { parsed, snapshot } = observeChat({ model: "goldencode", messages });
      expect(parsed).toBeInstanceOf(GatewayError);
      expect(snapshot.completeness).toBe("partial");
      expect(snapshot.wireImageCount).toBeNull();
    }
  });

  it("reports partial with the scanned count when a rejection stops the scan", () => {
    const { parsed, snapshot } = observeChat({
      model: "goldencode",
      messages: [
        { role: "user", content: [image(png)] },
        { role: "user", content: [{ type: "image_url", image_url: { url: "ftp://nope" } }] }
      ]
    });

    expect(parsed).toBeInstanceOf(GatewayError);
    expect(snapshot).toMatchObject({
      completeness: "partial",
      scannedImageCount: 1,
      wireImageCount: null,
      imagesOutsideLastUserMessage: null
    });
  });

  it("keeps the complete snapshot when admission rejects on image count", () => {
    const { parsed, snapshot } = observeChat({
      model: "goldencode",
      messages: [
        { role: "user", content: Array.from({ length: 12 }, () => image(png)) }
      ]
    });

    expect(parsed).toBeInstanceOf(GatewayError);
    expect((parsed as GatewayError).httpStatus).toBe(413);
    expect((parsed as GatewayError).imageLimitDetails).toMatchObject({
      kind: "image_count",
      actual: 12
    });
    expect(snapshot).toMatchObject({
      completeness: "complete",
      wireImageCount: 12,
      imagesInLastUserMessage: 12,
      duplicateWireEntryCount: 11
    });
  });

  it("counts duplicates by wire entry and tallies detail", () => {
    const { snapshot } = observeChat({
      model: "goldencode",
      messages: [
        {
          role: "user",
          content: [image(png, "high"), image(png, "high"), image(png, "low"), image(other)]
        }
      ]
    });

    expect(snapshot).toMatchObject({
      wireImageCount: 4,
      // Same url at a different detail is a distinct presentation, so only one pair collides.
      duplicateWireEntryCount: 1,
      detailCounts: { high: 2, low: 1, auto: 0, unspecified: 1 }
    });
  });
});

describe("vision observation on the responses entry", () => {
  it("counts function_call_output images as outside the last user item", () => {
    const { parsed, snapshot } = observeResponses({
      model: "goldencode",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: png }]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "view_images",
          arguments: "{}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: other }]
        }
      ]
    });

    expect(parsed).not.toBeInstanceOf(GatewayError);
    expect(snapshot).toMatchObject({
      completeness: "complete",
      wireImageCount: 2,
      imagesInLastUserMessage: 1,
      imagesOutsideLastUserMessage: 1,
      lastUserMessagePresent: true
    });
  });

  it("reports unavailable when the input never parsed", () => {
    const { parsed, snapshot } = observeResponses({ model: "goldencode", input: 7 });
    expect(parsed).toBeInstanceOf(GatewayError);
    expect(snapshot).toMatchObject({ completeness: "unavailable", wireImageCount: null });
  });
});
