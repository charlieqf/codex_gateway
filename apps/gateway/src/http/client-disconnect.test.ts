import { EventEmitter } from "node:events";
import { GatewayError } from "@codex-gateway/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { observeClientDisconnect } from "./client-disconnect.js";

class RawRequest extends EventEmitter {
  complete = true;
}

class RawReply extends EventEmitter {
  writableEnded = false;
}

function fixture() {
  const rawRequest = new RawRequest();
  const rawReply = new RawReply();
  const request = { raw: rawRequest } as unknown as FastifyRequest;
  const reply = { raw: rawReply } as unknown as FastifyReply;
  return { rawRequest, rawReply, request, reply };
}

describe("client disconnect observation", () => {
  it("does not treat a normal completed request close as a disconnect", () => {
    const { rawRequest, request, reply } = fixture();
    const onDisconnect = vi.fn();
    const handle = observeClientDisconnect(request, reply, onDisconnect);

    rawRequest.emit("close");

    expect(handle.signal.aborted).toBe(false);
    expect(onDisconnect).not.toHaveBeenCalled();
    handle.cleanup();
  });

  it("aborts when the request body closes before it is complete", () => {
    const { rawRequest, request, reply } = fixture();
    rawRequest.complete = false;
    const onDisconnect = vi.fn();
    const handle = observeClientDisconnect(request, reply, onDisconnect);

    rawRequest.emit("close");

    expect(handle.signal.reason).toBeInstanceOf(GatewayError);
    expect((handle.signal.reason as GatewayError).code).toBe("client_aborted");
    expect(onDisconnect).toHaveBeenCalledOnce();
    handle.cleanup();
  });

  it("aborts only when the reply closes before writable completion", () => {
    const incomplete = fixture();
    const incompleteDisconnect = vi.fn();
    const incompleteHandle = observeClientDisconnect(
      incomplete.request,
      incomplete.reply,
      incompleteDisconnect
    );
    incomplete.rawReply.emit("close");
    expect(incompleteHandle.signal.aborted).toBe(true);
    expect(incompleteDisconnect).toHaveBeenCalledOnce();
    incompleteHandle.cleanup();

    const complete = fixture();
    complete.rawReply.writableEnded = true;
    const completeDisconnect = vi.fn();
    const completeHandle = observeClientDisconnect(
      complete.request,
      complete.reply,
      completeDisconnect
    );
    complete.rawReply.emit("close");
    expect(completeHandle.signal.aborted).toBe(false);
    expect(completeDisconnect).not.toHaveBeenCalled();
    completeHandle.cleanup();
  });

  it("removes both listeners during normal cleanup", () => {
    const { rawRequest, rawReply, request, reply } = fixture();
    const onDisconnect = vi.fn();
    const handle = observeClientDisconnect(request, reply, onDisconnect);

    handle.cleanup();
    rawRequest.complete = false;
    rawRequest.emit("close");
    rawReply.emit("close");

    expect(handle.signal.aborted).toBe(false);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
