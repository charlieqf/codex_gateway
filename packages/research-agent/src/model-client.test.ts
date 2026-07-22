import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayResearchModelClient,
  researchModelCallTelemetryFromError
} from "./index.js";

describe("Doctor Research structured Gateway model client", () => {
  it("preflights the exact credential model and requests one plain JSON value", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push({ url, init });
        if (url.includes("/worker/llm-readiness/")) {
          return jsonResponse({
            schema_version: "research_llm_readiness.v1",
            model: "medcode",
            authorized: true
          });
        }
        return jsonResponse(
          {
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "{\"schema_version\":\"doctor_research_model_output.v1\"}"
                },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              completion_tokens_details: {
                reasoning_tokens: 7
              },
              total_tokens: 120
            }
          },
          { "x-request-id": "req_model_client" }
        );
      }
    );
    const client = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      readinessRequirements: {
        ...readinessRequirements(),
        concurrentCalls: 3
      },
      fetchImpl
    });
    const signal = new AbortController().signal;

    await expect(client.assertModelAvailable(signal)).resolves.toBeUndefined();
    const response = await client.generate({
      runId: `drr_${"a".repeat(32)}`,
      stage: "synthesize_review",
      attempt: 1,
      system: "Return structured evidence.",
      prompt: "Use the closed evidence set.",
      signal,
      maximumOutputTokens: 8_000
    });

    expect(response).toMatchObject({
      text: "{\"schema_version\":\"doctor_research_model_output.v1\"}",
      gatewayRequestId: "req_model_client",
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        reasoningTokens: 7,
        totalTokens: 120
      },
      telemetry: {
        admissionWaitMs: 0,
        cancelObserved: false,
        cancelRequested: false,
        maximumOutputTokens: 8_000,
        promptChars: 55,
        terminalSource: "provider_response"
      }
    });
    expect(response.telemetry?.requestSentAt).toBeInstanceOf(Date);
    expect(response.telemetry?.clientTotalMs).toBeGreaterThanOrEqual(0);
    const readinessUrl = new URL(requests[0]!.url);
    expect(Object.fromEntries(readinessUrl.searchParams)).toEqual({
      maximum_prompt_tokens_per_call: "200000",
      maximum_output_tokens_per_call: "12000",
      calls_per_run: "5",
      concurrent_calls: "3",
      maximum_tokens_per_run: "848000"
    });
    const request = requests[1];
    const body = JSON.parse(String(request?.init?.body)) as {
      stream: boolean;
      max_tokens: number;
      reasoning_effort: string;
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      tool_choice?: unknown;
      response_format?: unknown;
    };
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(8_000);
    expect(body.reasoning_effort).toBe("low");
    expect(body.messages).toHaveLength(2);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("response_format");
    expect(request?.init?.headers).toMatchObject({
      authorization: "Bearer secret-staging-token",
      "x-medcode-client-session-id":
        `drr_${"a".repeat(32)}:synthesize_review:1`,
      "x-medcode-client-turn-code": "research:synthesize_review:1"
    });
  });

  it("classifies hidden-reasoning exhaustion and honors a bounded reasoning override", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let requestHeaders: Record<string, string> | null = null;
    const client = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async (_input, init) => {
        requestHeaders = init?.headers as Record<string, string>;
        requestBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return jsonResponse(
          {
            choices: [
              {
                message: { role: "assistant", content: "" },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 12_000,
              completion_tokens: 8_001,
              completion_tokens_details: {
                reasoning_tokens: 8_000
              },
              total_tokens: 20_001
            }
          },
          { "x-request-id": "req_model_output_exhausted" }
        );
      }
    });

    const failure = await captureFailure(() =>
      client.generate({
        runId: `drr_${"9".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 4,
        system: "Return structured evidence.",
        prompt: "Use the closed evidence set.",
        signal: new AbortController().signal,
        maximumOutputTokens: 8_000,
        reasoningEffort: "none",
        providerTimeoutMs: 70_000
      })
    );

    expect(failure).toMatchObject({
      name: "ResearchModelClientError",
      code: "output_exhausted",
      statusCode: 200,
      gatewayRequestId: "req_model_output_exhausted"
    });
    expect(requestBody).toMatchObject({
      max_tokens: 8_000,
      reasoning_effort: "none"
    });
    expect(requestHeaders).toMatchObject({
      "x-medcode-request-timeout-ms": "70000"
    });
    expect(researchModelCallTelemetryFromError(failure)).toMatchObject({
      terminalSource: "provider_response",
      cancelRequested: false,
      cancelObserved: false
    });
  });

  it("fails closed when the service credential does not expose the exact model", async () => {
    const client = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async () =>
        jsonResponse({
          schema_version: "research_llm_readiness.v1",
          model: "another-model",
          authorized: false
        })
    });
    await expect(
      client.assertModelAvailable(new AbortController().signal)
    ).rejects.toThrow("Research LLM request failed");
  });

  it("retries a rate-limited admission inside the same model attempt", async () => {
    let requests = 0;
    const client = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          return new Response(
            JSON.stringify({ retry_after_seconds: 0 }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "0",
                "x-request-id": "req_admission_limited"
              }
            }
          );
        }
        return jsonResponse(
          {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "{\"admitted\":true}"
                }
              }
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15
            }
          },
          { "x-request-id": "req_admission_completed" }
        );
      }
    });

    const response = await client.generate({
        runId: `drr_${"d".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 1,
        system: "Return structured evidence.",
        prompt: "Use the closed evidence set.",
        signal: new AbortController().signal
      });
    expect(response).toMatchObject({
      text: "{\"admitted\":true}",
      gatewayRequestId: "req_admission_completed"
    });
    expect(response.telemetry).toMatchObject({
      terminalSource: "provider_response",
      cancelRequested: false,
      cancelObserved: false
    });
    expect(response.telemetry?.admissionWaitMs).toBeGreaterThanOrEqual(300);
    expect(response.telemetry?.clientTotalMs).toBeGreaterThanOrEqual(
      response.telemetry?.admissionWaitMs ?? 0
    );
    expect(requests).toBe(2);
  });

  it("does not send a bearer token over cleartext HTTP to a public hostname", () => {
    expect(
      () =>
        new GatewayResearchModelClient({
          baseUrl: "http://gateway.example:8787",
          allowedHosts: ["gateway.example"],
          model: "medcode",
          reasoningEffort: "low",
          bearerToken: "secret-staging-token",
          timeoutMs: 5_000,
          maximumResponseBytes: 100_000,
          readinessRequirements: readinessRequirements()
        })
    ).toThrow("cleartext HTTP");
  });

  it("classifies a model network failure as a retryable transport error", async () => {
    const client = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async () => {
        throw new TypeError("simulated network failure");
      }
    });

    let failure: unknown;
    try {
      await client.generate({
        runId: `drr_${"b".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 1,
        system: "Return structured evidence.",
        prompt: "Use the closed evidence set.",
        signal: new AbortController().signal
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ResearchModelClientError",
      code: "upstream_error",
      statusCode: 0,
      gatewayRequestId: null
    });
    expect(researchModelCallTelemetryFromError(failure)).toMatchObject({
      terminalSource: "transport_error",
      cancelRequested: false,
      cancelObserved: false
    });
  });

  it("records provider responses and provider deadlines on failed calls", async () => {
    const responseFailureClient = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "provider_failure" } }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
    });
    const responseFailure = await captureFailure(() =>
      responseFailureClient.generate({
        runId: `drr_${"e".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 1,
        system: "Return structured evidence.",
        prompt: "Use the closed evidence set.",
        signal: new AbortController().signal
      })
    );
    expect(researchModelCallTelemetryFromError(responseFailure)).toMatchObject({
      terminalSource: "provider_response",
      cancelRequested: false,
      cancelObserved: false
    });

    const deadlineClient = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 10,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async (_input, init) =>
        await rejectWhenAborted(init?.signal)
    });
    const deadlineFailure = await captureFailure(() =>
      deadlineClient.generate({
        runId: `drr_${"f".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 1,
        system: "Return structured evidence.",
        prompt: "Use the closed evidence set.",
        signal: new AbortController().signal
      })
    );
    expect(researchModelCallTelemetryFromError(deadlineFailure)).toMatchObject({
      terminalSource: "provider_deadline",
      cancelRequested: true,
      cancelObserved: true
    });
  });

  it("records an upstream client cancellation separately from a provider deadline", async () => {
    const controller = new AbortController();
    const client = new GatewayResearchModelClient({
      baseUrl: "http://gateway:8787",
      allowedHosts: ["gateway"],
      model: "medcode",
      reasoningEffort: "low",
      bearerToken: "secret-staging-token",
      timeoutMs: 5_000,
      maximumResponseBytes: 100_000,
      readinessRequirements: readinessRequirements(),
      fetchImpl: async (_input, init) =>
        await rejectWhenAborted(init?.signal)
    });
    const pending = captureFailure(() =>
      client.generate({
        runId: `drr_${"1".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 1,
        system: "Return structured evidence.",
        prompt: "Use the closed evidence set.",
        signal: controller.signal
      })
    );
    controller.abort(
      Object.assign(new Error("Client disconnected."), {
        code: "client_aborted"
      })
    );
    const failure = await pending;
    expect(researchModelCallTelemetryFromError(failure)).toMatchObject({
      terminalSource: "client_abort",
      cancelRequested: true,
      cancelObserved: true
    });
  });

  it("uses the bounded native HTTP transport for long non-streaming generation", async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      setTimeout(() => {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "req_native_transport"
        });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "{\"native\":true}"
                }
              }
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              completion_tokens_details: {
                reasoning_tokens: 2
              },
              total_tokens: 15
            }
          })
        );
      }, 25);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test HTTP server did not bind.");
      }
      const client = new GatewayResearchModelClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        allowedHosts: ["127.0.0.1"],
        model: "goldencode",
        reasoningEffort: "low",
        bearerToken: "secret-staging-token",
        timeoutMs: 5_000,
        maximumResponseBytes: 100_000,
        readinessRequirements: readinessRequirements()
      });
      const response = await client.generate({
        runId: `drr_${"c".repeat(32)}`,
        stage: "synthesize_review",
        attempt: 1,
        system: "Return JSON.",
        prompt: "Use bounded native HTTP.",
        signal: new AbortController().signal
      });
      expect(response).toMatchObject({
        text: "{\"native\":true}",
        gatewayRequestId: "req_native_transport",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          reasoningTokens: 2,
          totalTokens: 15
        },
        telemetry: {
          admissionWaitMs: 0,
          cancelObserved: false,
          cancelRequested: false,
          maximumOutputTokens: 12_000,
          promptChars: 36,
          terminalSource: "provider_response"
        }
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("rejects an invalid reasoning effort before sending a request", () => {
    expect(
      () =>
        new GatewayResearchModelClient({
          baseUrl: "http://gateway:8787",
          allowedHosts: ["gateway"],
          model: "goldencode",
          reasoningEffort: "xhigh" as "high",
          bearerToken: "secret-staging-token",
          timeoutMs: 5_000,
          maximumResponseBytes: 100_000,
          readinessRequirements: readinessRequirements()
        })
    ).toThrow("reasoning effort is invalid");
  });
});

function readinessRequirements() {
  return {
    maximumPromptTokensPerCall: 200_000,
    maximumOutputTokensPerCall: 12_000,
    callsPerRun: 5,
    maximumTokensPerRun: 848_000
  };
}

function jsonResponse(
  value: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the model call to fail.");
}

async function rejectWhenAborted(
  signal: AbortSignal | null | undefined
): Promise<Response> {
  if (!signal) {
    throw new Error("Expected an abort signal.");
  }
  return await new Promise<Response>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}
