import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  GatewayError,
  type ProviderAdapter,
  type ProviderKind,
  type UpstreamAccount,
  type UpstreamAccountState
} from "@codex-gateway/core";
import type { ImageGenerationProvider } from "../image-generation.js";

export interface UpstreamAccountRuntimeInput {
  upstreamAccount: UpstreamAccount;
  provider: ProviderAdapter;
  imageProvider?: ImageGenerationProvider | null;
  enabled?: boolean;
  weight?: number;
  maxConcurrent?: number | null;
}

export interface UpstreamAccountSelection {
  upstreamAccount: UpstreamAccount;
  provider: ProviderAdapter;
}

export interface UpstreamAccountLease extends UpstreamAccountSelection {
  release(): void;
}

export interface UpstreamImageLease {
  upstreamAccount: UpstreamAccount;
  imageProvider: ImageGenerationProvider;
  release(): void;
}

export type UpstreamSoftAffinity = "credential" | "subject" | "none";

export type UpstreamAccountOutcome =
  | "success"
  | "provider_reauth_required"
  | "rate_limited"
  | "service_error";

export type ImageProviderOutcome =
  | "success"
  | "rate_limited"
  | "service_error"
  | "upstream_timeout"
  | "key_invalid"
  | "content_policy_violation"
  | "invalid_request";

export interface UpstreamAccountCooldownConfig {
  rateLimitSeconds: number;
  reauthSeconds: number;
  serviceErrorSeconds: number;
}

export interface ParsedUpstreamAccountConfig {
  id: string;
  label: string;
  provider: ProviderKind;
  codexHome: string;
  imageApiKeyEnv?: string;
  imageBaseUrlEnv?: string;
  imageTimeoutMs?: number;
  enabled: boolean;
  initialState: UpstreamAccountState;
  weight: number;
  maxConcurrent: number;
}

export interface ParsedUpstreamAccountPoolConfig {
  accounts: ParsedUpstreamAccountConfig[];
  selection: {
    strategy: "least_inflight";
    softAffinity: UpstreamSoftAffinity;
  };
  cooldown: UpstreamAccountCooldownConfig;
}

interface UpstreamAccountRuntime {
  upstreamAccount: UpstreamAccount;
  provider: ProviderAdapter;
  imageProvider: ImageGenerationProvider | null;
  enabled: boolean;
  weight: number;
  maxConcurrent: number | null;
  inflight: number;
  image: {
    state: "active" | "key_invalid" | "unhealthy" | "missing";
    cooldownUntil: Date | null;
    inflight: number;
  };
}

interface UpstreamAccountRouterOptions {
  softAffinity?: UpstreamSoftAffinity;
  cooldown?: UpstreamAccountCooldownConfig;
  onAccountUpdated?: (account: UpstreamAccount) => void;
  now?: () => Date;
}

export interface UpstreamAccountConfigLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn?(bindings: Record<string, unknown>, message: string): void;
}

interface ParseUpstreamAccountPoolConfigOptions {
  nodeEnv?: string;
  logger?: UpstreamAccountConfigLogger;
}

export class UpstreamAccountRouter {
  readonly softAffinity: UpstreamSoftAffinity;

  private readonly runtimes: UpstreamAccountRuntime[];
  private readonly cooldown: UpstreamAccountCooldownConfig;
  private readonly onAccountUpdated?: (account: UpstreamAccount) => void;
  private readonly now: () => Date;

