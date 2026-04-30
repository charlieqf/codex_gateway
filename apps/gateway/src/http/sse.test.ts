import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import { setupSseResponse } from "./sse.js";

class FakeRawReply extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly headers = new Map<string, string>();
  writes: string[] = [];
  failOnWrite: number | null = null;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string): boolean {
    if (this.failOnWrite !== null && this.writes.length + 1 === this.failOnWrite) {
      throw new Error("synthetic write failure");
    }
    this.writes.push(chunk);
    return true;
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
  it("aborts the SSE signal when a write fails", () => {
    const raw = new FakeRawReply();
    raw.failOnWrite = 2;
    const sse = setupSseResponse(createReply(raw));

    expect(sse.writeData({ first: true })).toBe(true);
    expect(sse.signal.aborted).toBe(false);

    expect(sse.writeData({ second: true })).toBe(false);
    expect(sse.signal.aborted).toBe(true);
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
    expect(sse.isClosed()).toBe(true);
    expect(sse.writeComment("late")).toBe(false);

    sse.end();
  });
});
