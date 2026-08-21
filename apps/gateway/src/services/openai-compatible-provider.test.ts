import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  GatewayError,
  type GatewaySession,
  type MessageInput,
  type ProviderErrorDiagnostic,
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
        message: "original gateway prompt",
        maximumOutputTokens: 8_000
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
        max_tokens: 8_000,
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

  it("sends image inputs to xAI as multimodal content with server storage disabled", async () => {
    const captured: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = await startSseServer(async (request, body, response) => {
      captured.push({
        headers: request.headers,
        body: JSON.parse(body) as Record<string, unknown>
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "red, blue, green" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });

    try {
      const provider = new OpenAICompatibleProviderAdapter({
        providerKind: "xai",
        apiKey: "xai-test-redacted",
        apiKeyEnv: "MEDCODE_VISION_XAI_API_KEY",
        baseUrl: server.baseUrl,
        upstreamModel: "grok-4.5",
        reasoning: { effort: "medium" },
        reasoningParameterStyle: "effort_field",
        timeoutMs: 5_000
      });
      const result = await collectProviderMessage({
        provider,
        upstreamAccount: {
          ...openRouterAccount(),
          id: "xai-vision-main",
          provider: "xai"
        },
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "Describe the chart.",
        images: [
          {
            imageUrl: "data:image/png;base64,aGVsbG8=",
            detail: "high"
          }
        ]
      });

      expect(result).not.toBeInstanceOf(Error);
      expect(result).toMatchObject({ content: "red, blue, green" });
      expect(captured).toHaveLength(1);
      expect(captured[0].body).toMatchObject({
        model: "grok-4.5",
        store: false,
        reasoning_effort: "medium"
      });
      const messages = captured[0].body.messages as Array<{
        role: string;
        content: unknown;
      }>;
      expect(messages[1]).toEqual({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,aGVsbG8=",
              detail: "high"
            }
          },
          { type: "text", text: "Describe the chart." }
        ]
      });
    } finally {
      await server.close();
    }
  });

  it("redacts R2 presigned URL credentials from upstream diagnostics", async () => {
    const diagnostics: ProviderErrorDiagnostic[] = [];
    const server = await startSseServer(async (_request, _body, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error:
            "invalid image https://account.example.com/object?X-Amz-Credential=access-id%2Fscope&X-Amz-Signature=bearer-signature"
        })
      );
    });

    try {
      const provider = new OpenAICompatibleProviderAdapter({
        providerKind: "xai",
        apiKey: "xai-test-redacted",
        apiKeyEnv: "MEDCODE_VISION_XAI_API_KEY",
        baseUrl: server.baseUrl,
        upstreamModel: "grok-4.5",
        timeoutMs: 5_000
      });
      await collectProviderMessage({
        provider,
        upstreamAccount: {
          ...openRouterAccount(),
          id: "xai-vision-main",
          provider: "xai"
        },
        subject: testSubject(),
        scope: "code",
        session: testSession(),
        message: "Describe the image.",
        onProviderError: (diagnostic) => diagnostics.push(diagnostic)
      });

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].rawMessage).toContain(
        "X-Amz-Credential=<redacted>"
      );
      expect(diagnostics[0].rawMessage).toContain(
        "X-Amz-Signature=<redacted>"
      );
      expect(diagnostics[0].rawMessage).not.toContain("access-id");
      expect(diagnostics[0].rawMessage).not.toContain("bearer-signature");
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

  it.each([
    ["ENOTFOUND", "network", "dns"],
    ["ECONNREFUSED", "network", "connect"],
    ["ECONNRESET", "network", "connection_reset"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "network", "tls"],
    ["ERR_HTTP_PROXY_CONNECT", "proxy", "proxy_connect"]
  ] as const)(
    "classifies nested fetch cause %s without changing the public error",
    async (code, origin, kind) => {
      const nested = Object.assign(new Error("transport detail must stay internal"), { code });
      const fetchError = new TypeError("fetch failed", { cause: nested });
      const events = await providerEvents(async () => Promise.reject(fetchError));

      expect(events).toMatchObject([
        {
          type: "error",
          code: "upstream_unavailable",
          message: "MedCode service is temporarily unavailable.",
          providerFailure: {
            origin,
            kind,
            stage: "before_headers",
            transportCode: code,
            upstreamStatus: null
          }
        }
      ]);
      expect(JSON.stringify(events)).not.toContain("transport detail");
    }
  );

  it.each([
    [400, "http_request", "invalid_request"],
    [401, "http_auth", "upstream_unavailable"],
    [403, "http_auth", "upstream_unavailable"],
    [408, "http_timeout", "upstream_timeout"],
    [429, "http_rate_limit", "rate_limited"],
    [500, "http_server", "upstream_unavailable"],
    [503, "http_server", "upstream_unavailable"],
    [504, "http_timeout", "upstream_timeout"]
  ] as const)("classifies HTTP %i as %s", async (status, kind, publicCode) => {
    const events = await providerEvents(async () =>
      new Response('{"error":"sanitized by adapter"}', { status })
    );

    expect(events[0]).toMatchObject({
      type: "error",
      code: publicCode,
      providerFailure: {
        origin: "provider",
        kind,
        stage: "after_headers",
        upstreamStatus: status
      }
    });
  });

  it("distinguishes missing bodies, malformed SSE, and interrupted streams", async () => {
    const missing = await providerEvents(async () => new Response(null, { status: 200 }));
    expect(missing[0]).toMatchObject({
      code: "upstream_unavailable",
      providerFailure: {
        origin: "provider",
        kind: "response_body_missing",
        stage: "after_headers"
      }
    });

    const malformed = await providerEvents(async () =>
      new Response("data: {not-json}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    expect(malformed[0]).toMatchObject({
      code: "upstream_unavailable",
      providerFailure: {
        origin: "provider",
        kind: "stream_protocol",
        stage: "streaming"
      }
    });

    const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const interruptedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        );
        controller.error(reset);
      }
    });
    const interrupted = await providerEvents(async () =>
      new Response(interruptedBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    expect(interrupted.at(-1)).toMatchObject({
      code: "upstream_unavailable",
      providerFailure: {
        origin: "network",
        kind: "connection_reset",
        stage: "streaming",
        transportCode: "ECONNRESET"
      }
    });
  });

  it("distinguishes adapter deadline from client cancellation", async () => {
    const waitForAbort = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true
        });
      });
    const deadline = await providerEvents(waitForAbort, { timeoutMs: 1 });
    expect(deadline[0]).toMatchObject({
      code: "upstream_timeout",
      providerFailure: {
        origin: "gateway",
        kind: "deadline_exceeded",
        stage: "before_headers"
      }
    });

    const controller = new AbortController();
    const pending = providerEvents(waitForAbort, { signal: controller.signal });
    controller.abort(
      new GatewayError({
        code: "client_aborted",
        message: "Client disconnected.",
        httpStatus: 499
      })
    );
    const cancelled = await pending;
    expect(cancelled[0]).toMatchObject({
      code: "client_aborted",
      providerFailure: {
        origin: "client",
        kind: "client_aborted",
        stage: "before_headers"
      }
    });
  });
});

async function providerEvents(
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const provider = new OpenAICompatibleProviderAdapter({
    providerKind: "openrouter",
    apiKey: "sk-test-redacted",
    apiKeyEnv: "MEDCODE_OPENROUTER_API_KEY",
    baseUrl: "https://provider.invalid/v1",
    upstreamModel: "z-ai/glm-5.2",
    timeoutMs: options.timeoutMs ?? 5_000,
    fetchImpl
  });
  const input: MessageInput = {
    upstreamAccount: openRouterAccount(),
    subject: testSubject(),
    scope: "code",
    session: testSession(),
    message: "diagnostic test",
    signal: options.signal
  };
  const events = [];
  for await (const event of provider.message(input)) {
    events.push(event);
  }
  return events;
}

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
