import { readFileSync } from "node:fs";
import { GatewayError, isRecord } from "@codex-gateway/core";

export type OpenAICompatibleRuntimeKind = "openrouter" | "qianfan" | "aliyun" | "tencent";
export type ChatRuntimeKind = "codex" | OpenAICompatibleRuntimeKind | "pool";
export type PublicModelPoolStickyKey = "client_session" | "credential" | "subject";

export interface PublicModelPoolMemberConfig {
  id: string;
  runtime: OpenAICompatibleRuntimeKind;
  upstreamModel: string;
  maxConcurrent?: number;
  reasoning?: Record<string, unknown>;
  enabled: boolean;
}

export interface PublicModelPoolConfig {
  selection: {
    strategy: "hrw_sticky";
    stickyKeyOrder: PublicModelPoolStickyKey[];
  };
  requireAllMembers: boolean;
  members: PublicModelPoolMemberConfig[];
}

export interface PublicModelConfig {
  id: string;
  aliases: string[];
  displayName: string;
  runtime: ChatRuntimeKind;
  upstreamModel: string;
  pool?: PublicModelPoolConfig;
  contextWindow: number;
  maxContextWindow: number;
  upstreamContextWindow: number;
  maxOutputTokens: number;
  enabled: boolean;
  reasoning?: Record<string, unknown>;
}

export interface PublicModelRegistry {
  defaultModelId: string;
  models: PublicModelConfig[];
  get(id: string): PublicModelConfig | null;
  listAvailable(input: PublicModelAvailability): PublicModelConfig[];
  isAvailable(model: PublicModelConfig, input: PublicModelAvailability): boolean;
}

export interface PublicModelAvailability {
  openRouterAvailable: boolean;
  qianfanAvailable?: boolean;
  aliyunAvailable?: boolean;
  tencentAvailable?: boolean;
  poolMemberAdapterKeys?: ReadonlySet<string>;
}

export interface PublicModelRegistryLogger {
  warn?(bindings: Record<string, unknown>, message: string): void;
}

export function resolvePublicModelRegistry(
  env: NodeJS.ProcessEnv,
  logger?: PublicModelRegistryLogger
): PublicModelRegistry {
  const defaultModel = defaultPublicModel(env);
  const raw = readRegistryJson(env, logger);
  if (!raw) {
    return createRegistry([defaultModel], defaultModel.id);
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("MEDCODE_PUBLIC_MODELS_JSON must be a JSON object.");
  }

  const models = Object.entries(parsed).map(([id, value]) =>
    parsePublicModelConfig(id, value, defaultModel)
  );
  const defaultRegistryModel = models.find(
    (model) => model.id === defaultModel.id || model.aliases.includes(defaultModel.id)
  );
  if (!defaultRegistryModel) {
    models.unshift(defaultModel);
  }

  return createRegistry(models, defaultRegistryModel?.id ?? defaultModel.id);
}

export function openAIModelObject(model: PublicModelConfig, id?: string | number) {
  const objectId = typeof id === "string" ? id : model.id;
  return {
    id: objectId,
    object: "model",
    created: 0,
    owned_by: "medcode",
    context_window: model.contextWindow,
    max_context_window: model.maxContextWindow,
    max_output_tokens: model.maxOutputTokens
  };
}

export function modelNotFoundError(model: string): GatewayError {
  return new GatewayError({
    code: "model_not_found",
    message: `Model '${model}' does not exist.`,
    httpStatus: 404
  });
}

export function publicModelPoolMemberAdapterKey(
  runtime: OpenAICompatibleRuntimeKind,
  id: string
): string {
  return `${runtime}:${id}`;
}

