import { createHash } from "node:crypto";
import {
  type FrozenIdentityRecord,
  type FrozenOfficialSource,
  type FrozenPublicationMetadata,
  type ResearchAdapterBundle
} from "./adapters.js";
import {
  fetchApprovedWebDocument,
  fetchBoundedJson,
  fetchBoundedText,
  ResearchHttpError
} from "./safe-http.js";

export interface LiveResearchAdapterOptions {
  ncbi: {
    email?: string;
    tool?: string;
    apiKey?: string;
    maximumResults?: number;
  };
  crossref: {
    mailto?: string;
  };
  orcid: {
    enabled?: boolean;
    bearerToken?: string;
  };
  officialWeb: {
    provider: "brave" | "direct";
    apiKey?: string;
    allowedDomains: readonly string[];
    maximumResults?: number;
  };
  timeoutMs?: number;
  maximumJsonBytes?: number;
  maximumSourceBytes?: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export class LiveResearchAdapters implements ResearchAdapterBundle {
  readonly versions = Object.freeze({
    pubmed: "ncbi-eutils-esearch-esummary.v1",
    crossref: "crossref-rest-v1",
    orcid: "orcid-api-v3.0",
    official_web: "brave-web-search-v1+pinned-source-fetch.v1"
  });
  readonly budgetHints: {
    officialSearchRequestUnits: number;
  };
  private readonly timeoutMs: number;
  private readonly maximumJsonBytes: number;
  private readonly maximumSourceBytes: number;
  private readonly maximumPubMedResults: number;
  private readonly maximumOfficialResults: number;
  private readonly fetchImpl?: typeof fetch;
  private nextNcbiRequestAt = 0;
  private readonly officialSources = new Map<
    string,
    { url: URL; title: string; snippet: string }
  >();

  constructor(private readonly options: LiveResearchAdapterOptions) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 20_000, "timeoutMs");
    this.maximumJsonBytes = positiveInteger(
      options.maximumJsonBytes ?? 2_000_000,
      "maximumJsonBytes"
    );
    this.maximumSourceBytes = positiveInteger(
      options.maximumSourceBytes ?? 1_000_000,
      "maximumSourceBytes"
    );
    this.maximumPubMedResults = boundedCount(
      options.ncbi.maximumResults ?? 15,
      "ncbi.maximumResults",
      50
    );
    this.maximumOfficialResults = boundedCount(
      options.officialWeb.maximumResults ?? 5,
      "officialWeb.maximumResults",
      10
    );
    if (options.ncbi.email !== undefined) {
      requireEmail(options.ncbi.email, "ncbi.email");
    }
    if (options.crossref.mailto !== undefined) {
      requireEmail(options.crossref.mailto, "crossref.mailto");
    }
    if (options.orcid.bearerToken !== undefined) {
      requireSecret(options.orcid.bearerToken, "orcid.bearerToken");
    }
    if (options.officialWeb.provider === "brave") {
      requireSecret(options.officialWeb.apiKey ?? "", "officialWeb.apiKey");
    } else if (options.officialWeb.apiKey !== undefined) {
      throw new Error(
        "Direct official web retrieval must not configure an API key."
      );
    }
    validateAllowedDomains(options.officialWeb.allowedDomains);
    this.budgetHints = Object.freeze({
      officialSearchRequestUnits:
        options.officialWeb.provider === "brave"
          ? options.officialWeb.allowedDomains.length * 2
          : 0
    });
    if (
      options.userAgent !== options.userAgent.trim() ||
      options.userAgent.length < 10 ||
      options.userAgent.length > 300 ||
      /[\r\n]/u.test(options.userAgent)
    ) {
      throw new Error("userAgent is missing or invalid.");
    }
    this.fetchImpl = options.fetchImpl;
  }

  async assertAvailable(signal: AbortSignal): Promise<void> {
    await this.searchPubMed('"heart"[Title] AND 2025[Date - Publication]', signal);
    const crossref = await this.getCrossrefMetadata(
      "10.1038/s41586-020-2649-2",
      signal
    );
    if (!crossref) {
      throw new Error("Crossref preflight metadata was unavailable.");
    }
    if (this.options.orcid.enabled !== false) {
      const orcid = await this.lookupOrcid("0000-0002-1825-0097", signal);
      if (!orcid) {
        throw new Error("ORCID preflight record was unavailable.");
      }
    }
    if (this.options.officialWeb.provider === "brave") {
      await this.searchOfficialSources("doctor profile", signal);
    }
  }

  async searchPubMed(
    query: string,
    signal: AbortSignal
  ): Promise<readonly string[]> {
    const normalizedQuery = boundedQuery(query, 1_000);
    const url = new URL(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    );
    setSearchParams(url, {
      db: "pubmed",
      term: normalizedQuery,
      retmode: "json",
      retmax: String(this.maximumPubMedResults),
      sort: "pub+date",
      tool: this.options.ncbi.tool ?? "codex_gateway_doctor_research",
      email: this.options.ncbi.email,
      api_key: this.options.ncbi.apiKey
    });
    const response = await this.requestJsonWithRetry<NcbiSearchResponse>(
      url,
      signal,
      {}
    );
    const values = response.value.esearchresult?.idlist;
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string" || !/^[0-9]{1,10}$/.test(value))
    ) {
      throw new Error("NCBI ESearch response did not contain valid PMIDs.");
    }
    return [...new Set(values)].slice(0, this.maximumPubMedResults);
  }

  async getPubMedMetadata(
    pmid: string,
    signal: AbortSignal
  ): Promise<FrozenPublicationMetadata | null> {
    if (!/^[0-9]{1,10}$/.test(pmid)) {
      throw new Error("Invalid PMID.");
    }
    const url = new URL(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
    );
    setSearchParams(url, {
      db: "pubmed",
      id: pmid,
      retmode: "json",
      version: "2.0",
      tool: this.options.ncbi.tool ?? "codex_gateway_doctor_research",
      email: this.options.ncbi.email,
      api_key: this.options.ncbi.apiKey
    });
    const response = await this.requestJsonWithRetry<NcbiSummaryResponse>(
      url,
      signal,
      {}
    );
    const record = response.value.result?.[pmid];
    if (!isNcbiSummaryRecord(record) || record.error) {
      return null;
    }
    const doi = Array.isArray(record.articleids)
      ? record.articleids.find(
          (item) =>
            item &&
            typeof item === "object" &&
            item.idtype === "doi" &&
            typeof item.value === "string"
        )?.value ?? null
      : null;
    const publicationYear = parsePublicationYear(
      firstString(record.sortpubdate, record.pubdate, record.epubdate)
    );
    const title = requiredBoundedString(record.title, "PubMed title", 500);
    const journal = requiredBoundedString(
      firstString(record.fulljournalname, record.source),
      "PubMed journal",
      500
    );
    const authors = Array.isArray(record.authors)
      ? record.authors
          .map((author) =>
            author && typeof author === "object" && typeof author.name === "string"
              ? author.name.trim()
              : ""
          )
          .filter(Boolean)
          .map((author) => Array.from(author).slice(0, 300).join(""))
          .slice(0, 100)
      : [];
    const abstractUrl = new URL(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    );
    setSearchParams(abstractUrl, {
      db: "pubmed",
      id: pmid,
      rettype: "abstract",
      retmode: "xml",
      tool: this.options.ncbi.tool ?? "codex_gateway_doctor_research",
      email: this.options.ncbi.email,
      api_key: this.options.ncbi.apiKey
    });
    const abstractResponse = await this.requestTextWithRetry(
      abstractUrl,
      signal
    );
    const articleDetails = extractPubMedArticleDetails(
      abstractResponse.value
    );
    return {
      referenceId: `ref_pmid_${pmid}`,
      pmid,
      doi: doi ? normalizeDoi(doi) : null,
      title,
      journal,
      publicationYear,
      authors,
      authorAffiliations: articleDetails.authorAffiliations,
      affiliations: [
        ...new Set(
          articleDetails.authorAffiliations.flatMap(
            (author) => author.affiliations
          )
        )
      ],
      abstractText: articleDetails.abstract,
      sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      accessedAt: new Date().toISOString(),
      contentSha256: sha256(
        `${response.contentSha256}:${abstractResponse.contentSha256}`
      )
    };
  }

  async getCrossrefMetadata(
    doi: string,
    signal: AbortSignal
  ): Promise<FrozenPublicationMetadata | null> {
    const normalizedDoi = normalizeDoi(doi);
    const url = new URL(
      `https://api.crossref.org/v1/works/${encodeURIComponent(normalizedDoi)}`
    );
    if (this.options.crossref.mailto) {
      url.searchParams.set("mailto", this.options.crossref.mailto);
    }
    let response;
    try {
      response = await this.requestJsonWithRetry<CrossrefWorkResponse>(
        url,
        signal,
        {}
      );
    } catch (error) {
      if (error instanceof ResearchHttpError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
    const record = response.value.message;
    if (!record || typeof record !== "object") {
      return null;
    }
    const title = optionalBoundedArrayFirstString(record.title, 500);
    const journal = optionalBoundedArrayFirstString(
      record["container-title"],
      500
    );
    const publicationYear = crossrefPublicationYear(record);
    if (!title || !journal || !publicationYear) {
      return null;
    }
    const authors = Array.isArray(record.author)
      ? record.author
          .map((author) =>
            [author.given, author.family].filter(
              (value): value is string => typeof value === "string" && value.trim() !== ""
            ).join(" ").slice(0, 300)
          )
          .filter(Boolean)
          .slice(0, 100)
      : [];
    return {
      referenceId: `ref_doi_${sha256(normalizedDoi).slice(0, 24)}`,
      pmid: null,
      doi: normalizedDoi,
      title,
      journal,
      publicationYear,
      authors,
      sourceUrl:
        `https://api.crossref.org/v1/works/` +
        encodeURIComponent(normalizedDoi),
      accessedAt: new Date().toISOString(),
      contentSha256: response.contentSha256
    };
  }

  async lookupOrcid(
    orcid: string,
    signal: AbortSignal
  ): Promise<FrozenIdentityRecord | null> {
    if (this.options.orcid.enabled === false) {
      return null;
    }
    const normalizedOrcid = normalizeOrcid(orcid);
    const url = new URL(
      `https://pub.orcid.org/v3.0/${normalizedOrcid}/record`
    );
    let response;
    try {
      response = await this.requestJsonWithRetry<OrcidRecord>(
        url,
        signal,
        {
          accept: "application/vnd.orcid+json",
          ...(this.options.orcid.bearerToken
            ? {
                authorization:
                  `Bearer ${this.options.orcid.bearerToken}`
              }
            : {})
        }
      );
    } catch (error) {
      if (error instanceof ResearchHttpError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
    const personName = response.value.person?.name;
    const given = boundedOptionalString(
      personName?.["given-names"]?.value,
      200
    );
    const family = boundedOptionalString(
      personName?.["family-name"]?.value,
      200
    );
    const name = [given, family]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .join(" ")
      .trim();
    if (!name) {
      return null;
    }
    const employments =
      response.value["activities-summary"]?.employments?.["affiliation-group"];
    const summaries = Array.isArray(employments)
      ? employments.flatMap((group) =>
          Array.isArray(group.summaries) ? group.summaries : []
        )
      : [];
    const affiliations = summaries
      .map((summary) => summary["employment-summary"])
      .filter(
        (
          employment
        ): employment is NonNullable<
          NonNullable<(typeof summaries)[number]["employment-summary"]>
        > =>
          typeof employment?.organization?.name === "string" &&
          employment.organization.name.trim() !== ""
      )
      .map((employment) => ({
        institution: Array.from(
          employment.organization?.name?.trim() ?? ""
        )
          .slice(0, 300)
          .join(""),
        department: Array.from(
          employment["department-name"]?.trim() ?? ""
        )
          .slice(0, 300)
          .join("")
      }))
      .filter(
        (affiliation, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.institution === affiliation.institution &&
              candidate.department === affiliation.department
          ) === index
      )
      .slice(0, 20);
    const primaryAffiliation =
      affiliations.find((affiliation) => affiliation.department !== "") ??
      affiliations[0];
    return {
      canonicalIdentityId: `dci_orcid${normalizedOrcid.replaceAll("-", "")}`,
      name,
      institution: primaryAffiliation?.institution ?? "",
      department: primaryAffiliation?.department ?? "",
      affiliations,
      orcid: normalizedOrcid,
      sourceUrl: `https://orcid.org/${normalizedOrcid}`,
      accessedAt: new Date().toISOString(),
      contentSha256: response.contentSha256
    };
  }

  async searchOfficialSources(
    normalizedDoctorName: string,
    signal: AbortSignal,
    options: {
      seedUrls?: readonly string[];
    } = {}
  ): Promise<readonly string[]> {
    const query = boundedBraveIdentityQuery(normalizedDoctorName);
    this.officialSources.clear();
    const sourceIds: string[] = [];
    for (const rawUrl of options.seedUrls ?? []) {
      const sourceUrl = approvedSeedUrl(
        rawUrl,
        this.options.officialWeb.allowedDomains
      );
      const sourceId = `src_web_${sha256(sourceUrl.toString()).slice(0, 24)}`;
      this.officialSources.set(sourceId, {
        url: sourceUrl,
        title: sourceUrl.hostname,
        snippet: ""
      });
      sourceIds.push(sourceId);
    }
    if (this.options.officialWeb.provider === "direct") {
      return [...new Set(sourceIds)].slice(0, this.maximumOfficialResults);
    }
    for (const domain of this.options.officialWeb.allowedDomains) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      setSearchParams(url, {
        q: `${query} site:${domain}`,
        count: String(this.maximumOfficialResults),
        safesearch: "strict",
        extra_snippets: "false"
      });
      const response = await this.requestJsonWithRetry<BraveSearchResponse>(
        url,
        signal,
        {
          "x-subscription-token": this.options.officialWeb.apiKey!
        },
        2
      );
      const results = response.value.web?.results;
      if (!Array.isArray(results)) {
        throw new Error("Official web search response is invalid.");
      }
      for (const result of results.slice(0, this.maximumOfficialResults)) {
        if (
          !result ||
          typeof result.url !== "string" ||
          typeof result.title !== "string"
        ) {
          continue;
        }
        let sourceUrl: URL;
        try {
          sourceUrl = new URL(result.url);
        } catch {
          continue;
        }
        if (
          sourceUrl.toString().length > 2_048 ||
          !hostAllowed(sourceUrl.hostname, [domain])
        ) {
          continue;
        }
        const sourceId = `src_web_${sha256(sourceUrl.toString()).slice(0, 24)}`;
        this.officialSources.set(sourceId, {
          url: sourceUrl,
          title: normalizeText(result.title).slice(0, 300),
          snippet:
            typeof result.description === "string"
              ? normalizeText(result.description).slice(0, 2_000)
              : ""
        });
        sourceIds.push(sourceId);
      }
    }
    return [...new Set(sourceIds)].slice(0, this.maximumOfficialResults);
  }

  async fetchApprovedSource(
    sourceId: string,
    signal: AbortSignal
  ): Promise<FrozenOfficialSource | null> {
    const selected = this.officialSources.get(sourceId);
    if (!selected) {
      return null;
    }
    let document:
      | Awaited<ReturnType<typeof fetchApprovedWebDocument>>
      | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        document = await fetchApprovedWebDocument({
          url: selected.url,
          allowedDomains: this.options.officialWeb.allowedDomains,
          signal,
          timeoutMs: this.timeoutMs,
          maximumBytes: this.maximumSourceBytes,
          userAgent: this.options.userAgent
        });
        break;
      } catch (error) {
        lastError = error;
        if (
          signal.aborted ||
          (error instanceof ResearchHttpError &&
            error.statusCode < 500 &&
            error.statusCode !== 429)
        ) {
          throw error;
        }
        if (attempt < 2) {
          const delayMs =
            error instanceof ResearchHttpError && error.retryAfterSeconds !== null
              ? error.retryAfterSeconds * 1_000
              : 250;
          await abortableDelay(Math.min(delayMs, 5_000), signal);
        }
      }
    }
    if (!document) {
      throw lastError;
    }
    return {
      sourceId,
      url: document.url,
      title: document.title || selected.title,
      accessedAt: new Date().toISOString(),
      contentSha256: document.contentSha256,
      untrustedText: document.text
    };
  }

  private async requestJsonWithRetry<T>(
    url: URL,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>>,
    maximumAttempts = 3
  ) {
    if (
      !Number.isSafeInteger(maximumAttempts) ||
      maximumAttempts < 1 ||
      maximumAttempts > 3
    ) {
      throw new Error("maximumAttempts must be an integer from 1 to 3.");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        await this.paceRequest(url, signal);
        return await fetchBoundedJson<T>({
          url,
          signal,
          timeoutMs: this.timeoutMs,
          maximumBytes: this.maximumJsonBytes,
          headers: {
            "user-agent": this.options.userAgent,
            ...headers
          },
          fetchImpl: this.fetchImpl
        });
      } catch (error) {
        lastError = error;
        if (
          signal.aborted ||
          (error instanceof ResearchHttpError &&
            error.statusCode < 500 &&
            error.statusCode !== 429)
        ) {
          throw error;
        }
        if (attempt < maximumAttempts) {
          const delayMs =
            error instanceof ResearchHttpError && error.retryAfterSeconds !== null
              ? error.retryAfterSeconds * 1_000
              : attempt * 250;
          await abortableDelay(Math.min(delayMs, 5_000), signal);
        }
      }
    }
    throw lastError;
  }

  private async requestTextWithRetry(url: URL, signal: AbortSignal) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.paceRequest(url, signal);
        return await fetchBoundedText({
          url,
          signal,
          timeoutMs: this.timeoutMs,
          maximumBytes: this.maximumJsonBytes,
          headers: {
            "user-agent": this.options.userAgent
          },
          fetchImpl: this.fetchImpl
        });
      } catch (error) {
        lastError = error;
        if (
          signal.aborted ||
          (error instanceof ResearchHttpError &&
            error.statusCode < 500 &&
            error.statusCode !== 429)
        ) {
          throw error;
        }
        if (attempt < 3) {
          const delayMs =
            error instanceof ResearchHttpError &&
            error.retryAfterSeconds !== null
              ? error.retryAfterSeconds * 1_000
              : attempt * 250;
          await abortableDelay(Math.min(delayMs, 5_000), signal);
        }
      }
    }
    throw lastError;
  }

  private async paceRequest(url: URL, signal: AbortSignal): Promise<void> {
    if (url.hostname !== "eutils.ncbi.nlm.nih.gov") {
      return;
    }
    const spacingMs = this.options.ncbi.apiKey ? 110 : 350;
    const waitMs = Math.max(0, this.nextNcbiRequestAt - Date.now());
    this.nextNcbiRequestAt = Math.max(Date.now(), this.nextNcbiRequestAt) + spacingMs;
    if (waitMs > 0) {
      await abortableDelay(waitMs, signal);
    }
  }
}

