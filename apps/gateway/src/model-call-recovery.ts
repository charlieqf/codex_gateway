import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  SqliteModelCalls,
  type ModelCallResponse,
} from "@codex-gateway/store-sqlite";
import { InMemoryRequestRateLimiter } from "./services/rate-limiter.js";

export const modelCallHeader = "x-medcode-call-id";
export const modelCallContractHeader = "x-medcode-model-call-contract-version";
const pattern = /^(\d{13})_[0-9a-f-]{36}$/;
// Keep this list aligned with model execution/delivery negotiation. Session and
// turn IDs bind the write-delivery manifest, unlike version/message telemetry.
const executionHeaders = new Set([
  "x-medcode-request-timeout-ms",
  "x-medcode-vision-recovery-contract",
  "x-medcode-client-capabilities",
  "x-medcode-client-session-id",
  "x-medcode-client-turn-id",
  "x-medcode-write-delivery-version",
  "x-medcode-write-delivery-schema-sha256",
  "x-medcode-write-delivery-nonce",
  "x-medcode-write-delivery-limits",
]);

export type ModelCallCapture = {
  append(frame: string): void;
  complete(outcome?: "completed" | "failed"): void;
};

declare module "fastify" {
  interface FastifyRequest {
    modelCallCapture?: ModelCallCapture;
  }
}

export function registerModelCallRecovery(
  app: FastifyInstance,
  store: SqliteModelCalls,
  now = Date.now,
) {
  const owner = randomUUID();
  const queries = new InMemoryRequestRateLimiter({
    now: () => new Date(now()),
  });
  const pending = new WeakMap<
    FastifyRequest,
    (response?: ModelCallResponse, outcome?: "completed" | "failed") => void
  >();
  const active = new Set<string>();
  const prune = setInterval(() => {
    try { store.prune(now()); }
    catch { app.log.error("Model call receipt cleanup failed."); }
  }, 60_000);
  prune.unref();
  app.addHook("onClose", async () => clearInterval(prune));
  store.prune(now());

  // Protect DB admission and response replay without holding this short-lived
  // permit during upstream work. In particular, model saturation cannot block GET.
  function acquireReceiptPermit(request: FastifyRequest, reply: FastifyReply) {
    const permit = queries.acquire({
      key: request.gatewayContext!.subject.id,
      scope: "subject",
      policy: { requestsPerMinute: 120, requestsPerDay: 10_000, concurrentRequests: 4 },
    });
    if (!("release" in permit)) {
      reply.code(429)
        .header("retry-after", String(permit.error.retryAfterSeconds ?? 1))
        .send(error("model_call_query_limited"));
      return;
    }
    reply.raw.once("close", permit.release);
    reply.raw.once("finish", permit.release);
    return permit;
  }

  function stateOf(row: NonNullable<ReturnType<SqliteModelCalls["get"]>>, subject: string, scope: string) {
    if (row.expires_at <= now()) return "expired";
    if (row.state === "running" && (row.owner !== owner || !active.has(JSON.stringify([subject, scope, row.id]))))
      return "unknown";
    return row.state;
  }

  app.get<{ Params: { id: string } }>(
    "/gateway/model-calls/:id",
    { config: { skipRateLimit: true } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header(modelCallContractHeader, "1");
      const context = request.gatewayContext;
      if (!context) return reply.code(401).send();
      if (!acquireReceiptPermit(request, reply)) return reply;
      if (!pattern.test(request.params.id)) return reply.code(400).send();
      const row = store.get(
        context.subject.id,
        context.scope,
        request.params.id,
      );
      if (!row) return { version: 1, id: request.params.id, state: "unknown" };
      const state = stateOf(row, context.subject.id, context.scope);
      return {
        version: 1,
        id: row.id,
        state,
        request_id: row.request_id,
        ...((state === "completed" || state === "failed") && row.response_json
          ? { response: JSON.parse(row.response_json) as ModelCallResponse }
          : {}),
      };
    },
  );

  app.addHook("preHandler", async (request, reply) => {
    if (
      request.method !== "POST" ||
      request.routeOptions.url !== "/v1/chat/completions"
    )
      return;
    const id = request.headers[modelCallHeader];
    if (id === undefined) return;
    const match = typeof id === "string" ? pattern.exec(id) : null;
    const context = request.gatewayContext;
    if (!context) return reply.code(401).send();
    const permit = acquireReceiptPermit(request, reply);
    if (!permit) return reply;
    if (!match || typeof id !== "string")
      return reply.code(400).send(error("model_call_invalid"));
    reply.header("cache-control", "no-store");
    // Set raw headers too: setupSseResponse hijacks Fastify serialization.
    for (const [name, value] of [[modelCallHeader, id], [modelCallContractHeader, "1"]]) {
      reply.header(name, value);
      reply.raw.setHeader(name, value);
    }
    // Bind execution semantics, never credentials or pure observation metadata.
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter(
          ([name]) => executionHeaders.has(name),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ body: request.body, headers }, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
          : value))
      .digest("hex");
    const existing = store.get(context.subject.id, context.scope, id);
    if (
      !existing &&
      (now() - Number(match[1]) > 300_000 || Number(match[1]) - now() > 60_000)
    )
      return reply.code(409).send(error("model_call_expired"));
    const admitted =
      !existing &&
      store.admit({
        subject: context.subject.id,
        scope: context.scope,
        id,
        fingerprint,
        request: request.id,
        owner,
        now: now(),
      });
    if (!admitted) {
      const row = existing ?? store.get(context.subject.id, context.scope, id);
      if (row?.fingerprint !== fingerprint)
        return reply.code(409).send(error("model_call_conflict"));
      const state = stateOf(row, context.subject.id, context.scope);
      if (state === "expired") return reply.code(409).send(error("model_call_expired"));
      if (state === "running") return reply.code(409).send(error("model_call_pending"));
      if (state === "unknown" || !row.response_json)
        return reply.code(409).send(error("model_call_unconfirmed"));
      const response = JSON.parse(row.response_json) as ModelCallResponse;
      request.log.info({ request_id: request.id, model_call_id: id,
        original_request_id: row.request_id, state, model_call_replay: true },
        "Model call response replayed.");
      return reply
        .code(response.status)
        .headers(response.headers)
        .send(response.body);
    }
    const key = JSON.stringify([context.subject.id, context.scope, id]);
    let finished = false;
    const frames: string[] = [];
    const finish = (response?: ModelCallResponse, outcome?: "completed" | "failed") => {
      if (finished) return;
      finished = true;
      active.delete(key);
      pending.delete(request);
      frames.length = 0;
      try {
        const state = store.finish(context.subject.id, context.scope, id, response, outcome);
        const fields = { request_id: request.id, model_call_id: id, state };
        if (state === "unknown") request.log.warn(fields, "Model call result is not recoverable.");
        else if (state) request.log.info(fields, "Model call receipt persisted.");
      } catch {
        // Admission is already durable. Do not turn a known response into a
        // truncated stream on a receipt write failure. Inactive running rows
        // query as unknown and still forbid a second model execution.
        request.log.error({ request_id: request.id, model_call_id: id },
          "Model call receipt could not be persisted.");
      }
    };
    active.add(key);
    pending.set(request, finish);
    let bytes = 0;
    request.modelCallCapture = {
      append(frame) {
        if (finished) return;
        bytes += Buffer.byteLength(frame);
        if (bytes <= 8 * 1024 * 1024) frames.push(frame);
        else frames.length = 0;
      },
      complete(outcome = "completed") {
        finish(
          bytes <= 8 * 1024 * 1024
            ? {
                status: reply.raw.statusCode,
                headers: {
                  ...responseHeaders(reply),
                  "x-request-id": request.id,
                },
                body: frames.join(""),
              }
            : undefined,
          outcome,
        );
      },
    };
    reply.raw.once("close", () => finish());
    permit.release();
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const finish = pending.get(request);
    if (finish && (typeof payload === "string" || Buffer.isBuffer(payload))) {
      finish({
        status: reply.statusCode,
        headers: responseHeaders(reply),
        body: payload.toString(),
      });
    }
    return payload;
  });
}

