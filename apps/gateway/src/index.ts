import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  GatewayError,
  type GatewaySession,
  type ProviderAdapter,
  type Subject,
  type Subscription
} from "@codex-gateway/core";
import { CodexProviderAdapter } from "@codex-gateway/provider-codex";
import { InMemorySessionStore } from "./services/session-store.js";

export interface GatewayOptions {
  accessToken?: string;
  provider?: ProviderAdapter;
  sessionStore?: InMemorySessionStore;
  subject?: Subject;
  subscription?: Subscription;
  logger?: boolean;
}

interface MessageBody {
  message?: unknown;
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const accessToken = options.accessToken ?? process.env.GATEWAY_DEV_ACCESS_TOKEN;
  const subject = options.subject ?? defaultSubject();
  const subscription = options.subscription ?? defaultSubscription();
  const provider =
    options.provider ??
    new CodexProviderAdapter({
      codexHome: process.env.CODEX_HOME ?? ".gateway-state/codex-home",
      workingDirectory: process.env.CODEX_WORKDIR ?? process.cwd(),
      skipGitRepoCheck: process.env.CODEX_SKIP_GIT_REPO_CHECK === "1"
    });
  const sessions = options.sessionStore ?? new InMemorySessionStore();

  app.get("/gateway/health", async () => ({
    state: "ready",
    service: "codex-gateway",
    phase: "phase-1-dev-gateway"
  }));

  app.get("/gateway/status", async (request, reply) => {
    const auth = authenticate(request, accessToken);
    if (auth) return sendError(reply, auth);

    const health = await provider.health(subscription);

    return {
      state: health.state === "healthy" ? "ready" : health.state,
      subject: {
        id: subject.id,
        label: subject.label
      },
      credential: {
        prefix: "dev",
        scope: "code",
        expires_at: null
      },
      subscription: {
        id: subscription.id,
        provider: subscription.provider,
        state: health.state,
        detail: health.detail
      }
    };
  });

  app.get("/sessions", async (request, reply) => {
    const auth = authenticate(request, accessToken);
    if (auth) return sendError(reply, auth);

    return {
      sessions: sessions.list(subject.id).map(serializeSession)
    };
  });

  app.post("/sessions", async (request, reply) => {
    const auth = authenticate(request, accessToken);
    if (auth) return sendError(reply, auth);

    const session = sessions.create({
      subjectId: subject.id,
      subscriptionId: subscription.id
    });

    reply.code(201);
    return {
      session: serializeSession(session)
    };
  });

  app.post<{ Params: { id: string }; Body: MessageBody }>(
    "/sessions/:id/messages",
    async (request, reply) => {
      const auth = authenticate(request, accessToken);
      if (auth) return sendError(reply, auth);

      const session = sessions.get(request.params.id);
      if (!session || session.subjectId !== subject.id) {
        return sendError(
          reply,
          new GatewayError({
            code: "session_not_found",
            message: "会话不存在，或不属于当前 subject。",
            httpStatus: 404
          })
        );
      }

      const message = request.body?.message;
      if (typeof message !== "string" || message.length === 0) {
        return sendError(
          reply,
          new GatewayError({
            code: "service_unavailable",
            message: "message must be a non-empty string.",
            httpStatus: 400
          })
        );
      }

      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache");
      reply.raw.setHeader("connection", "keep-alive");
      reply.hijack();

      for await (const event of provider.message({
        subscription,
        subject,
        scope: "code",
        session,
        message
      })) {
        if (event.type === "completed" && event.providerSessionRef) {
          sessions.setProviderSessionRef(session.id, event.providerSessionRef);
        }
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      reply.raw.end();
    }
  );

  return app;
}

async function main() {
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.GATEWAY_PORT ?? "8787", 10);
  const app = buildGateway();
  await app.listen({ host, port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

function authenticate(
  request: FastifyRequest,
  accessToken: string | undefined
): GatewayError | null {
  if (!accessToken) {
    return new GatewayError({
      code: "service_unavailable",
      message: "Gateway dev access token is not configured.",
      httpStatus: 503
    });
  }

  const authorization = request.headers.authorization;
  if (!authorization) {
    return new GatewayError({
      code: "missing_credential",
      message: "缺少访问凭据。",
      httpStatus: 401
    });
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || token !== accessToken) {
    return new GatewayError({
      code: "invalid_credential",
      message: "访问凭据无效。",
      httpStatus: 401
    });
  }

  return null;
}

function sendError(reply: FastifyReply, error: GatewayError) {
  reply.code(error.httpStatus);
  return {
    error: {
      code: error.code,
      message: error.message,
      retry_after_seconds: error.retryAfterSeconds
    }
  };
}

function defaultSubject(): Subject {
  return {
    id: "subj_dev",
    label: "dev-subject",
    state: "active",
    createdAt: new Date()
  };
}

function defaultSubscription(): Subscription {
  return {
    id: "sub_openai_codex_dev",
    provider: "openai-codex",
    label: "OpenAI Codex dev subscription",
    credentialRef: "CODEX_HOME",
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

function serializeSession(session: GatewaySession) {
  return {
    id: session.id,
    subject_id: session.subjectId,
    subscription_id: session.subscriptionId,
    provider_session_ref: session.providerSessionRef,
    title: session.title,
    state: session.state,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString()
  };
}