interface NcbiSearchResponse {
  esearchresult?: { idlist?: unknown };
}

interface NcbiSummaryRecord {
  error?: unknown;
  title?: unknown;
  source?: unknown;
  fulljournalname?: unknown;
  pubdate?: unknown;
  sortpubdate?: unknown;
  epubdate?: unknown;
  authors?: unknown;
  articleids?: unknown;
}

interface NcbiSummaryResponse {
  result?: Record<string, NcbiSummaryRecord | unknown>;
}

function isNcbiSummaryRecord(value: unknown): value is NcbiSummaryRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface CrossrefWorkResponse {
  message?: {
    title?: unknown;
    "container-title"?: unknown;
    author?: Array<{ given?: unknown; family?: unknown }>;
    published?: { "date-parts"?: unknown };
    "published-print"?: { "date-parts"?: unknown };
    "published-online"?: { "date-parts"?: unknown };
    issued?: { "date-parts"?: unknown };
  };
}

interface OrcidRecord {
  person?: {
    name?: {
      "given-names"?: { value?: unknown };
      "family-name"?: { value?: unknown };
    };
  };
  "activities-summary"?: {
    employments?: {
      "affiliation-group"?: Array<{
        summaries?: Array<{
          "employment-summary"?: {
            "department-name"?: string;
            organization?: { name?: string };
          };
        }>;
      }>;
    };
  };
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
    }>;
  };
}