  constructor(inputs: UpstreamAccountRuntimeInput[], options: UpstreamAccountRouterOptions = {}) {
    if (inputs.length === 0) {
      throw new Error("At least one upstream account runtime is required.");
    }
    this.softAffinity = options.softAffinity ?? "credential";
    this.cooldown = options.cooldown ?? defaultCooldown();
    this.onAccountUpdated = options.onAccountUpdated;
    this.now = options.now ?? (() => new Date());
    const ids = new Set<string>();
    this.runtimes = inputs.map((input) => {
      if (ids.has(input.upstreamAccount.id)) {
        throw new Error(`Duplicate upstream account id '${input.upstreamAccount.id}'.`);
      }
      ids.add(input.upstreamAccount.id);
      if (input.weight !== undefined && (!Number.isFinite(input.weight) || input.weight <= 0)) {
        throw new Error(`Invalid upstream account weight for '${input.upstreamAccount.id}'.`);
      }
      if (
        input.maxConcurrent !== undefined &&
        input.maxConcurrent !== null &&
        (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent <= 0)
      ) {
        throw new Error(`Invalid upstream account maxConcurrent for '${input.upstreamAccount.id}'.`);
      }
      return {
        upstreamAccount: input.upstreamAccount,
        provider: input.provider,
        imageProvider: input.imageProvider ?? null,
        enabled: input.enabled !== false,
        weight: input.weight ?? 1,
        maxConcurrent: input.maxConcurrent ?? null,
        inflight: 0,
        image: {
          state: input.upstreamAccount.imageApiKeyEnv && input.imageProvider ? "active" : "missing",
          cooldownUntil: null,
          inflight: 0
        }
      };
    });
  }

  listAccounts(): UpstreamAccountSelection[] {
    return this.runtimes.map((runtime) => ({
      upstreamAccount: runtime.upstreamAccount,
      provider: runtime.provider
    }));
  }

  defaultSelection(): UpstreamAccountSelection {
    const runtime =
      this.runtimes.find((candidate) => candidate.enabled) ??
      this.runtimes[0];
    return {
      upstreamAccount: runtime.upstreamAccount,
      provider: runtime.provider
    };
  }

  hasImageBindingDeclared(): boolean {
    return this.runtimes.some((runtime) => Boolean(runtime.upstreamAccount.imageApiKeyEnv));
  }

  selectForStatus(): UpstreamAccountSelection | GatewayError {
    const runtime = this.firstEligibleRuntime();
    if (!runtime) {
      return this.noEligibleAccountError();
    }
    return {
      upstreamAccount: runtime.upstreamAccount,
      provider: runtime.provider
    };
  }

  selectForNewSession(
    input: { affinityKey?: string | null; excludeAccountIds?: Iterable<string> } = {}
  ): UpstreamAccountSelection | GatewayError {
    const runtime = this.chooseRuntime(input.affinityKey ?? null, input.excludeAccountIds);
    if (runtime instanceof GatewayError) {
      return runtime;
    }
    return {
      upstreamAccount: runtime.upstreamAccount,
      provider: runtime.provider
    };
  }

  beginStateless(
    input: { affinityKey?: string | null; excludeAccountIds?: Iterable<string> } = {}
  ): UpstreamAccountLease | GatewayError {
    const runtime = this.chooseRuntime(input.affinityKey ?? null, input.excludeAccountIds);
    if (runtime instanceof GatewayError) {
      return runtime;
    }
    return this.lease(runtime);
  }

  beginImage(
    input: { affinityKey?: string | null; excludeAccountIds?: Iterable<string> } = {}
  ): UpstreamImageLease | GatewayError {
    const runtime = this.chooseImageRuntime(input.affinityKey ?? null, input.excludeAccountIds);
    if (runtime instanceof GatewayError) {
      return runtime;
    }
    return this.imageLease(runtime);
  }

  recordOutcome(accountId: string, outcome: UpstreamAccountOutcome): UpstreamAccount | null {
    const runtime = this.runtimes.find((candidate) => candidate.upstreamAccount.id === accountId);
    if (!runtime) {
      return null;
    }

    const now = this.now();
    if (outcome === "success") {
      runtime.upstreamAccount.state = "active";
      runtime.upstreamAccount.lastUsedAt = now;
      runtime.upstreamAccount.cooldownUntil = null;
      this.onAccountUpdated?.(runtime.upstreamAccount);
      return runtime.upstreamAccount;
    }

    const cooldownUntil = new Date(now.getTime() + cooldownSeconds(this.cooldown, outcome) * 1000);
    if (outcome === "provider_reauth_required") {
      // Reauth state already excludes the account; cooldown gives operators a clear incident window.
      runtime.upstreamAccount.state = "reauth_required";
    } else {
      runtime.upstreamAccount.state = "active";
    }
    runtime.upstreamAccount.cooldownUntil = cooldownUntil;
    this.onAccountUpdated?.(runtime.upstreamAccount);
    return runtime.upstreamAccount;
  }

