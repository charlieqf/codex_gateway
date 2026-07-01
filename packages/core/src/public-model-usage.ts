export interface PublicModelAliasGroup {
  id: string;
  aliases?: readonly string[];
}

export const defaultPublicModelAliasGroups: PublicModelAliasGroup[] = [
  { id: "max", aliases: ["medcode"] }
];

export function normalizePublicModelId(
  id: string | null | undefined,
  groups: readonly PublicModelAliasGroup[] = defaultPublicModelAliasGroups
): string | null {
  if (!id) {
    return null;
  }
  for (const group of groups) {
    if (id === group.id || group.aliases?.includes(id)) {
      return group.id;
    }
  }
  return id;
}

export function publicModelFilterIds(
  id: string,
  groups: readonly PublicModelAliasGroup[] = defaultPublicModelAliasGroups
): string[] {
  const canonical = normalizePublicModelId(id, groups) ?? id;
  const group = groups.find((candidate) => candidate.id === canonical);
  return Array.from(new Set([canonical, ...(group?.aliases ?? [])]));
}
