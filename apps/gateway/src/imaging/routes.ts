import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ImagingError, capabilities, chunkBytes, emptyBody, identifier, imagingPrefix, requireImaging } from "./contract.js";
import type { ImagingService } from "./service.js";

interface RequestState { release?: () => void; timer?: NodeJS.Timeout; working: boolean; disconnected: boolean; streaming: boolean; errorCode: string | null }
export function registerImagingRoutes(root: FastifyInstance, service: ImagingService | null): void {
  void root.register(async app => {
    const states = new WeakMap<FastifyRequest, RequestState>();
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    app.setErrorHandler((error: unknown, request, reply) => {
      const e = error as { code?: string; statusCode?: number };
      const safe = error instanceof ImagingError ? error : e.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new ImagingError(413, "size_limit")
        : e.statusCode && e.statusCode < 500 ? new ImagingError(400, "invalid_request") : new ImagingError(503, "unavailable");
      const state = states.get(request); if (state) state.errorCode = safe.code;
      reply.code(safe.status).send({ error: { code: safe.code, message: safe.message, retryable: safe.retryable }, request_id: request.id });
    });
    app.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache").header("x-content-type-options", "nosniff");
      for (const header of Object.keys(request.headers)) {
        if (header.startsWith("x-imaging-") || header.startsWith("x-service-")) delete request.headers[header];
      }
      const state: RequestState = { working: false, disconnected: false, streaming: false, errorCode: null };
      states.set(request, state);
      const upload = request.method === "PUT" && request.routeOptions.url?.endsWith("/upload/parts/:index");
      const transfer = Boolean(upload || request.routeOptions.url?.endsWith("/artifacts"));
      if (request.routeOptions.url !== `${imagingPrefix}/capabilities`) {
        requireImaging(service, 503, "unavailable");
        state.release = service.enter(subject(request), transfer);
      } else if (service?.allowed(subject(request))) state.release = service.enter(subject(request), false);
      if (upload) {
        requireImaging(request.headers["content-type"]?.split(";", 1)[0] === "application/octet-stream");
        requireImaging(!request.headers["transfer-encoding"] && !request.headers["content-encoding"]);
        const length = request.headers["content-length"];
        requireImaging(length && /^[0-9]+$/.test(length));
        requireImaging(Number(length) <= chunkBytes, 413, "size_limit");
      } else if (["POST", "PUT"].includes(request.method)) {
        requireImaging(request.headers["content-type"]?.split(";", 1)[0] === "application/json");
      }
      state.timer = setTimeout(() => request.raw.destroy(), transfer ? 300000 : 20000);
      state.timer.unref();
      reply.raw.once("close", () => {
        state.disconnected = true;
        if (!state.working && !state.streaming) state.release?.();
        clearTimeout(state.timer);
      });
    });
    // Parent authentication can send before this plugin's onRequest; normalize its envelope too.
    app.addHook("onSend", async (request, reply, payload) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      if (reply.statusCode < 400 || typeof payload !== "string") return payload;
      try {
        const original = JSON.parse(payload) as { error?: { code?: string } };
        const code = original.error?.code && /^[a-z0-9_]{1,80}$/.test(original.error.code) ? original.error.code : "unavailable";
        const state = states.get(request); if (state) state.errorCode = code;
        const message = reply.statusCode === 401 ? "Imaging authentication required." : new ImagingError(reply.statusCode, code).message;
        return JSON.stringify({ error: { code, message, retryable: [429, 503].includes(reply.statusCode) }, request_id: request.id });
      } catch { return payload; }
    });
    app.addHook("onResponse", async (request, reply) => {
      const state = states.get(request);
      clearTimeout(state?.timer); state?.release?.();
      if (!service) return;
      const params = request.params as { id?: string } | undefined;
      const id = params?.id && (identifier(params.id, "study") || identifier(params.id, "job")) ? params.id : null;
      try {
        service.store.audit(request.gatewayContext?.subject.id ?? null, request.id, `${request.method} ${request.routeOptions.url ?? imagingPrefix}`,
          id, reply.statusCode, state?.errorCode ?? null, service.now());
      } catch { request.log.warn("Imaging audit write failed."); }
    });
    const route = { config: { skipRateLimit: true, skipObservation: true }, bodyLimit: 16384 } as const;
    const run = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
      const state = states.get(request)!;
      state.working = true;
      try { return await handler(request, reply); }
      finally { state.working = false; if (state.disconnected && !state.streaming) state.release?.(); }
    };
    const id = (r: FastifyRequest) => (r.params as { id: string }).id;
    app.get(`${imagingPrefix}/capabilities`, route, run(async r => service ? service.capabilities(subject(r)) : capabilities(false)));
    for (const [plural, kind] of [["studies", "study"], ["jobs", "job"]] as const) {
      app.post(`${imagingPrefix}/${plural}`, route, run(async (r, reply) => {
        const result = await service!.create(subject(r), kind, r.body, r.headers["idempotency-key"]);
        return reply.code(result.status).send(result.resource);
      }));
      app.get(`${imagingPrefix}/${plural}/:id`, route, run(async r => service!.get(subject(r), kind, id(r))));
    }
    app.get(`${imagingPrefix}/studies/:id/upload`, route, run(async r => service!.uploadStatus(subject(r), id(r))));
    app.put(`${imagingPrefix}/studies/:id/upload/parts/:index`, { ...route, bodyLimit: chunkBytes }, run(async r => {
      requireImaging(r.body instanceof Readable);
      return service!.upload(subject(r), id(r), (r.params as { index: string }).index, r.headers["content-length"], r.headers["x-content-sha256"], r.body, r.gatewayClientDisconnect?.signal);
    }));
    app.post(`${imagingPrefix}/studies/:id/complete`, route, run(async (r, reply) => {
      emptyBody(r.body); return reply.code(202).send(await service!.complete(subject(r), id(r)));
    }));
    app.post(`${imagingPrefix}/jobs/:id/cancel`, route, run(async (r, reply) => {
      emptyBody(r.body); return reply.code(202).send(await service!.cancel(subject(r), id(r)));
    }));
    app.delete(`${imagingPrefix}/studies/:id`, route, run(async (r, reply) => reply.code(202).send(await service!.delete(subject(r), id(r)))));
    app.get(`${imagingPrefix}/jobs/:id/result`, route, run(async r => service!.result(subject(r), id(r))));
    app.get(`${imagingPrefix}/jobs/:id/artifacts`, route, run(async (r, reply) => {
      const result = await service!.artifact(subject(r), id(r), (r.query as { path?: string }).path, r.gatewayClientDisconnect?.signal);
      const state = states.get(r)!; state.streaming = true;
      result.stream.once("close", () => { state.streaming = false; state.release?.(); clearTimeout(state.timer); });
      reply.raw.once("close", () => result.stream.destroy());
      return reply.header("content-type", "application/octet-stream").header("content-length", result.artifact.size)
        .header("x-content-sha256", result.artifact.sha256).send(result.stream);
    }));
    app.all(`${imagingPrefix}/*`, route, run(async () => { throw new ImagingError(404, "not_found"); }));
    app.addHook("onReady", async () => { service?.start(); });
    app.addHook("onClose", async () => { await service?.close(); });
  });
}
function subject(request: FastifyRequest): string {
  requireImaging(request.gatewayContext?.subject.id, 401, "invalid_credential");
  return request.gatewayContext.subject.id;
}