  recordImageOutcome(accountId: string, outcome: ImageProviderOutcome): UpstreamAccount | null {
    const runtime = this.runtimes.find((candidate) => candidate.upstreamAccount.id === accountId);
    if (!runtime) {
      return null;
    }

    const now = this.now();
    if (outcome === "success") {
      runtime.image.state = "active";
      runtime.image.cooldownUntil = null;
      runtime.upstreamAccount.lastUsedAt = now;
      this.onAccountUpdated?.(runtime.upstreamAccount);
      return runtime.upstreamAccount;
    }

    if (outcome === "content_policy_violation" || outcome === "invalid_request") {
      if (runtime.image.state !== "missing" && runtime.image.state !== "key_invalid") {
        runtime.image.state = "active";
      }
      return runtime.upstreamAccount;
    }

    const cooldownUntil = new Date(
      now.getTime() + imageCooldownSeconds(this.cooldown, outcome) * 1000
    );
    runtime.image.cooldownUntil = cooldownUntil;
    runtime.image.state = outcome === "key_invalid" ? "key_invalid" : "active";
    return runtime.upstreamAccount;
  }

  beginExistingSession(upstreamAccountId: string): UpstreamAccountLease | GatewayError {
    const runtime = this.runtimes.find(
      (candidate) => candidate.upstreamAccount.id === upstreamAccountId
    );
    if (!runtime) {
      return new GatewayError({
        code: "subscription_unavailable",
        message: "The upstream account for this session is not configured.",
        httpStatus: 503
      });
    }
    if (!runtime.enabled || runtime.upstreamAccount.state === "disabled") {
      return new GatewayError({
        code: "subscription_unavailable",
        message: "The upstream account for this session is disabled.",
        httpStatus: 503
      });
    }
    if (runtime.upstreamAccount.state === "reauth_required") {
      return new GatewayError({
        code: "provider_reauth_required",
        message: "The upstream account for this session requires reauthorization.",
        httpStatus: 503
      });
    }
    if (runtime.upstreamAccount.state !== "active") {
      return new GatewayError({
        code: "subscription_unavailable",
        message: "The upstream account for this session is unavailable.",
        httpStatus: 503
      });
    }
    const nowMs = this.now().getTime();
    if (isCoolingDown(runtime.upstreamAccount, nowMs)) {
      return new GatewayError({
        code: "rate_limited",
        message: "The upstream account for this session is cooling down.",
        httpStatus: 429,
        retryAfterSeconds: retryAfterSeconds(runtime.upstreamAccount, nowMs)
      });
    }
    if (isAtConcurrencyCap(runtime)) {
      return new GatewayError({
        code: "rate_limited",
        message: "The upstream account for this session is at its concurrency limit.",
        httpStatus: 429,
        retryAfterSeconds: 1
      });
    }
    return this.lease(runtime);
  }

  private chooseRuntime(
    affinityKey: string | null,
    excludeAccountIds: Iterable<string> | undefined
  ): UpstreamAccountRuntime | GatewayError {
    const excluded = new Set(excludeAccountIds ?? []);
    const nowMs = this.now().getTime();
    const candidates = this.runtimes.filter(
      (runtime) =>
        !excluded.has(runtime.upstreamAccount.id) &&
        runtime.enabled &&
        runtime.upstreamAccount.state === "active" &&
        !isCoolingDown(runtime.upstreamAccount, nowMs) &&
        !isAtConcurrencyCap(runtime)
    );
    if (candidates.length === 0) {
      return this.noEligibleAccountError();
    }

    if (this.softAffinity !== "none" && affinityKey) {
      return highestRankedByHrw(affinityKey, candidates);
    }

    return candidates.reduce((best, candidate) =>
      inflightScore(candidate) < inflightScore(best) ? candidate : best
    );
  }

  private chooseImageRuntime(
    affinityKey: string | null,
    excludeAccountIds: Iterable<string> | undefined
  ): UpstreamAccountRuntime | GatewayError {
    const excluded = new Set(excludeAccountIds ?? []);
    const candidates = this.runtimes.filter(
      (runtime) =>
        !excluded.has(runtime.upstreamAccount.id) &&
        runtime.enabled &&
        runtime.upstreamAccount.state === "active" &&
        Boolean(runtime.upstreamAccount.imageApiKeyEnv) &&
        runtime.imageProvider !== null &&
        runtime.image.state === "active" &&
        !isImageCoolingDown(runtime) &&
        !isImageAtConcurrencyCap(runtime)
    );
    if (candidates.length === 0) {
      return this.noEligibleImageAccountError(excluded);
    }

    if (this.softAffinity !== "none" && affinityKey) {
      return highestRankedByHrw(affinityKey, candidates);
    }

    return candidates.reduce((best, candidate) =>
      imageInflightScore(candidate) < imageInflightScore(best) ? candidate : best
    );
  }

