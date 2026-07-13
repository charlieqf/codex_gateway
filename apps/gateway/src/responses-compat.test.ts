import { describe, expect, it } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import {
  createResponsesFailedEvent,
  createResponsesResult,
  createResponsesStreamStart,
  parseResponsesRequest
} from "./responses-compat.js";

describe("Responses compatibility", () => {
  it("maps Codex message, function tools, and unsupported built-in tools to Chat Completions", () => {
    const parsed = parseResponsesRequest({
      model: "goldencode",
      instructions: "Act as Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace." }]
        }
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          description: "Run a PowerShell command.",
          strict: false,
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"]
          }
        },
        { type: "web_search" },
        { type: "namespace", name: "collaboration" }
      ],
      tool_choice: "auto",
      reasoning: null,
      prompt_cache_key: "codex-thread-1",
      stream: true
    });

    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) {
      return;
    }
    expect(parsed.promptCacheKey).toBe("codex-thread-1");
    expect(parsed.chatRequest).toMatchObject({
      model: "goldencode",
      stream: false,
      messages: [
        { role: "developer", content: "Act as Codex." },
        { role: "user", content: "Inspect the workspace." }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "shell_command",
            description: "Run a PowerShell command."
          }
        }
      ],
      toolChoice: "auto",
      preserveAutoToolChoice: true
    });
  });

  it("maps Codex function-call history back into assistant and tool messages", () => {
    const parsed = parseResponsesRequest({
      model: "goldencode",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run the command." }]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell_command",
          arguments: "{\"command\":\"Get-Location\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "C:\\work\\code"
        }
      ],
      tools: [
        {
          type: "function",
          name: "shell_command",
          parameters: { type: "object" }
        }
      ]
    });

    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) {
      return;
    }
    expect(parsed.chatRequest.messages).toEqual([
      { role: "user", content: "Run the command." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "shell_command",
              arguments: "{\"command\":\"Get-Location\"}"
            }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "C:\\work\\code" }
    ]);
  });

  it("creates the Responses SSE sequence Codex expects for text output", () => {
    const parsed = parseResponsesRequest({
      model: "goldencode",
      input: "Reply with ok.",
      stream: true
    });
    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) {
      return;
    }

    const result = createResponsesResult(
      parsed,
      {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
      },
      new Date("2026-07-13T00:00:00Z")
    );
    expect(result).not.toBeInstanceOf(GatewayError);
    if (result instanceof GatewayError) {
      return;
    }

    expect(result.events.map((item) => item.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed"
    ]);
    expect(result.response).toMatchObject({
      object: "response",
      status: "completed",
      model: "goldencode",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok", annotations: [] }]
        }
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 1,
        total_tokens: 5
      }
    });
  });

  it("creates function-call events with the original call id and arguments", () => {
    const parsed = parseResponsesRequest({
      model: "goldencode",
      input: "Run a command.",
      tools: [
        {
          type: "function",
          name: "shell_command",
          parameters: { type: "object" }
        }
      ],
      stream: true
    });
    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) {
      return;
    }

    const result = createResponsesResult(parsed, {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_gateway_1",
                type: "function",
                function: {
                  name: "shell_command",
                  arguments: "{\"command\":\"Get-Location\"}"
                }
              }
            ]
          }
        }
      ]
    });
    expect(result).not.toBeInstanceOf(GatewayError);
    if (result instanceof GatewayError) {
      return;
    }

    expect(result.events.map((item) => item.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed"
    ]);
    expect(result.response.output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "call_gateway_1",
        name: "shell_command",
        arguments: "{\"command\":\"Get-Location\"}"
      })
    ]);
  });

  it("rejects models other than GoldenCode on the public Responses route", () => {
    const parsed = parseResponsesRequest({ model: "max", input: "hello" });
    expect(parsed).toBeInstanceOf(GatewayError);
    expect((parsed as GatewayError).message).toContain("model=goldencode");
  });

  it("rejects stateful Responses parameters instead of silently ignoring them", () => {
    for (const request of [
      { model: "goldencode", input: "hello", store: true },
      {
        model: "goldencode",
        input: "hello",
        previous_response_id: "resp_previous"
      }
    ]) {
      const parsed = parseResponsesRequest(request);
      expect(parsed).toBeInstanceOf(GatewayError);
      expect((parsed as GatewayError).code).toBe("unsupported_parameter");
    }

    const accepted = parseResponsesRequest({
      model: "goldencode",
      input: "hello",
      store: false,
      tools: [{ type: "web_search" }]
    });
    expect(accepted).not.toBeInstanceOf(GatewayError);
    if (!(accepted instanceof GatewayError)) {
      expect(accepted.chatRequest.tools).toBeUndefined();
    }
  });

  it("preserves visible attachment placeholders and mixed assistant tool history", () => {
    const parsed = parseResponsesRequest({
      model: "goldencode",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Review these:" },
            { type: "input_image", image_url: "data:image/png;base64,ignored" },
            { type: "input_file", file_id: "file_ignored" }
          ]
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will inspect it." }]
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "shell_command",
          arguments: "{}"
        }
      ]
    });

    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) {
      return;
    }
    expect(parsed.chatRequest.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Image attachment omitted")
    });
    expect(parsed.chatRequest.messages[0]).toMatchObject({
      content: expect.stringContaining("File attachment omitted")
    });
    expect(parsed.chatRequest.messages[1]).toEqual({
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [
        {
          id: "call_2",
          type: "function",
          function: { name: "shell_command", arguments: "{}" }
        }
      ]
    });
  });

  it("emits text before function calls and reuses the early stream response id", () => {
    const parsed = parseResponsesRequest({
      model: "goldencode",
      input: "Inspect it.",
      stream: true
    });
    expect(parsed).not.toBeInstanceOf(GatewayError);
    if (parsed instanceof GatewayError) {
      return;
    }
    const start = createResponsesStreamStart(parsed, new Date("2026-07-13T00:00:00Z"));
    const result = createResponsesResult(
      parsed,
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I found one issue.",
              tool_calls: [
                {
                  id: "call_3",
                  type: "function",
                  function: { name: "shell_command", arguments: "{}" }
                }
              ]
            }
          }
        ]
      },
      new Date("2026-07-13T00:00:02Z"),
      start.state
    );
    expect(result).not.toBeInstanceOf(GatewayError);
    if (result instanceof GatewayError) {
      return;
    }
    expect(result.response.id).toBe(start.state.responseId);
    expect(result.response.output).toEqual([
      expect.objectContaining({ type: "message" }),
      expect.objectContaining({ type: "function_call", call_id: "call_3" })
    ]);
    expect(result.events.map((item) => item.event)).not.toContain("response.created");

    const failed = createResponsesFailedEvent(
      parsed,
      start.state,
      new GatewayError({
        code: "upstream_timeout",
        message: "timed out",
        httpStatus: 504
      }),
      new Date("2026-07-13T00:00:03Z")
    );
    expect(failed).toMatchObject({
      event: "response.failed",
      data: {
        response: {
          id: start.state.responseId,
          status: "failed",
          error: { code: "upstream_timeout" }
        }
      }
    });
  });
});
