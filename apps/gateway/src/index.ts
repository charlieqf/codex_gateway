import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import {
  GatewayError,
  type GatewaySession,
  type GatewayStore,
  type ProviderAdapter,
  type Subject,
  type Subscription
} from "@codex-gateway/core";
import { CodexProviderAdapter } from "@codex-gateway/provider-codex";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { devAuthHook } from "./http/auth.js";
import { getGatewayContext, type GatewayRequest } from "./http/context.js";
import { InMemorySessionStore } from "./services/session-store.js";

export interface GatewayOptions {
  accessToken?: string;
  provider?: ProviderAdapter;
  sessionStore?: GatewayStore;
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
  const sessions = options.sessionStore ?? createDefaultSessionStore();
  sessions.upsertSubject(subject);
  sessions.upsertSubscription(subscription);
  const devContext = {
    subject,
    subscription,
    provider,
    scope: "code" as const,
    credential: {
      prefix: "dev"
    }
  };

  app.addHook("onClose", async () => {
    sessions.close?.();
  });

  app.addHook("onRequest", async (request, reply) =>
    devAuthHook(request, reply, {
      accessToken,
      context: devContext
    })
  );

  app.get(
    "/gateway/health",
    {
      config: { public: true }
    },
    async () => ({
      state: "ready",
      service: "codex-gateway",
      phase: "phase-1-dev-gateway"
    })
  );

  app.get("/gateway/status", async (request) => {
    const { subject, subscription, provider, scope, credential } = getGatewayContext(request);
    const health = await provider.health(subscription);

    return {
      state: health.state === "healthy" ? "ready" : health.state,
      subject: {
        id: subject.id,
        label: subject.label
      },
      credential: {
        prefix: credential.prefix,
        scope,
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

  app.get("/sessions", async (request) => {
    const { subject } = getGatewayContext(request);
    return {
      sessions: sessions.list(subject.id).map(serializeSession)
    };
  });

  app.post("/sessions", async (request, reply) => {
    const { subject, subscription } = getGatewayContext(request);
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
      const { subject, subscription, provider, scope } = getGatewayContext(request);

      const session = sessions.get(request.params.id);
      if (!session || session.subjectId !== subject.id) {
        return sendError(
          reply,
          new GatewayError({
            code: "session_not_found",
            message: "Session does not exist or does not belong to the current subject.",
            httpStatus: 404
          })
        );
      }

      const message = request.body?.message;
      if (typeof message !== "string" || message.length === 0) {
        return sendError(
          reply,
          new GatewayError({
            code: "invalid_request",
            message: "message must be a non-empty string.",
            httpStatus: 400
          })
        );
      }

      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache");
      reply.raw.setHeader("connection", "keep-alive");
      reply.hijack();

      const abort = new AbortController();
      let closed = false;
      const close = () => {
        closed = true;
        abort.abort();
      };
      reply.raw.on("close", close);
      const heartbeat = setInterval(() => {
        writeSseComment(reply, "ping");
      }, 25_000);
      heartbeat.unref?.();

      try {
        for await (const event of provider.message({
          subscription,
          subject,
          scope,
          session,
          message,
          signal: abort.signal
        })) {
          if (closed) {
            break;
          }
          if (event.type === "completed" && event.providerSessionRef) {
            sessions.setProviderSessionRef(session.id, event.providerSessionRef);
          }
          if (!writeSseEvent(reply, event.type, event)) {
            abort.abort();
            break;
          }
        }
      } finally {
        clearInterval(heartbeat);
        reply.raw.off("close", close);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
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

function createDefaultSessionStore(): GatewayStore {
  const sqlitePath = process.env.GATEWAY_SQLITE_PATH;
  if (sqlitePath) {
    return createSqliteStore({ path: sqlitePath });
  }

  return new InMemorySessionStore();
}
