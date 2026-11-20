import { once } from "node:events";
import { GatewayError } from "@codex-gateway/core";
import type { FastifyReply } from "fastify";

export interface SseHandle {
  readonly signal: AbortSignal;
  /** True when neither the socket nor a recovery receipt can consume output. */
  isClosed(): boolean;
  writeComment(comment: string): boolean;
  writeData(data: unknown, terminal?: "failed"): boolean;
  /** Bounded delivery only: await backpressure while honoring the original deadline. */
  writeDataAsync(data: unknown, signal: AbortSignal): Promise<boolean>;
  writeDone(): boolean;
  writeEvent(event: string, data: unknown): boolean;
  end(): void;
}

export function setupSseResponse(reply: FastifyReply, options: { deferHeartbeat?: boolean } = {}): SseHandle {
  const raw = reply.raw;
  raw.setHeader("content-type", "text/event-stream; charset=utf-8");
  raw.setHeader("cache-control", "no-cache");
  raw.setHeader("connection", "keep-alive");
  reply.hijack();

  const receipt = reply.request?.modelCallReceipt;
  const disconnect = new AbortController();
  const close = () => disconnect.abort(new GatewayError({
    code: "client_aborted", message: "Client disconnected.", httpStatus: 499,
  }));
  raw.once("close", close);

  function writeSocket(frame: string) {
    if (disconnect.signal.aborted) return "closed";
    if (!raw.destroyed && !raw.writableEnded) {
      try {
        return raw.write(frame) ? "ready" : "backpressure";
      } catch { /* detach the failed socket */ }
    }
    close();
    return "closed";
  }

  function writeFrame(frame: string, terminal?: "completed" | "failed") {
    receipt?.append(frame);
    if (terminal) receipt?.finish(undefined, terminal);
    const written = writeSocket(frame);
    return written === "closed" && receipt ? "ready" : written;
  }

  // A heartbeat must not commit headers before the write-delivery manifest.
  const heartbeat = options.deferHeartbeat ? undefined : setInterval(() => writeSocket(":ping\n\n"), 25_000);
  heartbeat?.unref();

  return {
    signal: disconnect.signal,
    isClosed: () => !receipt && disconnect.signal.aborted,
    writeComment: comment => writeSocket(`:${comment}\n\n`) !== "closed",
    writeData: (data, terminal) => writeFrame(`data: ${JSON.stringify(data)}\n\n`, terminal) !== "closed",
    writeDataAsync: async (data, signal) => {
      if (signal.aborted) return false;
      const written = writeFrame(`data: ${JSON.stringify(data)}\n\n`);
      if (written === "backpressure" && raw.writableNeedDrain) {
        try {
          await once(raw, "drain", { signal: AbortSignal.any([signal, disconnect.signal]) });
        } catch {
          if (!signal.aborted && !disconnect.signal.aborted) close(); // socket error
        }
      }
      return !signal.aborted && (!disconnect.signal.aborted || receipt !== undefined);
    },
    writeDone: () => writeFrame("data: [DONE]\n\n", "completed") !== "closed",
    writeEvent: (event, data) => writeFrame(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) !== "closed",
    end: () => {
      clearInterval(heartbeat);
      raw.off("close", close);
      if (!raw.destroyed && !raw.writableEnded) raw.end();
    },
  };
}
