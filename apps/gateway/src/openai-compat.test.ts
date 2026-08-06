import { describe, expect, it } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import {
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