  private firstEligibleRuntime(): UpstreamAccountRuntime | null {
    const nowMs = this.now().getTime();
    return (
      this.runtimes.find(
        (runtime) =>
          runtime.enabled &&
          runtime.upstreamAccount.state === "active" &&
          !isCoolingDown(runtime.upstreamAccount, nowMs) &&
          !isAtConcurrencyCap(runtime)
      ) ?? null
    );
  }

  private noEligibleAccountError(): GatewayError {
    const enabled = this.runtimes.filter((runtime) => runtime.enabled);
    if (enabled.some((runtime) => runtime.upstreamAccount.state === "reauth_required")) {
      return new GatewayError({
        code: "provider_reauth_required",
        message: "No upstream account is currently authorized.",
        httpStatus: 503
      });
    }
    const nowMs = this.now().getTime();
    const busy = enabled.filter(
      (runtime) =>
        runtime.upstreamAccount.state === "active" &&
        (isCoolingDown(runtime.upstreamAccount, nowMs) || isAtConcurrencyCap(runtime))
    );
    if (busy.length > 0) {
      return new GatewayError({
        code: "rate_limited",
        message: "All upstream accounts are temporarily busy.",
        httpStatus: 429,
        retryAfterSeconds: Math.min(
          ...busy.map((runtime) => runtimeRetryAfterSeconds(runtime, nowMs))
        )
      });
    }
    return new GatewayError({
      code: "subscription_unavailable",
      message: "No upstream account is currently available.",
      httpStatus: 503
    });
  }

  private noEligibleImageAccountError(excluded: Set<string>): GatewayError {
    const imageConfigured = this.runtimes.filter(
      (runtime) => !excluded.has(runtime.upstreamAccount.id) && runtime.upstreamAccount.imageApiKeyEnv
    );
    if (
      imageConfigured.some(
        (runtime) =>
          runtime.enabled &&
          runtime.upstreamAccount.state === "active" &&
          runtime.imageProvider !== null &&
          runtime.image.state === "active" &&
          (isImageCoolingDown(runtime) || isImageAtConcurrencyCap(runtime))
      )
    ) {
      return new GatewayError({
        code: "rate_limited",
        message: "All image-capable upstream accounts are temporarily busy.",
        httpStatus: 429,
        retryAfterSeconds: 1
      });
    }
    return new GatewayError({
      code: "upstream_unavailable",
      message: "Image generation is not configured for any available upstream account.",
      httpStatus: 503
    });
  }

  private lease(runtime: UpstreamAccountRuntime): UpstreamAccountLease {
    runtime.inflight += 1;
    let released = false;
    return {
      upstreamAccount: runtime.upstreamAccount,
      provider: runtime.provider,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        runtime.inflight = Math.max(0, runtime.inflight - 1);
      }
    };
  }

  private imageLease(runtime: UpstreamAccountRuntime): UpstreamImageLease {
    if (!runtime.imageProvider) {
      throw new Error("Cannot lease image generation without an image provider.");
    }
    runtime.image.inflight += 1;
    let released = false;
    return {
      upstreamAccount: runtime.upstreamAccount,
      imageProvider: runtime.imageProvider,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        runtime.image.inflight = Math.max(0, runtime.image.inflight - 1);
      }
    };
  }
}

export function parseUpstreamAccountPoolConfig(
  raw: string,
  options: ParseUpstreamAccountPoolConfigOptions = {}
): ParsedUpstreamAccountPoolConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw new Error("GATEWAY_UPSTREAM_ACCOUNTS_JSON must contain a non-empty accounts array.");
  }

  const seen = new Set<string>();
  const accounts = parsed.accounts.map((entry, index) =>
    parseAccountConfig(entry, index, seen, options)
  );

  return {
    accounts,
    selection: {
      strategy: "least_inflight",
      softAffinity: parseSoftAffinity(parsed.selection)
    },
    cooldown: parseCooldown(parsed.cooldown)
  };
}