function setSearchParams(
  url: URL,
  values: Readonly<Record<string, string | undefined>>
): void {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(name, value);
    }
  }
}

function parsePublicationYear(value: string): number {
  const match = /(?:^|\D)((?:19|20)[0-9]{2})(?:\D|$)/u.exec(value);
  if (!match) {
    throw new Error("Publication metadata does not contain a valid year.");
  }
  return Number(match[1]);
}

function extractPubMedArticleDetails(xml: string): {
  abstract: string | null;
  authorAffiliations: Array<{
    author: string;
    affiliations: string[];
  }>;
} {
  const sections = [...xml.matchAll(/<AbstractText\b[^>]*>([\s\S]*?)<\/AbstractText>/giu)]
    .map((match) =>
      normalizeText(
        decodeXmlEntities(
          match[1]!
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
            .replace(/<[^>]+>/gu, " ")
        )
      )
    )
    .filter(Boolean);
  const authorAffiliations = [
    ...xml.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/giu)
  ]
    .map((match) => {
      const block = match[1]!;
      const lastName = firstXmlElementText(block, "LastName");
      const foreName = firstXmlElementText(block, "ForeName");
      const initials = firstXmlElementText(block, "Initials");
      const collectiveName = firstXmlElementText(block, "CollectiveName");
      const author =
        [foreName || initials, lastName].filter(Boolean).join(" ").trim() ||
        collectiveName;
      const affiliations = [
        ...block.matchAll(/<Affiliation\b[^>]*>([\s\S]*?)<\/Affiliation>/giu)
      ]
        .map((affiliation) =>
          normalizeText(
            decodeXmlEntities(
              affiliation[1]!.replace(/<[^>]+>/gu, " ")
            )
          ).slice(0, 2_000)
        )
        .filter(Boolean);
      return { author, affiliations: [...new Set(affiliations)] };
    })
    .filter(
      (author) => author.author !== "" && author.affiliations.length > 0
    )
    .slice(0, 100);
  return {
    abstract:
      sections.length > 0
        ? sections.join(" ").slice(0, 100_000)
        : null,
    authorAffiliations
  };
}

