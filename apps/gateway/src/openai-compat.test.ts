import { describe, expect, it } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import {
  chatMessagesToPrompt,
  parseChatCompletionRequest,
  parseStrictToolDecision,
  type OpenAIChatToolDefinition
} from "./openai-compat.js";

const readTool: OpenAIChatToolDefinition = {
  type: "function",
  function: {
    name: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
};

describe("multimodal chat compatibility", () => {
  it("extracts PNG/JPEG images without copying base64 data into the text prompt", () => {
    const encoded = "aGVsbG8=";
    const parsed = parseChatCompletionRequest(
      {
        model: "goldencode",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this chart." },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${encoded}`,
                  detail: "high"
                }
              }
            ]
          }
        ]
      },
      "goldencode"
    );

    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) return;
    expect(parsed.images).toEqual([
      {
        imageUrl: `data:image/png;base64,${encoded}`,
        detail: "high"
      }
    ]);
    const prompt = chatMessagesToPrompt(parsed);
    expect(prompt).toContain("Describe this chart.");
    expect(prompt).toContain("Image attachment provided separately");
    expect(prompt).not.toContain(encoded);
  });

  it("rejects unsupported image formats and excessive image counts", () => {
    const unsupported = parseChatCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/webp;base64,aGVsbG8=" }
              }
            ]
          }
        ]
      },
      "goldencode"
    );
    expect(unsupported).toBeInstanceOf(GatewayError);
    expect((unsupported as GatewayError).httpStatus).toBe(400);

    const excessive = parseChatCompletionRequest(
      {
        messages: [
          {
            role: "user",
            content: Array.from({ length: 9 }, () => ({
              type: "image_url",
              image_url: { url: "https://images.example.test/chart.png" }
            }))
          }
        ]
      },
      "goldencode"
    );
    expect(excessive).toBeInstanceOf(GatewayError);
    expect((excessive as GatewayError).httpStatus).toBe(413);
  });
});

describe("parseStrictToolDecision validation subtypes", () => {
  it.each([
    {
      name: "invalid JSON",
      text: '{"type":"tool_calls","tool_calls":',
      toolChoice: "required" as const,
      failureKind: "invalid_json"
    },
    {
      name: "schema mismatch",
      text: JSON.stringify({
        type: "tool_calls",
        tool_calls: [{ name: "read", arguments: { path: 123 } }]
      }),
      toolChoice: "required" as const,
      failureKind: "schema_mismatch"
    },
    {
      name: "undeclared tool",
      text: JSON.stringify({
        type: "tool_calls",
        tool_calls: [{ name: "shell", arguments: { command: "dir" } }]
      }),
      toolChoice: "required" as const,
      failureKind: "undeclared_tool"
    },
    {
      name: "tool choice mismatch",
      text: JSON.stringify({ type: "message", content: "no tool" }),
      toolChoice: "required" as const,
      failureKind: "tool_choice_mismatch"
    }
  ])("classifies $name", ({ text, toolChoice, failureKind }) => {
    const result = parseStrictToolDecision({
      text,
      tools: [readTool],
      toolChoice,
      createToolCallId: () => "call_test"
    });

    expect(result).toBeInstanceOf(GatewayError);
    expect(result).toMatchObject({
      code: "tool_call_validation_failed",
      contractVersion: 1,
      failureKind,
      transformedRetryAllowed: true,
      recoveryOwner: "client"
    });
  });

  it("accepts a schema-valid read under required tool choice", () => {
    const result = parseStrictToolDecision({
      text: JSON.stringify({
        type: "tool_calls",
        tool_calls: [{ name: "read", arguments: { path: "notes.md" } }]
      }),
      tools: [readTool],
      toolChoice: "required",
      createToolCallId: () => "call_read"
    });

    expect(result).not.toBeInstanceOf(GatewayError);
    expect(result).toMatchObject({
      type: "tool_calls",
      toolCalls: [
        {
          id: "call_read",
          function: {
            name: "read",
            arguments: '{"path":"notes.md"}'
          }
        }
      ]
    });
  });
});
