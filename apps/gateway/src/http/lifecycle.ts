import type { FastifyInstance } from "fastify";

export class GatewayLifecycle {
  draining = false;
  private connections = 0;
  private work = 0;

  snapshot() { return { draining: this.draining, active_requests: this.connections, active_work: this.work }; }
  drain() { this.draining = true; }
  resume() { this.draining = false; }
  hold(kind: "connections" | "work"): () => void {
    this[kind]++;
    let ended = false;
    return () => { if (!ended) { ended = true; this[kind]--; } };
  }
  async waitForIdle(timeoutMs: number): Promise<void> {
    const until = performance.now() + timeoutMs;
    while (this.connections || this.work) {
      if (performance.now() >= until) throw new Error("Gateway drain deadline exceeded");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

declare module "fastify" {
  interface FastifyInstance { gatewayLifecycle: GatewayLifecycle; }
}

export function installGatewayLifecycle(app: FastifyInstance): GatewayLifecycle {
  const lifecycle = new GatewayLifecycle();
  app.decorate("gatewayLifecycle", lifecycle);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/gateway/health" && request.method === "GET") return;
    const recovery = request.method === "GET" && path?.startsWith("/gateway/model-calls/");
    if (lifecycle.draining && !recovery) {
      return reply.header("retry-after", "5").code(503).send({
        error: { code: "service_unavailable", message: "Gateway is draining; retry after the indicated delay.", retry_after_seconds: 5 }
      });
    }
    const end = lifecycle.hold("connections");
    reply.raw.once("close", end);
    reply.raw.once("finish", end);
  });
  // A disconnected response must not hide a still-running handler (including SSE).
  app.addHook("onRoute", route => {
    if (route.url === "/gateway/health") return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const end = lifecycle.hold("work");
      try { return await handler.call(this, request, reply); }
      finally {
        // Also cover failures during provider setup before its normal finalizer.
        // Never tie this execution lease to the HTTP disconnect event.
        try { request.gatewayTokenReservationRelease?.(); }
        finally { request.gatewayTokenReservationRelease = undefined; end(); }
      }
    };
  });
  return lifecycle;
}

export function installGatewayShutdown(app: FastifyInstance, timeoutMs = 900_000): () => void {
  let closing = false;
  const drain = () => { app.gatewayLifecycle.drain(); app.log.info(app.gatewayLifecycle.snapshot(), "Gateway draining."); };
  const resume = () => { if (!closing) app.gatewayLifecycle.resume(); };
  const shutdown = () => {
    if (closing) return;
    closing = true;
    drain();
    void app.gatewayLifecycle.waitForIdle(timeoutMs).then(() => app.close()).catch(error => {
      app.log.error({ error: String(error), ...app.gatewayLifecycle.snapshot() }, "Gateway shutdown incomplete.");
      process.exit(1);
    });
  };
  process.on("SIGUSR2", drain);
  process.on("SIGCONT", resume);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const remove = () => {
    process.off("SIGUSR2", drain); process.off("SIGCONT", resume);
    process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown);
  };
  app.addHook("onClose", async () => remove());
  return remove;
}
