import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ImagingError, sha256 } from "../imaging/contract.js";
import { capabilities, chunkBytes, ClinicalError, identifier, object, prefix, requireClinical, type Mode } from "./contract.js";
import type { ClinicalService } from "./service.js";

type State = { release?: () => void; timer?: NodeJS.Timeout; working: boolean; disconnected: boolean; streaming: boolean; errorCode: string | null };
export const isClinicalRoute = (url: string) => /^\/gateway\/(?:imaging|aipal|panecho)\/v1(?:\/|$)/.test(url.split("?", 1)[0]!);
export function registerClinicalRoutes(root: FastifyInstance, mode: Mode, service: ClinicalService | null) {
  const base = prefix(mode);
  void root.register(async app => {
    const states = new WeakMap<FastifyRequest, State>();
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    app.setErrorHandler((error: unknown, request, reply) => {
      const original = error as { code?: string; statusCode?: number };
      const safe = error instanceof ImagingError ? new ClinicalError(error.status, error.code) : original.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new ClinicalError(413, "size_limit")
        : original.statusCode && original.statusCode < 500 ? new ClinicalError(400, "invalid_request") : new ClinicalError(503, "unavailable");
      const state = states.get(request); if (state) state.errorCode = safe.code;
      reply.code(safe.status).send({ error: { code: safe.code, message: safe.message, retryable: safe.retryable }, request_id: request.id });
    });
    app.addHook("onRequest", async (r, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache").header("x-content-type-options", "nosniff");
      for (const h of Object.keys(r.headers)) if (h.startsWith("x-clinical-") || h.startsWith("x-imaging-") || h.startsWith("x-service-")) delete r.headers[h];
      const state: State = { working: false, disconnected: false, streaming: false, errorCode: null }; states.set(r, state);
      const upload = r.method === "PUT" && r.routeOptions.url?.endsWith("/input/parts/:index");
      const transfer = Boolean(upload || r.routeOptions.url?.endsWith("/artifacts/:name") || r.routeOptions.url?.endsWith("/source"));
      if (r.routeOptions.url !== `${base}/capabilities`) { requireClinical(service, 503, "unavailable"); state.release = service.enter(subject(r), transfer); }
      else if (service?.allowed(subject(r))) state.release = service.enter(subject(r), false);
      if (upload) {
        requireClinical(r.headers["content-type"]?.split(";", 1)[0] === "application/octet-stream" && !r.headers["transfer-encoding"] && !r.headers["content-encoding"]);
        requireClinical(typeof r.headers["content-length"] === "string" && /^[0-9]+$/.test(r.headers["content-length"]));
        requireClinical(Number(r.headers["content-length"]) <= chunkBytes, 413, "size_limit");
      } else if (["POST", "PUT"].includes(r.method)) requireClinical(r.headers["content-type"]?.split(";", 1)[0] === "application/json");
      state.timer = setTimeout(() => r.raw.destroy(), transfer ? 300000 : 20000); state.timer.unref();
      reply.raw.once("close", () => { state.disconnected = true; if (!state.working && !state.streaming) state.release?.(); clearTimeout(state.timer); });
    });
    app.addHook("onSend", async (r, reply, payload) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      if (reply.statusCode < 400 || typeof payload !== "string") return payload;
      try {
        const original = JSON.parse(payload) as { error?: { code?: string } }, code = original.error?.code && /^[a-z0-9_]{1,80}$/.test(original.error.code) ? original.error.code : "unavailable";
        const state = states.get(r); if (state) state.errorCode = code;
        return JSON.stringify({ error: { code, message: reply.statusCode === 401 ? "Clinical authentication required." : new ClinicalError(reply.statusCode, code).message, retryable: [429, 503].includes(reply.statusCode) }, request_id: r.id });
      } catch { return payload; }
    });
    app.addHook("onResponse", async (r, reply) => {
      const state = states.get(r); clearTimeout(state?.timer); state?.release?.(); if (!service) return;
      const id = (r.params as { id?: string } | undefined)?.id;
      try { service.store.audit(r.gatewayContext?.subject.id ?? null, r.id, `${r.method} ${r.routeOptions.url ?? base}`, identifier(id) ? id : null, reply.statusCode, state?.errorCode ?? null, service.now()); }
      catch { r.log.warn("Clinical audit write failed."); }
    });
    const route = { config: { skipRateLimit: true, skipObservation: true }, bodyLimit: 16384 } as const;
    const run = (handler: (r: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (r: FastifyRequest, reply: FastifyReply) => {
      const state = states.get(r)!; state.working = true;
      try { return await handler(r, reply); } finally { state.working = false; if (state.disconnected && !state.streaming) state.release?.(); }
    };
    const id = (r: FastifyRequest) => (r.params as { id: string }).id;
    const empty = (r: FastifyRequest) => requireClinical(Object.keys(object(r.body)).length === 0);
    app.get(`${base}/capabilities`, route, run(async r => service ? service.capabilities(subject(r)) : capabilities(mode, false)));
    app.post(`${base}/jobs`, route, run(async (r, reply) => { const result = await service!.create(subject(r), r.body, r.headers["idempotency-key"]); return reply.code(result.status).send(result.job); }));
    app.get(`${base}/jobs/:id`, route, run(async r => service!.get(subject(r), id(r))));
    app.post(`${base}/jobs/:id/cancel`, route, run(async (r, reply) => { empty(r); return reply.code(202).send(await service!.action(subject(r), id(r), "cancel")); }));
    app.delete(`${base}/jobs/:id`, route, run(async (r, reply) => reply.code(202).send(await service!.action(subject(r), id(r), "delete"))));
    if (mode === "panecho") {
      app.get(`${base}/jobs/:id/input`, route, run(async r => service!.inputStatus(subject(r), id(r))));
      app.put(`${base}/jobs/:id/input/parts/:index`, { ...route, bodyLimit: chunkBytes }, run(async r => {
        requireClinical(r.body instanceof Readable); return service!.upload(subject(r), id(r), (r.params as { index: string }).index, r.headers["content-length"], r.headers["x-chunk-sha256"], r.body, r.gatewayClientDisconnect?.signal);
      }));
      app.post(`${base}/jobs/:id/input/complete`, route, run(async (r, reply) => { empty(r); return reply.code(202).send(await service!.action(subject(r), id(r), "complete")); }));
    }
    app.get(`${base}/jobs/:id/result`, route, run(async r => service!.result(subject(r), id(r))));
    app.get(`${base}/jobs/:id/artifacts/:name`, route, run(async (r, reply) => {
      const result = await service!.artifact(subject(r), id(r), (r.params as { name: string }).name, r.gatewayClientDisconnect?.signal);
      const state = states.get(r)!; state.streaming = true;
      result.stream.once("close", () => { state.streaming = false; state.release?.(); clearTimeout(state.timer); });
      reply.raw.once("close", () => result.stream.destroy());
      return reply.header("content-type", "application/octet-stream").header("content-length", result.artifact.size).header("x-content-sha256", result.artifact.sha256).send(result.stream);
    }));
    app.get(`${base}/source`, route, run(async (r, reply) => { const bytes = await service!.source(subject(r), r.gatewayClientDisconnect?.signal); return reply.header("content-type", "application/zip").header("content-length", bytes.length).header("x-content-sha256", sha256(bytes)).send(bytes); }));
    app.all(`${base}/*`, route, run(async () => { throw new ClinicalError(404, "not_found"); }));
    app.addHook("onReady", async () => service?.start()); app.addHook("onClose", async () => { await service?.close(); });
  });
}
function subject(r: FastifyRequest) { requireClinical(r.gatewayContext?.subject.id, 401, "invalid_credential"); return r.gatewayContext.subject.id; }