export function readUpstreamAccountPoolConfigFile(
  filePath: string,
  options: ParseUpstreamAccountPoolConfigOptions = {}
): ParsedUpstreamAccountPoolConfig {
  return parseUpstreamAccountPoolConfig(readFileSync(filePath, "utf8"), options);
}

export function accountFromPoolConfig(config: ParsedUpstreamAccountConfig): UpstreamAccount {
  return {
    id: config.id,
    provider: config.provider,
    label: config.label,
    credentialRef: `CODEX_HOME:${config.id}`,
    imageApiKeyEnv: config.imageApiKeyEnv ?? null,
    state: config.initialState,
    lastUsedAt: null,
    cooldownUntil: null
  };
}

export function applyStartupAuthState(
  account: UpstreamAccount,
  config: ParsedUpstreamAccountConfig,
  options: { validateAuthFiles?: boolean }
): UpstreamAccount {
  if (!options.validateAuthFiles || !config.enabled || account.state !== "active") {
    return account;
  }
  if (!existsSync(config.codexHome) || !existsSync(path.join(config.codexHome, "auth.json"))) {
    return {
      ...account,
      state: "reauth_required"
    };
  }
  return account;
}

function parseAccountConfig(
  entry: unknown,
  index: number,
  seen: Set<string>,
  options: ParseUpstreamAccountPoolConfigOptions
): ParsedUpstreamAccountConfig {
  if (!isRecord(entry)) {
    throw new Error(`Upstream account at index ${index} must be an object.`);
  }
  const id = requiredString(entry.id, `accounts[${index}].id`);
  if (seen.has(id)) {
    throw new Error(`Duplicate upstream account id '${id}'.`);
  }
  seen.add(id);
  const provider = requiredString(entry.provider, `accounts[${index}].provider`);
  if (provider !== "openai-codex") {
    throw new Error(`Unsupported upstream account provider '${provider}'.`);
  }
  const codexHome = requiredString(entry.codexHome, `accounts[${index}].codexHome`);
  if (options.nodeEnv === "production" && !path.isAbsolute(codexHome)) {
    throw new Error(`accounts[${index}].codexHome must be an absolute path in production.`);
  }
  const maxConcurrent = entry.maxConcurrent;
  if (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) <= 0) {
    throw new Error(`accounts[${index}].maxConcurrent must be a positive integer.`);
  }
  const weight = entry.weight === undefined ? 1 : entry.weight;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
    throw new Error(`accounts[${index}].weight must be a positive number.`);
  }
  const initialState = entry.initialState === undefined ? "active" : entry.initialState;
  if (!isUpstreamAccountState(initialState)) {
    throw new Error(`accounts[${index}].initialState must be a valid upstream account state.`);
  }
  return {
    id,
    label: requiredString(entry.label, `accounts[${index}].label`),
    provider,
    codexHome,
    imageApiKeyEnv: parseImageApiKeyEnv(entry.imageApiKeyEnv, `accounts[${index}].imageApiKeyEnv`),
    imageBaseUrlEnv: optionalString(entry.imageBaseUrlEnv, `accounts[${index}].imageBaseUrlEnv`),
    imageTimeoutMs: optionalPositiveIntegerOrUndefined(
      entry.imageTimeoutMs,
      `accounts[${index}].imageTimeoutMs`
    ),
    enabled: entry.enabled !== false,
    initialState,
    weight,
    maxConcurrent: maxConcurrent as number
  };
}

function parseSoftAffinity(selection: unknown): UpstreamSoftAffinity {
  if (!isRecord(selection) || selection.softAffinity === undefined) {
    return "credential";
  }
  if (
    selection.softAffinity === "credential" ||
    selection.softAffinity === "subject" ||
    selection.softAffinity === "none"
  ) {
    return selection.softAffinity;
  }
  throw new Error("selection.softAffinity must be credential, subject, or none.");
}

