import {
  GatewayError,
  type GatewayStore,
  type ProviderAdapter,
  type UpstreamAccount
} from "@codex-gateway/core";
import { CodexProviderAdapter } from "@codex-gateway/provider-codex";
import {
  accountFromPoolConfig,
  applyStartupAuthState,
  readUpstreamAccountPoolConfigFile,
  UpstreamAccountRouter,
  type UpstreamAccountCooldownConfig,
  type UpstreamAccountConfigLogger,
  type UpstreamAccountLease,
  type UpstreamAccountOutcome,
  type ParsedUpstreamAccountConfig,
  type UpstreamAccountRuntimeInput,
  type UpstreamSoftAffinity
} from "../services/upstream-account-router.js";
import { quotaCooldownMs } from "../services/provider-quota-circuit.js";
import {
  publicModelPoolMemberAdapterKey,
  type PublicModelConfig,
  type PublicModelPoolMemberConfig,
  type PublicModelPoolRuntimeKind
} from "../services/public-model-registry.js";
import type { GatewayOptions } from "../gateway-options.js";
import { createImageProviderForAccount } from "./image-providers.js";
import { defaultUpstreamAccount } from "./gateway-state.js";
import { parseModelReasoningEffort } from "./env.js";
import type { OpenAICompatibleAdapterMap } from "./chat-providers.js";
import type { StrictClientToolsLogger } from "../services/client-tool-types.js";

interface ResolvedUpstreamAccountPool {
  runtimes: UpstreamAccountRuntimeInput[];
  softAffinity: UpstreamSoftAffinity;
  cooldown: UpstreamAccountCooldownConfig;
  accountPoolConfigured: boolean;
}

type PublicModelPoolRouters = Map<string, UpstreamAccountRouter>;

export function resolveUpstreamAccountPool(
  options: GatewayOptions,
  env: NodeJS.ProcessEnv,
  store: GatewayStore,
  logger: UpstreamAccountConfigLogger
): ResolvedUpstreamAccountPool {
  if (options.upstreamAccounts) {
    return {
      runtimes: options.upstreamAccounts,
      softAffinity: "credential",
      cooldown: defaultUpstreamCooldown(),
      accountPoolConfigured: true
    };
  }

  if (env.GATEWAY_UPSTREAM_ACCOUNTS_JSON) {
    const pool = readUpstreamAccountPoolConfigFile(env.GATEWAY_UPSTREAM_ACCOUNTS_JSON, {
      nodeEnv: env.NODE_ENV,
      logger
    });
    return {
      runtimes: pool.accounts.map((config) => {
        const upstreamAccount = applyStartupAuthState(
          resolveConfiguredUpstreamAccount(config, store),
          config,
          {
            validateAuthFiles: env.NODE_ENV === "production"
          }
        );
        return {
          upstreamAccount,
          provider: createCodexProvider(env, config.codexHome),
          imageProvider: createImageProviderForAccount(config, env, logger),
          enabled: config.enabled,
          weight: config.weight,
          maxConcurrent: config.maxConcurrent
        };
      }),
      softAffinity: pool.selection.softAffinity,
      cooldown: pool.cooldown,
      accountPoolConfigured: true
    };
  }

  const codexHome = env.CODEX_HOME ?? ".gateway-state/codex-home";
  return {
    runtimes: [
      {
        upstreamAccount: options.upstreamAccount ?? defaultUpstreamAccount(),
        provider: options.provider ?? createCodexProvider(env, codexHome)
      }
    ],
    softAffinity: "credential",
    cooldown: defaultUpstreamCooldown(),
    accountPoolConfigured: false
  };
}

function resolveConfiguredUpstreamAccount(
  config: ParsedUpstreamAccountConfig,
  store: GatewayStore
): UpstreamAccount {
  const configured = accountFromPoolConfig(config);
  const existing = getStoredUpstreamAccount(store, config.id);
  if (!existing) {
    return configured;
  }
  return {
    ...configured,
    imageApiKeyEnv: configured.imageApiKeyEnv,
    state: existing.state,
    lastUsedAt: existing.lastUsedAt,
    cooldownUntil: existing.cooldownUntil
  };
}

function getStoredUpstreamAccount(store: GatewayStore, id: string): UpstreamAccount | null {
  const candidate = store as Partial<{
    getUpstreamAccount: (id: string) => UpstreamAccount | null;
  }>;
  return candidate.getUpstreamAccount?.(id) ?? null;
}

export function persistUpstreamAccountRuntimeState(
  store: GatewayStore,
  account: UpstreamAccount,
  logger: UpstreamAccountConfigLogger
): void {
  const candidate = store as Partial<{
    updateUpstreamAccountRuntimeState: (
      id: string,
      input: {
        state: UpstreamAccount["state"];
        lastUsedAt: Date | null;
        cooldownUntil: Date | null;
      }
    ) => UpstreamAccount | null;
  }>;
  try {
    candidate.updateUpstreamAccountRuntimeState?.(account.id, {
      state: account.state,
      lastUsedAt: account.lastUsedAt,
      cooldownUntil: account.cooldownUntil
    });
  } catch (err) {
    logger.warn?.(
      {
        upstream_account_id: account.id,
        error: err instanceof Error ? err.message : String(err)
      },
      "Failed to persist upstream account runtime state."
    );
  }
}