function firstXmlElementText(xml: string, element: string): string {
  const match = new RegExp(
    `<${element}\\b[^>]*>([\\s\\S]*?)</${element}>`,
    "iu"
  ).exec(xml);
  return match
    ? normalizeText(
        decodeXmlEntities(match[1]!.replace(/<[^>]+>/gu, " "))
      ).slice(0, 500)
    : "";
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;/giu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    );
}

function crossrefPublicationYear(
  record: NonNullable<CrossrefWorkResponse["message"]>
): number | null {
  for (const field of [
    record["published-print"],
    record["published-online"],
    record.published,
    record.issued
  ]) {
    const first = Array.isArray(field?.["date-parts"])
      ? field["date-parts"][0]
      : null;
    const year = Array.isArray(first) ? first[0] : null;
    if (
      typeof year === "number" &&
      Number.isSafeInteger(year) &&
      year >= 1800 &&
      year <= new Date().getUTCFullYear() + 1
    ) {
      return year;
    }
  }
  return null;
}

function normalizeDoi(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .toLowerCase();
  if (!/^10\.[0-9]{4,9}\/\S{1,240}$/u.test(normalized)) {
    throw new Error("Invalid DOI.");
  }
  return normalized;
}

function normalizeOrcid(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/orcid\.org\//iu, "")
    .toUpperCase();
  if (!/^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/u.test(normalized)) {
    throw new Error("Invalid ORCID iD.");
  }
  const compact = normalized.replaceAll("-", "");
  let total = 0;
  for (const digit of compact.slice(0, 15)) {
    total = (total + Number(digit)) * 2;
  }
  const checkValue = (12 - (total % 11)) % 11;
  const expected = checkValue === 10 ? "X" : String(checkValue);
  if (compact[15] !== expected) {
    throw new Error("Invalid ORCID iD checksum.");
  }
  return normalized;
}