function createRegistry(models: PublicModelConfig[], defaultModelId: string): PublicModelRegistry {
  const byId = new Map<string, PublicModelConfig>();
  for (const model of models) {
    if (byId.has(model.id)) {
      throw new Error(`Duplicate public model id or alias '${model.id}'.`);
    }
    byId.set(model.id, model);
    for (const alias of model.aliases) {
      if (alias === model.id) {
        throw new Error(`Public model '${model.id}' alias must not match its id.`);
      }
      if (byId.has(alias)) {
        throw new Error(`Duplicate public model id or alias '${alias}'.`);
      }
      byId.set(alias, model);
    }
  }
  return {
    defaultModelId,
    models,
    get: (id) => byId.get(id) ?? null,
    listAvailable: (input) => models.filter((model) => isModelAvailable(model, input)),
    isAvailable: isModelAvailable
  };
}

function isModelAvailable(model: PublicModelConfig, input: PublicModelAvailability): boolean {
  if (!model.enabled) {
    return false;
  }
  if (model.runtime === "pool") {
    const enabledMembers = model.pool?.members.filter((member) => member.enabled) ?? [];
    if (enabledMembers.length === 0) {
      return false;
    }
    const availableMemberKeys = input.poolMemberAdapterKeys ?? new Set<string>();
    return model.pool?.requireAllMembers
      ? enabledMembers.every((member) =>
          availableMemberKeys.has(publicModelPoolMemberAdapterKey(member.runtime, member.id))
        )
      : enabledMembers.some((member) =>
          availableMemberKeys.has(publicModelPoolMemberAdapterKey(member.runtime, member.id))
        );
  }
  if (model.runtime === "openrouter") {
    return input.openRouterAvailable;
  }
  if (model.runtime === "qianfan") {
    return input.qianfanAvailable === true;
  }
  if (model.runtime === "aliyun") {
    return input.aliyunAvailable === true;
  }
  if (model.runtime === "tencent") {
    return input.tencentAvailable === true;
  }
  return true;
}

function readRegistryJson(
  env: NodeJS.ProcessEnv,
  logger?: PublicModelRegistryLogger
): string | null {
  const file = env.MEDCODE_PUBLIC_MODELS_JSON_FILE?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      logger?.warn?.(
        {
          file,
          error: err instanceof Error ? err.message : String(err)
        },
        "Failed to read MEDCODE_PUBLIC_MODELS_JSON_FILE."
      );
      throw err;
    }
  }

  const raw = env.MEDCODE_PUBLIC_MODELS_JSON?.trim();
  return raw || null;
}

function defaultPublicModel(env: NodeJS.ProcessEnv): PublicModelConfig {
  const id = env.MEDCODE_PUBLIC_MODEL_ID?.trim() || "medcode";
  return {
    id,
    displayName: "Max",
    runtime: "codex",
    upstreamModel: env.MEDCODE_UPSTREAM_MODEL?.trim() || "gpt-5.6-sol",
    contextWindow: positiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_CONTEXT_WINDOW,
      400_000,
      "MEDCODE_PUBLIC_MODEL_CONTEXT_WINDOW"
    ),
    maxContextWindow: positiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_MAX_CONTEXT_WINDOW,
      400_000,
      "MEDCODE_PUBLIC_MODEL_MAX_CONTEXT_WINDOW"
    ),
    upstreamContextWindow: positiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_MAX_CONTEXT_WINDOW,
      400_000,
      "MEDCODE_PUBLIC_MODEL_MAX_CONTEXT_WINDOW"
    ),
    maxOutputTokens: positiveIntegerEnv(
      env.MEDCODE_PUBLIC_MODEL_MAX_OUTPUT_TOKENS,
      128_000,
      "MEDCODE_PUBLIC_MODEL_MAX_OUTPUT_TOKENS"
    ),
    aliases: [],
    enabled: true
  };
}

