import { GatewayError } from "@codex-gateway/core";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface ClientDisconnectHandle {
  readonly signal: AbortSignal;
  cleanup(): void;
}

export function observeClientDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
  onDisconnect?: (reason: GatewayError) => void
): ClientDisconnectHandle {
  const controller = new AbortController();
  let listening = true;

  const disconnect = () => {
    if (controller.signal.aborted) {
      return;
    }
    const reason = new GatewayError({
      code: "client_aborted",
      message: "Client disconnected.",
      httpStatus: 499
    });
    controller.abort(reason);
    onDisconnect?.(reason);
  };
  const requestClosed = () => {
    if (request.raw.complete === false) {
      disconnect();
    }
  };
  const replyClosed = () => {
    if (reply.raw.writableEnded === false) {
      disconnect();
    }
  };

  request.raw.once("close", requestClosed);
  reply.raw.once("close", replyClosed);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (!listening) {
        return;
      }
      listening = false;
      request.raw.off("close", requestClosed);
      reply.raw.off("close", replyClosed);
    }
  };
}
