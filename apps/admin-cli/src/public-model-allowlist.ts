import { readFileSync } from "node:fs";
import {
  isRecord,
  normalizeAllowedPublicModels,
  type PublicModelAliasGroup
} from "@codex-gateway/core";

export interface PublicModelAllowlistCatalog {
  canonicalIds: string[];
  aliasGroups: PublicModelAliasGroup[];
}

export interface ResolvedPublicModelAllowlist
  extends PublicModelAllowlistCatalog {
  models: string[] | null;
}

export function resolvePublicModelAllowlistOption(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedPublicModelAllowlist | undefined {
  if (value === undefined) {
    return undefined;
  }
  const catalog = configuredPublicModelAllowlistCatalog(env);
  if (value.trim().toLowerCase() === "all") {
    return { ...catalog, models: null };
  }
  const requested = value.split(",").map((modelId) => modelId.trim());
  if (requested.some((modelId) => modelId.length === 0)) {
    throw new Error(
      "--allowed-public-models must be a comma-separated model list or 'all'."
    );
  }
  return {
    ...catalog,
    models: normalizeAllowedPublicModels(
      requested,
      catalog.canonicalIds,
      catalog.aliasGroups
    )
  };
}

export function configuredPublicModelAllowlistCatalog(
  env: NodeJS.ProcessEnv = process.env
): PublicModelAllowlistCatalog {
  const file = env.MEDCODE_PUBLIC_MODELS_JSON_FILE?.trim();
  const raw = file
    ? readFileSync(file, "utf8")
    : env.MEDCODE_PUBLIC_MODELS_JSON?.trim();
  if (!raw) {
    const id = env.MEDCODE_PUBLIC_MODEL_ID?.trim() || "medcode";
    return validatedCatalog([{ id, aliases: [] }]);
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(
      "Configured public model registry must be a non-empty JSON object."
    );
  }
  const aliasGroups = Object.entries(parsed).map(([id, config]) => {
    if (!isRecord(config)) {
      throw new Error(`Configured public model '${id}' must be an object.`);
    }
    const aliases = config.aliases ?? [];
    if (
      !Array.isArray(aliases) ||
      !aliases.every((alias) => typeof alias === "string")
    ) {
      throw new Error(
        `Configured public model '${id}' aliases must be a string array.`
      );
    }
    return { id, aliases };
  });
  const defaultModelId = env.MEDCODE_PUBLIC_MODEL_ID?.trim() || "medcode";
  if (
    !aliasGroups.some(
      (group) =>
        group.id === defaultModelId || group.aliases.includes(defaultModelId)
    )
  ) {
    aliasGroups.unshift({ id: defaultModelId, aliases: [] });
  }
  return validatedCatalog(aliasGroups);
}

function validatedCatalog(
  aliasGroups: PublicModelAliasGroup[]
): PublicModelAllowlistCatalog {
  const canonicalIds = aliasGroups.map((group) => group.id);
  normalizeAllowedPublicModels(canonicalIds, canonicalIds, aliasGroups);
  const names = new Set<string>();
  for (const group of aliasGroups) {
    for (const name of [group.id, ...(group.aliases ?? [])]) {
      if (names.has(name)) {
        throw new Error(`Duplicate configured public model id or alias '${name}'.`);
      }
      names.add(name);
    }
  }
  return { canonicalIds, aliasGroups };
}
