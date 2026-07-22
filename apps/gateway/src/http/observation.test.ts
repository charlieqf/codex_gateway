import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import {
  markProviderCallFinished,
  markProviderCallStarted,
  markProviderEvent
} from "./observation.js";

describe("provider call observation", () => {
  it("records explicit false cancellation values for a normal provider call", () => {
    const request = {} as FastifyRequest;
    const signal = new AbortController().signal;

    markProviderCallStarted(request, new Date("2026-07-22T00:00:00.000Z"));
    markProviderCallFinished(
      request,
      signal,
      new Date("2026-07-22T00:00:01.250Z")
    );

    expect(request.gatewayProviderDurationMs).toBe(1_250);
    expect(request.gatewayTerminalSource).toBe("provider_response");
    expect(request.gatewayCancelRequested).toBe(false);
    expect(request.gatewayCancelObserved).toBe(false);
  });

  it("preserves a cancellation observed from the provider event", () => {
    const request = {} as FastifyRequest;
    const controller = new AbortController();
    const error = new GatewayError({
      code: "client_aborted",
      message: "Client disconnected.",
      httpStatus: 499
    });

    markProviderCallStarted(request, new Date("2026-07-22T00:00:00.000Z"));
    markProviderEvent(
      request,
      { type: "error", code: "client_aborted", message: "Client disconnected." },
      new Date("2026-07-22T00:00:00.500Z")
    );
    controller.abort(error);
    markProviderCallFinished(
      request,
      controller.signal,
      new Date("2026-07-22T00:00:00.750Z")
    );

    expect(request.gatewayCancelRequested).toBe(true);
    expect(request.gatewayCancelObserved).toBe(true);
    expect(request.gatewayTerminalSource).toBe("client_abort");
  });
});
