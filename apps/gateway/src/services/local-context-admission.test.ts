import { describe, expect, it } from "vitest";
import {
  contextCompactionRequiredError,
  localContextWindowDetails,
  parseLocalContextAdmissionMode,
  providerTokenizedContextWindowDetails
} from "./local-context-admission.js";

describe("local context admission", () => {
  it("defaults to disabled and accepts the rollout modes", () => {
    expect(parseLocalContextAdmissionMode(undefined)).toBe("disabled");
    expect(parseLocalContextAdmissionMode(" SHADOW ")).toBe("shadow");
    expect(parseLocalContextAdmissionMode("enforce")).toBe("enforce");
    expect(() => parseLocalContextAdmissionMode("enabled")).toThrow(
      "MEDCODE_LOCAL_CONTEXT_ADMISSION_MODE"
    );
  });

  it("uses the smaller configured or tokenizer limit", () => {
    expect(
      providerTokenizedContextWindowDetails({
        configuredContextLimitTokens: 32_768,
        requestedOutputTokens: 8_192,
        tokenCount: {
          promptTokens: 24_577,
          maxContextTokens: 40_000,
          source: "provider_tokenizer"
        }
      })
    ).toEqual({
      contextLimitTokens: 32_768,
      promptTokens: 24_577,
      requestedOutputTokens: 8_192,
      totalTokens: 32_769,
      overflowTokens: 1,
      tokenCountSource: "provider_tokenizer"
    });
    expect(
      providerTokenizedContextWindowDetails({
        configuredContextLimitTokens: 40_000,
        requestedOutputTokens: 8_192,
        tokenCount: {
          promptTokens: 24_577,
          maxContextTokens: 32_768,
          source: "provider_tokenizer"
        }
      })?.contextLimitTokens
    ).toBe(32_768);
  });

  it("allows a request that exactly fills the context window", () => {
    expect(
      providerTokenizedContextWindowDetails({
        configuredContextLimitTokens: 32_768,
        requestedOutputTokens: 8_192,
        tokenCount: {
          promptTokens: 24_576,
          maxContextTokens: 32_768,
          source: "provider_tokenizer"
        }
      })
    ).toBeNull();
  });

  it("parses the vLLM context validation form", () => {
    expect(
      localContextWindowDetails(
        "This model's maximum context length is 32768 tokens. However, you requested 32769 tokens (24577 in the messages, 8192 in the completion).",
        undefined
      )
    ).toEqual({
      contextLimitTokens: 32_768,
      promptTokens: 24_577,
      requestedOutputTokens: 8_192,
      totalTokens: 32_769,
      overflowTokens: 1,
      tokenCountSource: "upstream_validation"
    });
  });

  it("does not classify unrelated or non-overflow validation messages", () => {
    expect(localContextWindowDetails("Unsupported field.", 8_192)).toBeNull();
    expect(
      localContextWindowDetails(
        "The maximum context length is 32768 tokens; prompt length is 100 tokens.",
        8_192
      )
    ).toBeNull();
  });

  it("builds the frozen one-shot client recovery contract", () => {
    expect(
      contextCompactionRequiredError({
        contextLimitTokens: 32_768,
        promptTokens: 24_577,
        requestedOutputTokens: 8_192,
        totalTokens: 32_769,
        overflowTokens: 1,
        tokenCountSource: "provider_tokenizer"
      })
    ).toMatchObject({
      code: "context_compaction_required",
      httpStatus: 413,
      contractVersion: 1,
      failureKind: "model_context_overflow",
      transformedRetryAllowed: true,
      recommendedAction: "compact_and_retry_once",
      recoveryOwner: "client"
    });
  });
});