function parsePublicModelConfig(
  id: string,
  value: unknown,
  defaultModel: PublicModelConfig
): PublicModelConfig {
  if (!publicModelIdPattern.test(id)) {
    throw new Error(`Invalid public model id '${id}'.`);
  }
  if (!isRecord(value)) {
    throw new Error(`Public model '${id}' must be a JSON object.`);
  }

  const aliases = parseAliases(value.aliases ?? value.alias, id);
  const runtime = parseRuntime(value.runtime, id);
  const isDefault = id === defaultModel.id || aliases.includes(defaultModel.id);
  const fallbackContext = isDefault ? defaultModel.contextWindow : 200_000;
  const fallbackUpstreamContext = isDefault ? defaultModel.upstreamContextWindow : 1_048_576;
  const pool = runtime === "pool" ? parsePoolConfig(value.pool, id) : undefined;
  const upstreamModel =
    parseOptionalString(value.upstreamModel ?? value.upstream_model) ??
    (runtime === "pool" ? pool?.members[0]?.upstreamModel : null) ??
    (isDefault ? defaultModel.upstreamModel : null);
  if (!upstreamModel) {
    throw new Error(`Public model '${id}' requires upstreamModel.`);
  }
  const contextWindow = parsePositiveInteger(
    value.contextWindow ?? value.context_window,
    fallbackContext,
    `public model '${id}' contextWindow`
  );
  const maxContextWindow = parsePositiveInteger(
    value.maxContextWindow ?? value.max_context_window,
    fallbackContext,
    `public model '${id}' maxContextWindow`
  );
  const upstreamContextWindow = parsePositiveInteger(
    value.upstreamContextWindow ?? value.upstream_context_window,
    fallbackUpstreamContext,
    `public model '${id}' upstreamContextWindow`
  );
  const fallbackOutput = isDefault
    ? defaultModel.maxOutputTokens
    : Math.min(defaultModel.maxOutputTokens, contextWindow);
  const reasoning = isRecord(value.reasoning)
    ? value.reasoning
    : defaultReasoningForRuntime(runtime);

  return {
    id,
    aliases,
    displayName:
      parseOptionalString(value.displayName ?? value.display_name) ?? (isDefault ? "Max" : id),
    runtime,
    upstreamModel,
    contextWindow,
    maxContextWindow,
    upstreamContextWindow,
    maxOutputTokens: parsePositiveInteger(
      value.maxOutputTokens ?? value.max_output_tokens,
      fallbackOutput,
      `public model '${id}' maxOutputTokens`
    ),
    enabled:
      value.enabled === undefined
        ? true
        : parseBoolean(value.enabled, `Public model '${id}' enabled`),
    ...(pool ? { pool } : {}),
    ...(reasoning ? { reasoning } : {})
  };
}

const publicModelIdPattern = /^[a-z][a-z0-9._-]{0,63}$/;

