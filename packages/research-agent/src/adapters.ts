export interface FrozenPublicationMetadata {
  referenceId: string;
  pmid: string | null;
  doi: string | null;
  title: string;
  journal: string;
  publicationYear: number;
  authors: string[];
  authorAffiliations?: Array<{
    author: string;
    affiliations: string[];
  }>;
  abstractText?: string | null;
  affiliations?: string[];
  sourceUrl?: string;
  accessedAt?: string;
  contentSha256?: string;
}

export interface FrozenIdentityRecord {
  canonicalIdentityId: string;
  name: string;
  institution: string;
  department: string;
  affiliations?: Array<{
    institution: string;
    department: string;
  }>;
  orcid: string | null;
  sourceUrl?: string;
  accessedAt?: string;
  contentSha256?: string;
}

export interface FrozenOfficialSource {
  sourceId: string;
  url: string;
  title: string;
  accessedAt: string;
  contentSha256: string;
  untrustedText: string;
}

export interface ResearchAdapterBundle {
  readonly versions?: Readonly<Record<string, string>>;
  readonly budgetHints?: {
    officialSearchRequestUnits: number;
  };
  searchPubMed(
    query: string,
    signal: AbortSignal
  ): Promise<readonly string[]>;
  getPubMedMetadata(
    pmid: string,
    signal: AbortSignal
  ): Promise<FrozenPublicationMetadata | null>;
  getCrossrefMetadata(
    doi: string,
    signal: AbortSignal
  ): Promise<FrozenPublicationMetadata | null>;
  lookupOrcid(
    orcid: string,
    signal: AbortSignal
  ): Promise<FrozenIdentityRecord | null>;
  searchOfficialSources(
    normalizedDoctorName: string,
    signal: AbortSignal,
    options?: {
      seedUrls?: readonly string[];
    }
  ): Promise<readonly string[]>;
  fetchApprovedSource(
    sourceId: string,
    signal: AbortSignal
  ): Promise<FrozenOfficialSource | null>;
}

export interface FrozenResearchAdapterData {
  pubmedSearches: Readonly<Record<string, readonly string[]>>;
  publications: readonly FrozenPublicationMetadata[];
  identities: readonly FrozenIdentityRecord[];
  officialSearches: Readonly<Record<string, readonly string[]>>;
  officialSources: readonly FrozenOfficialSource[];
}

export class FrozenResearchAdapters implements ResearchAdapterBundle {
  private readonly publicationsByPmid: Map<
    string,
    FrozenPublicationMetadata
  >;
  private readonly publicationsByDoi: Map<
    string,
    FrozenPublicationMetadata
  >;
  private readonly identitiesByOrcid: Map<string, FrozenIdentityRecord>;
  private readonly sourcesById: Map<string, FrozenOfficialSource>;

  constructor(private readonly data: FrozenResearchAdapterData) {
    this.publicationsByPmid = uniqueMap(
      data.publications.filter(
        (item): item is FrozenPublicationMetadata & { pmid: string } =>
          item.pmid !== null
      ),
      (item) => item.pmid,
      "PMID"
    );
    this.publicationsByDoi = uniqueMap(
      data.publications.filter(
        (item): item is FrozenPublicationMetadata & { doi: string } =>
          item.doi !== null
      ),
      (item) => normalizeDoi(item.doi),
      "DOI"
    );
    this.identitiesByOrcid = uniqueMap(
      data.identities.filter(
        (item): item is FrozenIdentityRecord & { orcid: string } =>
          item.orcid !== null
      ),
      (item) => item.orcid,
      "ORCID"
    );
    this.sourcesById = uniqueMap(
      data.officialSources,
      (item) => item.sourceId,
      "source ID"
    );
  }

  async searchPubMed(
    query: string,
    signal: AbortSignal
  ): Promise<readonly string[]> {
    throwIfAborted(signal);
    return [...(this.data.pubmedSearches[query] ?? [])];
  }

  async getPubMedMetadata(
    pmid: string,
    signal: AbortSignal
  ): Promise<FrozenPublicationMetadata | null> {
    throwIfAborted(signal);
    return this.publicationsByPmid.get(pmid) ?? null;
  }

  async getCrossrefMetadata(
    doi: string,
    signal: AbortSignal
  ): Promise<FrozenPublicationMetadata | null> {
    throwIfAborted(signal);
    return this.publicationsByDoi.get(normalizeDoi(doi)) ?? null;
  }

  async lookupOrcid(
    orcid: string,
    signal: AbortSignal
  ): Promise<FrozenIdentityRecord | null> {
    throwIfAborted(signal);
    return this.identitiesByOrcid.get(orcid) ?? null;
  }

  async searchOfficialSources(
    normalizedDoctorName: string,
    signal: AbortSignal
  ): Promise<readonly string[]> {
    throwIfAborted(signal);
    return [...(this.data.officialSearches[normalizedDoctorName] ?? [])];
  }

  async fetchApprovedSource(
    sourceId: string,
    signal: AbortSignal
  ): Promise<FrozenOfficialSource | null> {
    throwIfAborted(signal);
    return this.sourcesById.get(sourceId) ?? null;
  }
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  description: string
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const itemKey = key(value);
    if (result.has(itemKey)) {
      throw new Error(`Duplicate frozen ${description}: ${itemKey}`);
    }
    result.set(itemKey, Object.freeze({ ...value }));
  }
  return result;
}

function normalizeDoi(value: string): string {
  return value.trim().toLowerCase();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}