function defaultUpstreamCooldown(): UpstreamAccountCooldownConfig {
  return {
    rateLimitSeconds: 120,
    reauthSeconds: 900,
    serviceErrorSeconds: 30
  };
}

function createCodexProvider(env: NodeJS.ProcessEnv, codexHome: string): ProviderAdapter {
  return new CodexProviderAdapter({
    codexHome,
    codexPath: env.CODEX_GATEWAY_CODEX_PATH,
    model: env.MEDCODE_UPSTREAM_MODEL,
    modelReasoningEffort: parseModelReasoningEffort(env.MEDCODE_UPSTREAM_REASONING_EFFORT),
    workingDirectory: env.CODEX_WORKDIR ?? process.cwd(),
    skipGitRepoCheck: env.CODEX_SKIP_GIT_REPO_CHECK === "1"
  });
}

export function createPublicModelPoolRouters(
  models: PublicModelConfig[],
  adaptersByRuntime: Record<PublicModelPoolRuntimeKind, OpenAICompatibleAdapterMap>,
  now: () => Date,
  log: StrictClientToolsLogger
): PublicModelPoolRouters {
  const routers: PublicModelPoolRouters = new Map();
  for (const model of models) {
    if (!model.enabled || model.runtime !== "pool" || !model.pool) {
      continue;
    }
    const runtimes: UpstreamAccountRuntimeInput[] = [];
    for (const member of model.pool.members) {
      if (!member.enabled) {
        continue;
      }
      const adapter = adaptersByRuntime[member.runtime].get(member.id);
      if (!adapter) {
        continue;
      }
      runtimes.push({
        upstreamAccount: poolMemberUpstreamAccount(model, member),
        provider: adapter,
        enabled: true,
        maxConcurrent: member.maxConcurrent ?? null
      });
    }
    if (runtimes.length > 0) {
      routers.set(
        model.id,
        new UpstreamAccountRouter(runtimes, {
          onQuotaStateChanged: (accountId, state) => log.info({
            public_model_id: model.id, upstream_account_id: accountId, quota_circuit: state
          }, "Provider quota circuit state changed."),
          quotaCooldownMs: model.id === "goldencode" && model.pool.members.every((m) => m.runtime === "tencent" || m.runtime === "tiankuan")
            ? quotaCooldownMs(process.env.GATEWAY_GOLDENCODE_QUOTA_COOLDOWN_SECONDS) : undefined,
          softAffinity: "credential",
          cooldown: defaultUpstreamCooldown(),
          now
        })
      );
    }
  }
  return routers;
}

function poolMemberUpstreamAccount(
  model: PublicModelConfig,
  member: PublicModelPoolMemberConfig
): UpstreamAccount {
  return {
    id: member.id,
    provider: member.runtime,
    label: `${model.displayName} ${member.runtime}`,
    credentialRef: `PUBLIC_MODEL_POOL:${model.id}:${member.id}`,
    state: "active",
    lastUsedAt: null,
    cooldownUntil: null
  };
}

export function poolMemberAdapterKeys(
  adaptersByRuntime: Record<PublicModelPoolRuntimeKind, OpenAICompatibleAdapterMap>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [runtime, adapterMap] of Object.entries(adaptersByRuntime) as Array<
    [PublicModelPoolRuntimeKind, OpenAICompatibleAdapterMap]
  >) {
    for (const id of adapterMap.keys()) {
      ids.add(publicModelPoolMemberAdapterKey(runtime, id));
    }
  }
  return ids;
}

export function assertUpstreamPoolAvailable(
  router: UpstreamAccountRouter,
  env: NodeJS.ProcessEnv
): void {
  if (env.NODE_ENV !== "production" || env.GATEWAY_ALLOW_EMPTY_UPSTREAM_POOL === "1") {
    return;
  }
  const selection = router.selectForNewSession();
  if (selection instanceof GatewayError) {
    throw new Error(`Production runtime has no available upstream account: ${selection.message}`);
  }
}

function upstreamOutcomeFromError(error: GatewayError): UpstreamAccountOutcome | null {
  if (error.code === "provider_reauth_required") {
    return "provider_reauth_required";
  }
  if (error.code === "rate_limited") {
    return "rate_limited";
  }
  if (
    error.code === "service_unavailable" ||
    error.code === "upstream_unavailable" ||
    error.code === "upstream_timeout" ||
    error.code === "upstream_incomplete_stream" ||
    error.code === "upstream_empty_response"
  ) {
    return "service_error";
  }
  return null;
}

export function isStatelessRetryableProviderError(error: GatewayError): boolean {
  return upstreamOutcomeFromError(error) !== null;
}

export function recordUpstreamErrorOutcome(
  router: UpstreamAccountRouter,
  lease: UpstreamAccountLease,
  error: GatewayError
): boolean {
  const outcome = upstreamOutcomeFromError(error);
  if (outcome) {
    router.recordOutcome(lease.upstreamAccount.id, outcome);
    return true;
  }
  return false;
}