function firstString(...values: unknown[]): string {
  return (
    values.find(
      (value): value is string =>
        typeof value === "string" && value.trim() !== ""
    )?.trim() ?? ""
  );
}

function optionalBoundedArrayFirstString(
  value: unknown,
  maximumLength: number
): string {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return "";
  }
  const normalized = normalizeText(value[0]);
  return normalized.length <= maximumLength ? normalized : "";
}

function boundedOptionalString(
  value: unknown,
  maximumLength: number
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 && normalized.length <= maximumLength
    ? normalized
    : undefined;
}

function requiredBoundedString(
  value: unknown,
  description: string,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${description} is missing or invalid.`);
  }
  return normalizeText(value);
}

function boundedQuery(value: string, maximumLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error("Research adapter query is empty or too long.");
  }
  return normalized;
}

function boundedBraveIdentityQuery(value: string): string {
  const normalized = boundedQuery(value, 280);
  if (normalized.split(/\s+/u).length > 40) {
    throw new Error("Official web search query contains too many words.");
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function requireEmail(value: string, name: string): void {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value.trim())) {
    throw new Error(`${name} must be a valid contact email.`);
  }
}

function requireSecret(value: string, name: string): void {
  if (
    value !== value.trim() ||
    value.length < 8 ||
    value.length > 8_192 ||
    /[\r\n]/u.test(value)
  ) {
    throw new Error(`${name} is missing or invalid.`);
  }
}

function validateAllowedDomains(values: readonly string[]): void {
  if (
    values.length === 0 ||
    values.length > 10 ||
    values.reduce((total, value) => total + value.length + 7, 0) > 1_600 ||
    values.some(
      (value) =>
        value !== value.trim().toLowerCase() ||
        value.length > 100 ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
          value
        )
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("officialWeb.allowedDomains is invalid.");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function boundedCount(value: number, name: string, maximum: number): number {
  positiveInteger(value, name);
  if (value > maximum) {
    throw new Error(`${name} cannot exceed ${maximum}.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hostAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/^\./u, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function approvedSeedUrl(
  value: string,
  allowedDomains: readonly string[]
): URL {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > 2_048
  ) {
    throw new Error("Official source seed URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Official source seed URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.hash !== "" ||
    !hostAllowed(url.hostname, allowedDomains)
  ) {
    throw new Error("Official source seed URL is not allowlisted.");
  }
  return url;
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}
