import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "@codex-gateway/core";
import type { FastifyReply } from "fastify";
import { setupSseResponse } from "./sse.js";

class FakeRawReply extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly headers = new Map<string, string>();
  writes: string[] = [];
  failOnWrite: number | null = null;
  writableNeedDrain = false;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string): boolean {
    if (this.failOnWrite !== null && this.writes.length + 1 === this.failOnWrite) {
      throw new Error("synthetic write failure");
    }
    this.writes.push(chunk);
    return !this.writableNeedDrain;
  }

  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }
}

function createReply(raw = new FakeRawReply()): FastifyReply {
  return {
    raw,
    hijack() {}
  } as unknown as FastifyReply;
}

describe("setupSseResponse", () => {
  it("defers the S heartbeat without changing ordinary heartbeat timing", () => {
    vi.useFakeTimers();
    const ordinary = new FakeRawReply(), delivery = new FakeRawReply();
    const first = setupSseResponse(createReply(ordinary));
    const second = setupSseResponse(createReply(delivery), { deferHeartbeat: true });
    try {
      vi.advanceTimersByTime(26000);
      expect(ordinary.writes).toEqual([":ping\n\n"]);
      expect(delivery.writes).toEqual([]);
      expect(second.writeData({ valid: true })).toBe(true);
    } finally { first.end(); second.end(); vi.useRealTimers(); }
  });
  it.each(["drain", "abort", "close"])("honors %s while S waits for backpressure", async (event) => {
    const raw = new FakeRawReply(); raw.writableNeedDrain = true;
    const sse = setupSseResponse(createReply(raw), { deferHeartbeat: true });
    const controller = new AbortController();
    let finished = false;
    const pending = sse.writeDataAsync({ payload: "bounded" }, controller.signal).then((ok) => { finished = true; return ok; });
    await Promise.resolve(); expect(finished).toBe(false);
    if (event === "drain") { raw.writableNeedDrain = false; raw.emit("drain"); }
    if (event === "abort") controller.abort();
    if (event === "close") raw.emit("close");
    expect(await pending).toBe(event === "drain");
    expect(raw.listenerCount("drain")).toBe(0);
    expect(raw.listenerCount("error")).toBe(0);
    sse.end();
  });
  it("aborts the SSE signal when a write fails", () => {
    const raw = new FakeRawReply();
    raw.failOnWrite = 2;
    const sse = setupSseResponse(createReply(raw));

    expect(sse.writeData({ first: true })).toBe(true);
    expect(sse.signal.aborted).toBe(false);

    expect(sse.writeData({ second: true })).toBe(false);
    expect(sse.signal.aborted).toBe(true);
    expect(sse.signal.reason).toBeInstanceOf(GatewayError);
    expect((sse.signal.reason as GatewayError).code).toBe("client_aborted");
    expect(sse.isClosed()).toBe(true);

    const writesAfterFailure = raw.writes.length;
    expect(sse.writeData({ third: true })).toBe(false);
    expect(raw.writes).toHaveLength(writesAfterFailure);

    sse.end();
    expect(raw.writes).toHaveLength(writesAfterFailure);
  });

  it("aborts the SSE signal when the raw reply closes", () => {
    const raw = new FakeRawReply();
    const sse = setupSseResponse(createReply(raw));

    raw.emit("close");

    expect(sse.signal.aborted).toBe(true);
    expect(sse.signal.reason).toBeInstanceOf(GatewayError);
    expect((sse.signal.reason as GatewayError).code).toBe("client_aborted");
    expect(sse.isClosed()).toBe(true);
    expect(sse.writeComment("late")).toBe(false);

    sse.end();
  });
});