function parseAliases(value: unknown, id: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Public model '${id}' aliases must be an array.`);
  }
  const aliases: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !publicModelIdPattern.test(item)) {
      throw new Error(`Public model '${id}' aliases must contain valid model ids.`);
    }
    if (!aliases.includes(item)) {
      aliases.push(item);
    }
  }
  return aliases;
}

function parseRuntime(value: unknown, id: string): ChatRuntimeKind {
  if (
    value === "codex" ||
    value === "openrouter" ||
    value === "qianfan" ||
    value === "aliyun" ||
    value === "tencent" ||
    value === "pool"
  ) {
    return value;
  }
  throw new Error(
    `Public model '${id}' runtime must be codex, openrouter, qianfan, aliyun, tencent, or pool.`
  );
}

function defaultReasoningForRuntime(runtime: ChatRuntimeKind): Record<string, unknown> | undefined {
  return runtime === "pool" ? { effort: "medium" } : undefined;
}

function parsePoolConfig(value: unknown, id: string): PublicModelPoolConfig {
  if (!isRecord(value)) {
    throw new Error(`Public model '${id}' pool must be a JSON object.`);
  }
  const rawMembers = value.members;
  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    throw new Error(`Public model '${id}' pool.members must be a non-empty array.`);
  }
  const seen = new Set<string>();
  const members = rawMembers.map((member, index) => parsePoolMember(member, id, index, seen));
  return {
    selection: parsePoolSelection(value.selection, id),
    requireAllMembers:
      value.requireAllMembers === undefined
        ? true
        : parseBoolean(value.requireAllMembers, `public model '${id}' pool.requireAllMembers`),
    members
  };
}

function parsePoolSelection(value: unknown, id: string): PublicModelPoolConfig["selection"] {
  if (value === undefined) {
    return {
      strategy: "hrw_sticky",
      stickyKeyOrder: ["client_session", "credential", "subject"]
    };
  }
  if (!isRecord(value)) {
    throw new Error(`Public model '${id}' pool.selection must be a JSON object.`);
  }
  if (value.strategy !== undefined && value.strategy !== "hrw_sticky") {
    throw new Error(`Public model '${id}' pool.selection.strategy must be hrw_sticky.`);
  }
  return {
    strategy: "hrw_sticky",
    stickyKeyOrder: parseStickyKeyOrder(value.stickyKeyOrder, id)
  };
}

function parseStickyKeyOrder(value: unknown, id: string): PublicModelPoolStickyKey[] {
  if (value === undefined) {
    return ["client_session", "credential", "subject"];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Public model '${id}' pool.selection.stickyKeyOrder must be a non-empty array.`);
  }
  const order: PublicModelPoolStickyKey[] = [];
  for (const item of value) {
    if (item !== "client_session" && item !== "credential" && item !== "subject") {
      throw new Error(
        `Public model '${id}' pool.selection.stickyKeyOrder entries must be client_session, credential, or subject.`
      );
    }
    if (!order.includes(item)) {
      order.push(item);
    }
  }
  return order;
}

function parsePoolMember(
  value: unknown,
  modelId: string,
  index: number,
  seen: Set<string>
): PublicModelPoolMemberConfig {
  if (!isRecord(value)) {
    throw new Error(`Public model '${modelId}' pool.members[${index}] must be a JSON object.`);
  }
  if ("weight" in value) {
    throw new Error(`Public model '${modelId}' pool.members[${index}].weight is not supported.`);
  }
  const id = parsePoolMemberId(value.id, modelId, index);
  if (seen.has(id)) {
    throw new Error(`Duplicate pool member id '${id}' for public model '${modelId}'.`);
  }
  seen.add(id);
  const upstreamModel = parseOptionalString(value.upstreamModel ?? value.upstream_model);
  if (!upstreamModel) {
    throw new Error(
      `public model '${modelId}' pool.members[${index}].upstreamModel must be a non-empty string.`
    );
  }
  return {
    id,
    runtime: parsePoolMemberRuntime(value.runtime, modelId, index),
    upstreamModel,
    ...(value.maxConcurrent === undefined
      ? {}
      : {
          maxConcurrent: parsePositiveInteger(
            value.maxConcurrent,
            1,
            `public model '${modelId}' pool.members[${index}].maxConcurrent`
          )
        }),
    ...(isRecord(value.reasoning) ? { reasoning: value.reasoning } : {}),
    enabled:
      value.enabled === undefined
        ? true
        : parseBoolean(
            value.enabled,
            `public model '${modelId}' pool.members[${index}].enabled`
          )
  };
}

function parsePoolMemberId(value: unknown, modelId: string, index: number): string {
  if (typeof value !== "string" || !publicModelIdPattern.test(value)) {
    throw new Error(`Public model '${modelId}' pool.members[${index}].id must be a valid id.`);
  }
  return value;
}

function parsePoolMemberRuntime(
  value: unknown,
  modelId: string,
  index: number
): OpenAICompatibleRuntimeKind {
  if (value === "openrouter" || value === "qianfan" || value === "aliyun" || value === "tencent") {
    return value;
  }
  throw new Error(
    `Public model '${modelId}' pool.members[${index}].runtime must be openrouter, qianfan, aliyun, or tencent.`
  );
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function parseOptionalString(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Expected a non-empty string.");
  }
  return value.trim();
}

function parsePositiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function positiveIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
