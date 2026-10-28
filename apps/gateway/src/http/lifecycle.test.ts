import Fastify from "fastify";
import http from "node:http";
import { expect, it, vi } from "vitest";
import { installGatewayLifecycle, installGatewayShutdown } from "./lifecycle.js";

it("releases an execution lease if setup throws before the normal finalizer", async () => {
  const app = Fastify();
  const lifecycle = installGatewayLifecycle(app);
  const release = vi.fn();
  app.get("/setup-failure", async request => {
    request.gatewayTokenReservationRelease = release;
    throw new Error("synthetic setup failure");
  });
  try {
    expect((await app.inject("/setup-failure")).statusCode).toBe(500);
    expect(release).toHaveBeenCalledOnce();
    await lifecycle.waitForIdle(1000);
  } finally { await app.close(); }
});

it("allows a 30-minute in-flight call and cleanup to finish during shutdown", async () => {
  const app = Fastify();
  const lifecycle = installGatewayLifecycle(app);
  const endWork = lifecycle.hold("work");
  const closed = vi.spyOn(app, "close");
  const exited = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const previousHandlers = new Set(process.listeners("SIGTERM"));
  const remove = installGatewayShutdown(app);
  const shutdown = process.listeners("SIGTERM").find(handler => !previousHandlers.has(handler))!;
  vi.useFakeTimers();
  try {
    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(lifecycle.draining).toBe(true);
    expect(exited).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    endWork();
    await vi.advanceTimersByTimeAsync(25);
    expect(closed).toHaveBeenCalledOnce();
    expect(exited).not.toHaveBeenCalled();
  } finally {
    endWork(); remove(); vi.useRealTimers(); exited.mockRestore(); await app.close();
  }
});

it("drains actual handler work even after its HTTP client disconnects, rejecting new admission", async () => {
  const app = Fastify();
  const lifecycle = installGatewayLifecycle(app);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => enter = r), release = new Promise<void>(r => finish = r);
  app.get("/slow", async () => { enter(); await release; return { ok: true }; });
  app.get("/gateway/health", async () => lifecycle.snapshot());
  app.get("/gateway/model-calls/:id", async () => ({ state: "running" }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = http.get(`${url}/slow`);
  request.on("error", () => undefined);
  try {
    await entered;
    request.destroy();
    lifecycle.drain();
    await expect(lifecycle.waitForIdle(50)).rejects.toThrow("deadline");
    expect(lifecycle.snapshot()).toMatchObject({ active_requests: 0, active_work: 1 });
    expect((await app.inject("/slow")).statusCode).toBe(503);
    expect((await app.inject("/gateway/model-calls/a")).statusCode).toBe(200);
    finish();
    await lifecycle.waitForIdle(1000);
    lifecycle.resume();
    expect((await app.inject("/slow")).statusCode).toBe(200);
  } finally { finish(); await app.close(); }
});
