import { describe, expect, it } from "vitest";
import { streamErrorToGatewayError } from "./provider-stream.js";

describe("streamErrorToGatewayError", () => {
  it("preserves structured context length errors", () => {
    const error = streamErrorToGatewayError({
      code: "context_length_exceeded",
      message:
        "Current conversation is too long. Start a new conversation or clear earlier history before retrying."
    });

    expect(error.code).toBe("context_length_exceeded");
    expect(error.httpStatus).toBe(413);
    expect(error.message).toBe(
      "Current conversation is too long. Start a new conversation or clear earlier history before retrying."
    );
  });

  it("maps context_too_large aliases to the public context length code", () => {
    const error = streamErrorToGatewayError({
      code: "context_too_large",
      message: "Current conversation is too long."
    });

    expect(error.code).toBe("context_length_exceeded");
    expect(error.httpStatus).toBe(413);
  });
});
