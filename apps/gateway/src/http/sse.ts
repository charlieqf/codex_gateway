import type { FastifyReply } from "fastify";

export interface SseHandle {
  readonly signal: AbortSignal;
  isClosed(): boolean;
  writeComment(comment: string): boolean;
  writeData(data: unknown): boolean;
  writeDone(): boolean;
  writeEvent(event: string, data: unknown): boolean;
  end(): void;
}

export function setupSseResponse(reply: FastifyReply): SseHandle {
  reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  reply.hijack();

  const abort = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    abort.abort();
  };
  reply.raw.on("close", close);

  const guard = (write: () => boolean): boolean => {
    if (closed) {
      return false;
    }
    const ok = write();
    if (!ok) {
      close();
    }
    return ok;
  };

  const heartbeat = setInterval(() => {
    guard(() => writeSseComment(reply, "ping"));
  }, 25_000);
  heartbeat.unref?.();

  return {
    signal: abort.signal,
    isClosed: () => closed,
    writeComment: (comment) => guard(() => writeSseComment(reply, comment)),
    writeData: (data) => guard(() => writeSseData(reply, data)),
    writeDone: () => guard(() => writeSseDone(reply)),
    writeEvent: (event, data) => guard(() => writeSseEvent(reply, event, data)),
    end: () => {
      clearInterval(heartbeat);
      reply.raw.off("close", close);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  };
}

function writeSseEvent(reply: FastifyReply, event: string, data: unknown): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeSseData(reply: FastifyReply, data: unknown): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeSseDone(reply: FastifyReply): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write("data: [DONE]\n\n");
    return true;
  } catch {
    return false;
  }
}

function writeSseComment(reply: FastifyReply, comment: string): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false;
  }

  try {
    reply.raw.write(`:${comment}\n\n`);
    return true;
  } catch {
    return false;
  }
}
