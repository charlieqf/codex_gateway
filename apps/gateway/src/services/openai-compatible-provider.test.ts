import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  GatewayError,
  type GatewaySession,
  type Subject,
  type UpstreamAccount
} from "@codex-gateway/core";
import {
  collectProviderMessage,
  providerStreamSummaryFromError
} from "./provider-stream.js";
import { OpenAICompatibleProviderAdapter } from "./openai-compatible-provider.js";

describe("OpenAICompatibleProviderAdapter", () => {
  it("sends fixed OpenRouter model config and maps streaming usage", async () => {
    const captured: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = await startSseServer(async (request, body, response) => {
      captured.push({
        headers: request.headers,
        body: JSON.parse(body) as Record<string, unknown>
      });
      response.writeHead(200, {
        "content-type": "text/event-stream"
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "hello" } }]
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: " world" } }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 2,
            total_tokens: 13,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 0 }
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const provider = new OpenAICompatibleProviderAdapter({
        providerKind: "openrouter",
        apiKey: "sk-test-redacted",
        apiKeyEnv: "MEDCODE_OPENROUTER_API_KEY",
        baseUrl: server.baseUrl,
        upstreamModel: "z-ai/glm-5.2",
        reasoning: { effort: "none" },
        siteUrl: "https://example.test",
        appTitle: "MedCode Test",
        timeoutMs: 5_000
      });

      const result = await collectProviderMessage({
        provider,
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "original gateway prompt"
      });

      expect(result).not.toBeInstanceOf(Error);
      expect(result).toMatchObject({
        content: "hello world",
        usage: {
          promptTokens: 11,
          completionTokens: 2,
          totalTokens: 13,
          cachedPromptTokens: 3,
          reasoningTokens: 0
        },
        providerSummary: {
          finishReason: null,
          terminationKind: "done"
        }
      });
      expect(captured).toHaveLength(1);
      expect(captured[0].headers.authorization).toBe("Bearer sk-test-redacted");
      expect(captured[0].headers["http-referer"]).toBe("https://example.test");
      expect(captured[0].headers["x-openrouter-title"]).toBe("MedCode Test");
      expect(captured[0].body).toMatchObject({
        model: "z-ai/glm-5.2",
        stream: true,
        stream_options: { include_usage: true },
        reasoning: { effort: "none" }
      });
      const messages = captured[0].body.messages as Array<{ role: string; content: string }>;
      expect(messages[0]).toMatchObject({ role: "system" });
      expect(messages[0].content).toContain("You are MedCode");
      expect(messages[0].content).toContain("Do not disclose internal upstream providers");
      expect(messages[1]).toEqual({
        role: "user",
        content: "original gateway prompt"
      });
    } finally {
      await server.close();
    }
  });

  it("passes native tools to OpenRouter and maps streaming tool calls", async () => {
    const captured: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = await startSseServer(async (request, body, response) => {
      captured.push({
        headers: request.headers,
        body: JSON.parse(body) as Record<string, unknown>
      });
      response.writeHead(200, {
        "content-type": "text/event-stream"
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_native_1",
                    type: "function",
                    function: { name: "bash", arguments: '{"command"' }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: ':"ls"}' }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 4,
            total_tokens: 24
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const provider = new OpenAICompatibleProviderAdapter({
        providerKind: "openrouter",
        apiKey: "sk-test-redacted",
        apiKeyEnv: "MEDCODE_OPENROUTER_API_KEY",
        baseUrl: server.baseUrl,
        upstreamModel: "z-ai/glm-5.2",
        timeoutMs: 5_000
      });

      const result = await collectProviderMessage({
        provider,
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "create a file",
        clientTools: [
          {
            type: "function",
            function: {
              name: "bash",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
                additionalProperties: false
              }
            }
          }
        ],
        clientToolChoice: "required"
      });

      expect(result).not.toBeInstanceOf(Error);
      expect(result).toMatchObject({
        content: "",
        toolCalls: [
          {
            id: "call_native_1",
            name: "bash",
            arguments: { command: "ls" },
            argumentsJson: '{"command":"ls"}'
          }
        ],
        usage: {
          promptTokens: 20,
          completionTokens: 4,
          totalTokens: 24
        },
        providerSummary: {
          finishReason: "tool_calls",
          terminationKind: "finish_reason_and_done"
        }
      });
      expect(captured).toHaveLength(1);
      expect(captured[0].body).toMatchObject({
        model: "z-ai/glm-5.2",
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "bash"
            }
          }
        ],
        tool_choice: "required"
      });
    } finally {
      await server.close();
    }
  });

  it("classifies an EOF without terminal evidence as an incomplete upstream stream", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-openrouter-request-id": "up_req_incomplete_empty"
      });
      response.end();
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect((result as GatewayError).code).toBe("upstream_incomplete_stream");
      expect((result as GatewayError).httpStatus).toBe(502);
      expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
        finishReason: null,
        upstreamRequestId: "up_req_incomplete_empty",
        upstreamHttpStatus: 200,
        errorCode: "upstream_incomplete_stream",
        contentChars: 0,
        toolCallCount: 0,
        rawResponseChars: 0,
        terminationKind: "eof_before_terminal",
        attempts: [
          expect.objectContaining({
            errorCode: "upstream_incomplete_stream",
            terminationKind: "eof_before_terminal"
          })
        ]
      });
    } finally {
      await server.close();
    }
  });

  it("does not accept partial content followed by an unterminated EOF", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "partial" } }]
        })}\n\n`
      );
      response.end();
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect((result as GatewayError).code).toBe("upstream_incomplete_stream");
      expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
        contentChars: "partial".length,
        toolCallCount: 0,
        terminationKind: "eof_before_terminal"
      });
    } finally {
      await server.close();
    }
  });

  it("classifies a terminal SSE response without semantic output as empty upstream output", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: [DONE]\n\n");
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect((result as GatewayError).code).toBe("upstream_empty_response");
      expect((result as GatewayError).httpStatus).toBe(502);
      expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
        finishReason: null,
        upstreamHttpStatus: 200,
        errorCode: "upstream_empty_response",
        contentChars: 0,
        toolCallCount: 0,
        terminationKind: "done"
      });
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      "reasoning-only output",
      { reasoning_content: "internal reasoning" },
      "stop",
      "internal reasoning".length
    ],
    [
      "tool calls when native tools are disabled",
      {
        tool_calls: [
          {
            index: 0,
            id: "call_not_exposed",
            type: "function",
            function: { name: "ignored", arguments: "{}" }
          }
        ]
      },
      "tool_calls",
      JSON.stringify([
        {
          index: 0,
          id: "call_not_exposed",
          type: "function",
          function: { name: "ignored", arguments: "{}" }
        }
      ]).length
    ]
  ])(
    "accepts legitimate empty visible content from %s",
    async (_description, delta, finishReason, semanticOutputChars) => {
      const server = await startSseServer(
        async (_request, _body, response) => {
          response.writeHead(200, {
            "content-type": "text/event-stream"
          });
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta,
                  finish_reason: finishReason
                }
              ]
            })}\n\n`
          );
          response.end("data: [DONE]\n\n");
        }
      );

      try {
        const result = await collectProviderMessage({
          provider: openAICompatibleProvider(server.baseUrl),
          upstreamAccount: openRouterAccount(),
          subject: testSubject(),
          scope: "code",
          session: testSession(),
          message: "produce a response"
        });

        expect(result).not.toBeInstanceOf(Error);
        expect(result).toMatchObject({
          content: "",
          toolCalls: [],
          providerSummary: {
            finishReason,
            semanticOutputChars,
            terminationKind: "finish_reason_and_done"
          }
        });
      } finally {
        await server.close();
      }
    }
  );

  it("maps refusal deltas to visible assistant content", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { refusal: "I cannot help with that request." },
              finish_reason: "stop"
            }
          ]
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).not.toBeInstanceOf(Error);
      expect(result).toMatchObject({
        content: "I cannot help with that request.",
        providerSummary: {
          finishReason: "stop",
          terminationKind: "finish_reason_and_done"
        }
      });
    } finally {
      await server.close();
    }
  });

  it("maps content-filter completion to a policy error", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "content_filter" }]
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect(result).toMatchObject({
        code: "content_policy_violation",
        httpStatus: 400
      });
    } finally {
      await server.close();
    }
  });

  it("requires the done marker even when the provider sends a finish reason", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "complete" } }]
        })}\n\n`
      );
      response.end(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }]
        })}\n\n`
      );
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect(result).toMatchObject({
        code: "upstream_incomplete_stream",
        httpStatus: 502
      });
      expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
          finishReason: "stop",
          contentChars: "complete".length,
          terminationKind: "eof_before_terminal"
      });
    } finally {
      await server.close();
    }
  });

  it("normalizes an in-band HTTP 200 SSE error frame", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-openrouter-request-id": "up_req_stream_error"
      });
      response.end(
        `data: ${JSON.stringify({
          error: {
            code: 429,
            type: "rate_limit_error",
            message: "Provider rate limit reached."
          }
        })}\n\n`
      );
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "produce a response"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect(result).toMatchObject({
        code: "rate_limited",
        httpStatus: 429
      });
      expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
        upstreamRequestId: "up_req_stream_error",
        upstreamHttpStatus: 200,
        errorCode: "rate_limited",
        terminationKind: "error",
        rawResponseChars: expect.any(Number)
      });
    } finally {
      await server.close();
    }
  });

  it("does not release a native tool call before the done marker", async () => {
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_incomplete",
                    type: "function",
                    function: { name: "bash", arguments: '{"command":"ls"}' }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      );
      response.end(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }]
        })}\n\n`
      );
    });

    try {
      const result = await collectProviderMessage({
        provider: openAICompatibleProvider(server.baseUrl),
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "create a file",
        clientTools: [
          {
            type: "function",
            function: {
              name: "bash",
              parameters: { type: "object" }
            }
          }
        ],
        clientToolChoice: "required"
      });

      expect(result).toBeInstanceOf(GatewayError);
      expect((result as GatewayError).code).toBe("upstream_incomplete_stream");
      expect(providerStreamSummaryFromError(result as GatewayError)).toMatchObject({
        toolCallCount: 0,
        terminationKind: "eof_before_terminal"
      });
    } finally {
      await server.close();
    }
  });

  it("lets request-level reasoning effort override object-style provider reasoning", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "ok" } }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const provider = new OpenAICompatibleProviderAdapter({
        providerKind: "qianfan",
        apiKey: "provider-test-key",
        apiKeyEnv: "MEDCODE_QIANFAN_API_KEY",
        baseUrl: server.baseUrl,
        upstreamModel: "glm-5.2",
        reasoning: { effort: "medium" },
        timeoutMs: 5_000
      });

      await collectProviderMessage({
        provider,
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "prompt",
        reasoningEffort: "high"
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        model: "glm-5.2",
        reasoning: { effort: "high" }
      });
      expect(captured[0]).not.toHaveProperty("reasoning_effort");
    } finally {
      await server.close();
    }
  });

  it("lets request-level reasoning effort override effort-field provider reasoning", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const server = await startSseServer(async (_request, body, response) => {
      captured.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "ok" } }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2
          }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const provider = new OpenAICompatibleProviderAdapter({
        providerKind: "aliyun",
        apiKey: "provider-test-key",
        apiKeyEnv: "MEDCODE_ALIYUN_DASHSCOPE_API_KEY",
        baseUrl: server.baseUrl,
        upstreamModel: "glm-5.2",
        reasoning: { effort: "none" },
        reasoningParameterStyle: "effort_field",
        timeoutMs: 5_000
      });

      await collectProviderMessage({
        provider,
        upstreamAccount: openRouterAccount(),
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "prompt",
        reasoningEffort: "low"
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        model: "glm-5.2",
        reasoning_effort: "low"
      });
      expect(captured[0]).not.toHaveProperty("reasoning");
    } finally {
      await server.close();
    }
  });
});

function openAICompatibleProvider(baseUrl: string): OpenAICompatibleProviderAdapter {
  return new OpenAICompatibleProviderAdapter({
    providerKind: "openrouter",
    apiKey: "sk-test-redacted",
    apiKeyEnv: "MEDCODE_OPENROUTER_API_KEY",
    baseUrl,
    upstreamModel: "z-ai/glm-5.2",
    timeoutMs: 5_000
  });
}

async function startSseServer(
  handler: (
    request: http.IncomingMessage,
    body: string,
    response: http.ServerResponse
  ) => Promise<void> | void
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      void handler(request, body, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function openRouterAccount(): UpstreamAccount {
  return {
    id: "openrouter-main",
    provider: "openrouter",
    label: "OpenRouter Main",
    credentialRef: "ENV:MEDCODE_OPENROUTER_API_KEY",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function testSubject(): Subject {
  return {
    id: "subj_test",
    label: "Test Subject",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z")
  };
}

function testSession(): GatewaySession {
  return {
    id: "sess_test",
    subjectId: "subj_test",
    upstreamAccountId: "openrouter-main",
    publicModelId: null,
    providerSessionRef: null,
    title: null,
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z")
  };
}
