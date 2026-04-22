import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import {
  type CredentialAuthStore,
  GatewayError,
  type GatewaySession,
  type GatewayStore,
  type ProviderAdapter,
  type Subject,
  type Subscription
} from "@codex-gateway/core";
import { CodexProviderAdapter } from "@codex-gateway/provider-codex";
import { createSqliteStore } from "@codex-gateway/store-sqlite";
import { credentialAuthHook, devAuthHook } from "./http/auth.js";
import { getGatewayContext } from "./http/context.js";
import { rateLimitHook, releaseRateLimit } from "./http/rate-limit.js";
import {
  InMemoryCredentialRateLimiter,
  type CredentialRateLimiter
} from "./services/rate-limiter.js";
import { InMemorySessionStore } from "./services/session-store.js";

export type GatewayAuthMode = "dev" | "credential";

export interface GatewayOptions {
  accessToken?: string;
  authMode?: GatewayAuthMode;
  credentialStore?: CredentialAuthStore;
  provider?: ProviderAdapter;
  sessionStore?: GatewayStore;
  subject?: Subject;
  subscription?: Subscription;
  rateLimiter?: CredentialRateLimiter;
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
  const credentialStore =
    options.credentialStore ?? (isCredentialAuthStore(sessions) ? sessions : undefined);
  const configuredAuthMode = options.authMode ?? parseAuthMode(process.env.GATEWAY_AUTH_MODE);
  const authMode = resolveAuthMode({
    configured: configuredAuthMode,
    accessToken,
    credentialStore
  });
  validateAuthModeForEnvironment(authMode, process.env.NODE_ENV);
  const rateLimiter = options.rateLimiter ?? new InMemoryCredentialRateLimiter();
  sessions.upsertSubject(subject);
  sessions.upsertSubscription(subscription);
  const devContext = {
    subject,
    subscription,
    provider,
    scope: "code" as const,
    credential: {
      id: null,
      prefix: "dev",
      label: "Development token",
      expiresAt: null,
      rate: null
    }
  };

  app.addHook("onClose", async () => {
    sessions.close?.();
  });

  if (authMode === "dev") {
    app.log.warn({ auth_mode: authMode }, "Gateway running in dev auth mode.");
  } else if (accessToken && credentialStore && !configuredAuthMode) {
    app.log.warn(
      { auth_mode: authMode },
      "Gateway credential auth mode selected; GATEWAY_DEV_ACCESS_TOKEN is ignored."
    );
  }

  if (authMode === "credential") {
    if (!credentialStore) {
      throw new Error("Credential auth mode requires a credential store.");
    }
    app.addHook("onRequest", async (request, reply) =>
      credentialAuthHook(request, reply, {
        store: credentialStore,
        provider,
        subscription
      })
    );
  } else {
    app.addHook("onRequest", async (request, reply) =>
      devAuthHook(request, reply, {
        accessToken,
        context: devContext
      })
    );
  }

  app.addHook("preHandler", async (request, reply) =>
    rateLimitHook(request, reply, rateLimiter)
  );

  app.addHook("onResponse", async (request) => {
    releaseRateLimit(request);
  });

  app.get(
    "/gateway/health",
    {
      config: { public: true }
    },
    async () => ({
      state: "ready",
      service: "codex-gateway",
      auth_mode: authMode,
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
        expires_at: credential.expiresAt?.toISOString() ?? null,
        rate: credential.rate
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
        releaseRateLimit(request);
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

function parseAuthMode(value: string | undefined): GatewayAuthMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "dev" || value === "credential") {
    return value;
  }
  throw new Error("GATEWAY_AUTH_MODE must be dev or credential.");
}

function resolveAuthMode(input: {
  configured?: GatewayAuthMode;
  accessToken?: string;
  credentialStore?: CredentialAuthStore;
}): GatewayAuthMode {
  if (input.configured) {
    return input.configured;
  }
  if (input.credentialStore) {
    return "credential";
  }
  return "dev";
}

function validateAuthModeForEnvironment(authMode: GatewayAuthMode, nodeEnv: string | undefined) {
  if (nodeEnv === "production" && authMode === "dev") {
    throw new Error("Dev auth mode is not allowed when NODE_ENV=production.");
  }
}

function isCredentialAuthStore(store: GatewayStore): store is GatewayStore & CredentialAuthStore {
  const candidate = store as Partial<CredentialAuthStore>;
  return (
    typeof candidate.getSubject === "function" &&
    typeof candidate.getAccessCredentialByPrefix === "function" &&
    typeof candidate.listAccessCredentials === "function" &&
    typeof candidate.revokeAccessCredentialByPrefix === "function" &&
    typeof candidate.setAccessCredentialExpiresAtByPrefix === "function"
  );
}