function responseHeaders(reply: FastifyReply) {
  return Object.fromEntries(
    Object.entries({ ...reply.getHeaders(), ...reply.raw.getHeaders() })
      .filter(
        ([name, value]) =>
          value !== undefined &&
          (name.startsWith("x-medcode-") ||
            [
              "content-type",
              "x-request-id",
              "retry-after",
              "retry-after-ms",
              "x-gateway-limit-kind",
              "x-gateway-rate-limit-origin",
            ].includes(name)),
      )
      .map(([name, value]) => [name, String(value)]),
  );
}

function error(code: string) {
  const messages: Record<string, string> = {
    model_call_invalid: "Invalid model call ID; expected a millisecond timestamp and UUID.",
    model_call_conflict: "This model call ID is bound to a different execution request.",
    model_call_expired: "This model call has expired or its timestamp is outside the admission window; it was not executed again.",
    model_call_pending: "The original model call is still running. Query its result before continuing.",
    model_call_unconfirmed: "The original model call cannot be confirmed. It was not executed again.",
    model_call_query_limited: "Model call receipt traffic is limited. Wait for Retry-After before querying again.",
  };
  return {
    error: {
      code,
      message: messages[code] ?? "The original model call must be confirmed before continuing.",
      retry_contract_version: 1,
      automatic_retry_allowed: false,
    },
  };
}