function parseCooldown(cooldown: unknown): UpstreamAccountCooldownConfig {
  if (!isRecord(cooldown)) {
    return defaultCooldown();
  }
  return {
    rateLimitSeconds: optionalPositiveInteger(
      cooldown.rateLimitSeconds,
      "cooldown.rateLimitSeconds",
      120
    ),
    reauthSeconds: optionalPositiveInteger(cooldown.reauthSeconds, "cooldown.reauthSeconds", 900),
    serviceErrorSeconds: optionalPositiveInteger(
      cooldown.serviceErrorSeconds,
      "cooldown.serviceErrorSeconds",
      30
    )
  };
}

function optionalPositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
}

function optionalPositiveIntegerOrUndefined(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when provided.`);
  }
  return value;
}

function parseImageApiKeyEnv(value: unknown, name: string): string | undefined {
  const parsed = optionalString(value, name);
  if (!parsed) {
    return undefined;
  }
  if (parsed.length > 64 || parsed.startsWith("sk-")) {
    throw new Error(`${name} must be an environment variable name, not an API key value.`);
  }
  return parsed;
}

function defaultCooldown(): UpstreamAccountCooldownConfig {
  return {
    rateLimitSeconds: 120,
    reauthSeconds: 900,
    serviceErrorSeconds: 30
  };
}

function cooldownSeconds(
  config: UpstreamAccountCooldownConfig,
  outcome: Exclude<UpstreamAccountOutcome, "success">
): number {
  if (outcome === "provider_reauth_required") {
    return config.reauthSeconds;
  }
  if (outcome === "rate_limited") {
    return config.rateLimitSeconds;
  }
  return config.serviceErrorSeconds;
}

function imageCooldownSeconds(
  config: UpstreamAccountCooldownConfig,
  outcome: Exclude<
    ImageProviderOutcome,
    "success" | "content_policy_violation" | "invalid_request"
  >
): number {
  if (outcome === "rate_limited") {
    return config.rateLimitSeconds;
  }
  if (outcome === "key_invalid") {
    return config.reauthSeconds;
  }
  return config.serviceErrorSeconds;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUpstreamAccountState(value: unknown): value is UpstreamAccountState {
  return (
    value === "active" ||
    value === "disabled" ||
    value === "reauth_required" ||
    value === "unhealthy"
  );
}

function isCoolingDown(account: UpstreamAccount, nowMs = Date.now()): boolean {
  return Boolean(account.cooldownUntil && account.cooldownUntil.getTime() > nowMs);
}

function retryAfterSeconds(account: UpstreamAccount, nowMs = Date.now()): number {
  if (!account.cooldownUntil) {
    return 1;
  }
  return Math.max(1, Math.ceil((account.cooldownUntil.getTime() - nowMs) / 1000));
}

function isAtConcurrencyCap(runtime: UpstreamAccountRuntime): boolean {
  return runtime.maxConcurrent !== null && runtime.inflight >= runtime.maxConcurrent;
}

function runtimeRetryAfterSeconds(runtime: UpstreamAccountRuntime, nowMs: number): number {
  return isCoolingDown(runtime.upstreamAccount, nowMs)
    ? retryAfterSeconds(runtime.upstreamAccount, nowMs)
    : 1;
}

function isImageCoolingDown(runtime: UpstreamAccountRuntime): boolean {
  return Boolean(runtime.image.cooldownUntil && runtime.image.cooldownUntil.getTime() > Date.now());
}

function isImageAtConcurrencyCap(runtime: UpstreamAccountRuntime): boolean {
  return runtime.maxConcurrent !== null && runtime.image.inflight >= runtime.maxConcurrent;
}

function inflightScore(runtime: UpstreamAccountRuntime): number {
  return runtime.inflight / runtime.weight;
}

function imageInflightScore(runtime: UpstreamAccountRuntime): number {
  return runtime.image.inflight / runtime.weight;
}

function highestRankedByHrw(
  affinityKey: string,
  candidates: UpstreamAccountRuntime[]
): UpstreamAccountRuntime {
  return candidates.reduce((best, candidate) =>
    hrwScore(affinityKey, candidate.upstreamAccount.id) >
    hrwScore(affinityKey, best.upstreamAccount.id)
      ? candidate
      : best
  );
}

function hrwScore(affinityKey: string, accountId: string): string {
  return createHash("sha256").update(affinityKey).update("\0").update(accountId).digest("hex");
}
