import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveDocumentWorker } from "./runtime.js";

const prefix = "/gateway/documents/v1";
const maximum = 50 * 1024 * 1024;
const sha = /^[a-f0-9]{64}$/;
const asset = /^[a-f0-9]{24}$/;
const pathPattern = /^\/documents(?:\/[a-f0-9]{64}(?:\/catalog|\/refine|\/select|\/assets\/[a-f0-9]{24}\.png)?)?$/;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
export const isDocumentRoute = (url: string) => url.split("?", 1)[0]!.startsWith(prefix + "/");
type Admission = { release(): void; controller: AbortController; working: boolean; disconnected: boolean };
const fail = (reply: FastifyReply, status: number, code: string) => reply.code(status).send({ error: { code } });

export function registerDocumentRoutes(root: FastifyInstance, env: NodeJS.ProcessEnv) {
  const worker = resolveDocumentWorker(env, root.log);
  const active = new Map<string, number>();
  let total = 0;
  void root.register(async app => {
    const admissions = new WeakMap<FastifyRequest, Admission>();
    app.addContentTypeParser("application/pdf", { parseAs: "buffer", bodyLimit: maximum }, (_request, body, done) => done(null, body));
    app.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store, no-transform").header("x-content-type-options", "nosniff");
      for (const name of Object.keys(request.headers)) {
        if (name.startsWith("x-document-") || name.startsWith("x-service-")) delete request.headers[name];
      }
      const subject = request.gatewayContext?.subject.id;
      if (!subject) return fail(reply, 401, "invalid_credential");
      if (!worker) return fail(reply, 503, "document_service_unavailable");
      const route = request.url.slice(prefix.length);
      if (!pathPattern.test(route)) return fail(reply, 404, "not_found");
      const upload = request.method === "POST" && route === "/documents";
      if (request.headers["content-encoding"] || request.headers["transfer-encoding"])
        return fail(reply, 400, "invalid_document_request");
      if (request.method === "POST") {
        const type = request.headers["content-type"]?.split(";", 1)[0]?.trim();
        if (type !== (upload ? "application/pdf" : "application/json") ||
            (upload && !sha.test(String(request.headers["x-content-sha256"] ?? ""))))
          return fail(reply, 400, upload ? "invalid_pdf_upload" : "invalid_document_request");
      }
      const length = Number(request.headers["content-length"] ?? 0);
      if (length > (upload ? maximum : 8192)) return fail(reply, 413, "request_size_limit");
      // Admit before parsing, so parallel uploads cannot allocate unbounded buffers.
      if (total >= 8 || (active.get(subject) ?? 0) >= 2)
        return fail(reply.header("retry-after", "2"), 429, "document_request_limit");
      total++;
      active.set(subject, (active.get(subject) ?? 0) + 1);
      let released = false;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); if (!state.working) request.raw.destroy(); }, worker.timeoutMs);
      timer.unref();
      const state: Admission = { controller, working: false, disconnected: false, release() {
        if (released) return;
        released = true;
        clearTimeout(timer);
        total--;
        const remaining = (active.get(subject) ?? 1) - 1;
        if (remaining) active.set(subject, remaining); else active.delete(subject);
      } };
      admissions.set(request, state);
      reply.raw.once("close", () => {
        state.disconnected = true;
        controller.abort();
        if (!state.working) state.release();
      });
    });
    app.addHook("onResponse", async request => { admissions.get(request)?.release(); });
    app.setErrorHandler((error, _request, reply) => {
      const code = (error as { code?: string }).code;
      return fail(reply, code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : 400, "invalid_document_request");
    });
    const forward = async (request: FastifyRequest, reply: FastifyReply) => {
      const state = admissions.get(request)!;
      const route = request.url.slice(prefix.length);
      const upload = request.method === "POST" && route === "/documents";
      let body: Uint8Array<ArrayBuffer> | string | undefined;
      if (upload) {
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
            createHash("sha256").update(bytes).digest("hex") !== request.headers["x-content-sha256"])
          return fail(reply, 400, "pdf_signature_or_hash_mismatch");
        body = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
      } else if (request.method === "POST") {
        const args = request.body as { asset_id?: unknown; rows?: unknown; columns?: unknown } | null;
        if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.asset_id !== "string" || !asset.test(args.asset_id))
          return fail(reply, 400, "invalid_asset_id");
        const selection = route.endsWith("/select");
        const indices = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(n => Number.isSafeInteger(n) && n > 0);
        if (selection && (!indices(args.rows) || !indices(args.columns))) return fail(reply, 400, "invalid_selection");
        // Only contract fields are forwarded, even if JSON contains an owner/token.
        body = JSON.stringify({ asset_id: args.asset_id, ...(selection ? { rows: args.rows, columns: args.columns } : {}) });
      }
      state.working = true;
      try {
        const upstream = await fetch(worker!.base + route, {
          method: request.method, redirect: "error",
          headers: {
            authorization: "Bearer " + worker!.token,
            "x-document-owner": createHash("sha256").update("medevidence-documents-v1:subject:" + request.gatewayContext!.subject.id).digest("hex"),
            ...(body === undefined ? {} : { "content-type": upload ? "application/pdf" : "application/json" }),
            ...(upload ? { "x-content-sha256": String(request.headers["x-content-sha256"]) } : {}),
          }, body, signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(worker!.timeoutMs),
            ...(request.gatewayClientDisconnect ? [request.gatewayClientDisconnect.signal] : [])]),
        });
        const png = route.endsWith(".png") && upstream.ok;
        const limit = png ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
        if (Number(upstream.headers.get("content-length")) > limit) {
          await upstream.body?.cancel();
          return fail(reply, 502, "document_response_limit");
        }
        const reader = upstream.body?.getReader();
        if (!reader) return fail(reply, 502, "document_invalid_response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > limit) { await reader.cancel(); return fail(reply, 502, "document_response_limit"); }
          chunks.push(item.value);
        }
        const bytes = Buffer.concat(chunks);
        if (!upstream.ok) {
          const status = [400, 404, 409, 413, 429, 503].includes(upstream.status) ? upstream.status : 502;
          let code = status === 503 ? "document_service_unavailable" : "document_service_failed";
          if (status < 500) {
            try {
              const parsed = JSON.parse(bytes.toString()) as { error?: { code?: string } };
              if (/^[a-z_]{1,80}$/.test(parsed.error?.code ?? "")) code = parsed.error!.code!;
            } catch { /* retain sanitized error */ }
          }
          if (status === 429) reply.header("retry-after", "2");
          return fail(reply, status, code);
        }
        const type = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (png) {
          if (type !== "image/png" || !bytes.subarray(0, 8).equals(pngSignature)) return fail(reply, 502, "document_invalid_response");
        } else {
          if (type !== "application/json") return fail(reply, 502, "document_invalid_response");
          try { JSON.parse(bytes.toString()); } catch { return fail(reply, 502, "document_invalid_response"); }
        }
        return reply.code(upstream.status).header("content-type", png ? "image/png" : "application/json").send(bytes);
      } catch {
        return fail(reply, 503, "document_transport_failed");
      } finally {
        state.working = false;
        if (state.disconnected) state.release();
      }
    };
    const options = { config: { skipRateLimit: true, skipObservation: true }, logLevel: "silent", bodyLimit: 8192 } as const;
    app.post(prefix + "/documents", { ...options, bodyLimit: maximum }, forward);
    for (const route of ["/documents/:id", "/documents/:id/catalog", "/documents/:id/assets/:name"])
      app.get(prefix + route, options, forward);
    for (const route of ["/documents/:id/refine", "/documents/:id/select"])
      app.post(prefix + route, options, forward);
    app.delete(prefix + "/documents/:id", options, forward);
  });
}
