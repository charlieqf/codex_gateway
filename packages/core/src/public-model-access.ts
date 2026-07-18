import {
  defaultPublicModelAliasGroups,
  normalizePublicModelId,
  type PublicModelAliasGroup
} from "./public-model-usage.js";

const publicModelIdPattern = /^[a-z][a-z0-9._-]{0,63}$/;

export function normalizeAllowedPublicModels(
  value: readonly string[] | null | undefined,
  knownPublicModelIds?: Iterable<string>,
  aliasGroups: readonly PublicModelAliasGroup[] = []
): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("allowedPublicModels must be null or a non-empty array.");
  }

  const known =
    knownPublicModelIds === undefined
      ? null
      : new Set(
          Array.from(knownPublicModelIds, (modelId) =>
            normalizePublicModelId(modelId, aliasGroups)
          )
        );
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const requestedModelId of value) {
    if (
      typeof requestedModelId !== "string" ||
      requestedModelId !== requestedModelId.trim() ||
      !publicModelIdPattern.test(requestedModelId)
    ) {
      throw new Error("allowedPublicModels must contain valid public model ids.");
    }
    const modelId =
      normalizePublicModelId(requestedModelId, aliasGroups) ?? requestedModelId;
    if (seen.has(modelId)) {
      throw new Error(
        "allowedPublicModels must not contain duplicate canonical model ids."
      );
    }
    if (known && !known.has(modelId)) {
      throw new Error(`Unknown public model id '${requestedModelId}'.`);
    }
    seen.add(modelId);
    normalized.push(modelId);
  }
  return normalized;
}

export function parseAllowedPublicModelsJson(value: string | null): string[] | null {
  if (value === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored allowed public models are invalid.");
  }
  try {
    return normalizeAllowedPublicModels(parsed as readonly string[]);
  } catch {
    throw new Error("Stored allowed public models are invalid.");
  }
}

export function decodeStoredAllowedPublicModelsJson(
  value: string | null
): string[] | null {
  try {
    return parseAllowedPublicModelsJson(value);
  } catch {
    // Corrupt or legacy rows must fail closed without taking authentication
    // and credential-list reads down with an exception.
    return [];
  }
}

export function storedAllowedPublicModelsAreCorrupt(
  value: readonly string[] | null
): boolean {
  return value !== null && value.length === 0;
}

export function credentialAllowsPublicModel(
  allowedPublicModels: readonly string[] | null,
  canonicalPublicModelId: string,
  aliasGroups: readonly PublicModelAliasGroup[] = defaultPublicModelAliasGroups
): boolean {
  if (allowedPublicModels === null) {
    return true;
  }
  const canonical =
    normalizePublicModelId(canonicalPublicModelId, aliasGroups) ??
    canonicalPublicModelId;
  return allowedPublicModels.some(
    (modelId) =>
      (normalizePublicModelId(modelId, aliasGroups) ?? modelId) === canonical
  );
}
