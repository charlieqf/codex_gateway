import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GatewayError, isRecord, publicTokenCreditEvent, publicTokenCreditWallet, validateTokenCreditGrant,
  type TokenCreditStore, type GrantTokenCreditsInput
} from "@codex-gateway/core";

interface Options {
  store?: TokenCreditStore;
  now: () => Date;
  preflight: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | null;
  sendError: (request: FastifyRequest, reply: FastifyReply, error: unknown) => FastifyReply;
  securityHeaders: (reply: FastifyReply) => FastifyReply;
}

const creditEventFields = new Set([
  "subject_id", "provider", "external_event_id", "external_order_id", "event_type", "tokens", "reason"
]);

function parseCreditGrant(request: FastifyRequest, now: Date): GrantTokenCreditsInput {
  const body = request.body;
  if (!isRecord(body)) {
    throw new GatewayError({ code: "invalid_request", httpStatus: 400, message: "A JSON object is required." });
  }
  if (Object.keys(body).some(key => !creditEventFields.has(key))) {
    throw new GatewayError({ code: "invalid_request", httpStatus: 400, message: "Unsupported credit event field." });
  }
  const input = {
    idempotencyKey: request.headers["idempotency-key"],
    subjectId: body.subject_id,
    provider: body.provider,
    externalEventId: body.external_event_id,
    externalOrderId: body.external_order_id,
    eventType: body.event_type,
    tokens: body.tokens,
    reason: body.reason,
    now
  };
  validateTokenCreditGrant(input);
  return input;
}

export function registerBillingTokenCreditRoutes(app: FastifyInstance, options: Options): void {
  const root = "/gateway/admin/billing/v1";
  const routeOptions = { config: { public: true, skipRateLimit: true, skipObservation: true } };
  const store = () => {
    if (!options.store) throw new GatewayError({ code: "service_unavailable", httpStatus: 503, message: "Billing store is not configured." });
    return options.store;
  };
  app.post<{ Body: unknown }>(`${root}/token-credit-events`, routeOptions, async (request, reply) => {
    const auth = options.preflight(request, reply);
    if (auth) return auth;
    try {
      const result = store().grantTokenCredits(parseCreditGrant(request, options.now()));
      return options.securityHeaders(reply).send({ applied: true, idempotent_replay: result.idempotentReplay,
        credit_event: publicTokenCreditEvent(result.event), token_credits: publicTokenCreditWallet(result.wallet) });
    } catch (error) { return options.sendError(request, reply, error); }
  });
  app.get<{ Params: { idempotencyKey: string } }>(`${root}/token-credit-events/:idempotencyKey`, routeOptions, async (request, reply) => {
    const auth = options.preflight(request, reply);
    if (auth) return auth;
    try {
      const event = store().getTokenCreditEvent(request.params.idempotencyKey);
      if (!event) throw new GatewayError({ code: "token_credit_event_not_found", httpStatus: 404, message: "Token credit event was not found." });
      return options.securityHeaders(reply).send({ credit_event: publicTokenCreditEvent(event) });
    } catch (error) { return options.sendError(request, reply, error); }
  });
  app.get<{ Params: { subjectId: string } }>(`${root}/users/:subjectId/token-credits`, routeOptions, async (request, reply) => {
    const auth = options.preflight(request, reply);
    if (auth) return auth;
    try {
      return options.securityHeaders(reply).send({ token_credits: publicTokenCreditWallet(store().getTokenCreditWallet(request.params.subjectId, options.now())) });
    } catch (error) { return options.sendError(request, reply, error); }
  });
  app.get<{ Params: { subjectId: string }; Querystring: { limit?: string; cursor?: string } }>(
    `${root}/users/:subjectId/token-credit-events`, routeOptions, async (request, reply) => {
      const auth = options.preflight(request, reply);
      if (auth) return auth;
      try {
        const result = store().listTokenCreditEvents({ subjectId: request.params.subjectId,
          limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor });
        return options.securityHeaders(reply).send({ subject_id: request.params.subjectId,
          credit_events: result.events.map(publicTokenCreditEvent), next_cursor: result.nextCursor });
      } catch (error) { return options.sendError(request, reply, error); }
    });
}
