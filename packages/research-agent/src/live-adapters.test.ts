import { describe, expect, it, vi } from "vitest";
import {
  fetchApprovedWebDocument,
  isPublicResearchAddress,
  LiveResearchAdapters
} from "./index.js";

describe("Doctor Research live first-party adapters", () => {
  it("distinguishes public IPv4/IPv6 from special-purpose ranges", () => {
    expect(isPublicResearchAddress("202.120.143.40")).toBe(true);
    expect(isPublicResearchAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicResearchAddress("127.0.0.1")).toBe(false);
    expect(isPublicResearchAddress("10.0.0.1")).toBe(false);
    expect(isPublicResearchAddress("::1")).toBe(false);
    expect(isPublicResearchAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicResearchAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicResearchAddress("not-an-address")).toBe(false);
  });

  it("parses bounded PubMed abstract, Crossref, ORCID, and allowlisted Brave metadata", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      if (url.pathname.endsWith("/esummary.fcgi")) {
        return jsonResponse({
          result: {
            "1001": {
              title: "Verified PubMed Study",
              fulljournalname: "Verified Journal",
              sortpubdate: "2025/01/02 00:00",
              authors: [{ name: "Example Doctor" }],
              articleids: [
                { idtype: "doi", value: "10.1234/Verified.Study" }
              ]
            }
          }
        });
      }
      if (url.pathname.endsWith("/efetch.fcgi")) {
        return new Response(
          "<PubmedArticle><AuthorList><Author><LastName>Doctor</LastName><ForeName>Example</ForeName><Initials>E</Initials><AffiliationInfo><Affiliation>Cardiology, Example Hospital.</Affiliation></AffiliationInfo></Author></AuthorList><Abstract><AbstractText Label=\"METHODS\">Randomized &amp; bounded evidence.</AbstractText><AbstractText>Verified result.</AbstractText></Abstract></PubmedArticle>",
          {
            status: 200,
            headers: { "content-type": "application/xml" }
          }
        );
      }
      if (url.hostname === "api.crossref.org") {
        return jsonResponse({
          message: {
            title: ["Verified PubMed Study"],
            "container-title": ["Verified Journal"],
            author: [{ given: "Example", family: "Doctor" }],
            published: { "date-parts": [[2025, 1, 2]] }
          }
        });
      }
      if (url.hostname === "pub.orcid.org") {
        return jsonResponse({
          person: {
            name: {
              "given-names": { value: "Example" },
              "family-name": { value: "Doctor" }
            }
          },
          "activities-summary": {
            employments: {
              "affiliation-group": [
                {
                  summaries: [
                    {
                      "employment-summary": {
                        "department-name": "Oncology",
                        organization: { name: "Previous Hospital" }
                      }
                    },
                    {
                      "employment-summary": {
                        "department-name": "Cardiology",
                        organization: { name: "Example Hospital" }
                      }
                    }
                  ]
                }
              ]
            }
          }
        });
      }
      if (url.hostname === "api.search.brave.com") {
        expect(url.searchParams.get("q")).toContain(
          "site:hospital.example"
        );
        return jsonResponse({
          web: {
            results: [
              {
                title: "Approved profile",
                url: "https://hospital.example/doctors/example",
                description: "Example Hospital profile"
              },
              {
                title: "Blocked profile",
                url: "https://unapproved.example/doctors/example",
                description: "Must be ignored"
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected adapter URL: ${url.hostname}${url.pathname}`);
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        apiKey: "ncbi-test-key",
        maximumResults: 5
      },
      crossref: { mailto: "operator@example.org" },
      orcid: { bearerToken: "orcid-test-token" },
      officialWeb: {
        provider: "brave",
        apiKey: "brave-test-key",
        allowedDomains: ["hospital.example"],
        maximumResults: 5
      },
      timeoutMs: 5_000,
      maximumJsonBytes: 100_000,
      maximumSourceBytes: 100_000,
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });
    const signal = new AbortController().signal;

    const pubmed = await adapters.getPubMedMetadata("1001", signal);
    expect(pubmed).toMatchObject({
      pmid: "1001",
      doi: "10.1234/verified.study",
      title: "Verified PubMed Study",
      journal: "Verified Journal",
      publicationYear: 2025,
      authors: ["Example Doctor"],
      authorAffiliations: [
        {
          author: "Example Doctor",
          affiliations: ["Cardiology, Example Hospital."]
        }
      ],
      abstractText: "Randomized & bounded evidence. Verified result."
    });
    expect(pubmed?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);

    const crossref = await adapters.getCrossrefMetadata(
      "10.1234/verified.study",
      signal
    );
    expect(crossref).toMatchObject({
      doi: "10.1234/verified.study",
      title: "Verified PubMed Study",
      journal: "Verified Journal",
      publicationYear: 2025,
      sourceUrl:
        "https://api.crossref.org/v1/works/10.1234%2Fverified.study"
    });

    const orcid = await adapters.lookupOrcid(
      "0000-0002-1825-0097",
      signal
    );
    expect(orcid).toMatchObject({
      canonicalIdentityId: "dci_orcid0000000218250097",
      name: "Example Doctor",
      institution: "Previous Hospital",
      department: "Oncology",
      affiliations: [
        {
          institution: "Previous Hospital",
          department: "Oncology"
        },
        {
          institution: "Example Hospital",
          department: "Cardiology"
        }
      ],
      orcid: "0000-0002-1825-0097"
    });

    const sources = await adapters.searchOfficialSources(
      "Example Doctor Example Hospital",
      signal
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/^src_web_[a-f0-9]{24}$/u);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("rejects IP literals and non-allowlisted official source hosts before requesting them", async () => {
    await expect(
      fetchApprovedWebDocument({
        url: new URL("https://127.0.0.1/internal"),
        allowedDomains: ["hospital.example"],
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maximumBytes: 1_000,
        userAgent: "codex-gateway-research-test/1.0"
      })
    ).rejects.toThrow("host is not allowlisted");
  });

  it("searches each approved official domain separately within Brave query bounds", async () => {
    const queries: string[] = [];
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      orcid: { bearerToken: "orcid-test-token" },
      officialWeb: {
        provider: "brave",
        apiKey: "brave-test-key",
        allowedDomains: ["hospital.example", "university.example"],
        maximumResults: 2
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl: async (input) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        );
        const query = url.searchParams.get("q") ?? "";
        queries.push(query);
        const domain = query.includes("site:hospital.example")
          ? "hospital.example"
          : "university.example";
        return jsonResponse({
          web: {
            results: [
              {
                title: `${domain} profile`,
                url: `https://${domain}/doctors/example`,
                description: "Approved profile"
              }
            ]
          }
        });
      }
    });

    expect(adapters.budgetHints).toEqual({
      officialSearchRequestUnits: 4
    });
    await expect(
      adapters.searchOfficialSources(
        "Example Doctor Example Hospital Cardiology",
        new AbortController().signal
      )
    ).resolves.toHaveLength(2);
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.length <= 400)).toBe(true);
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("site:hospital.example"),
        expect.stringContaining("site:university.example")
      ])
    );
  });

  it("retries official search only once for transient HTTP failures", async () => {
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return jsonResponse({ web: { results: [] } });
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      orcid: { bearerToken: "orcid-test-token" },
      officialWeb: {
        provider: "brave",
        apiKey: "brave-test-key",
        allowedDomains: ["hospital.example"],
        maximumResults: 1
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchOfficialSources(
        "Example Doctor Example Hospital",
        new AbortController().signal
      )
    ).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("supports explicit allowlisted official URLs and anonymous ORCID reads without search credentials", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.has("authorization")).toBe(false);
        return jsonResponse({
          person: {
            name: {
              "given-names": { value: "Example" },
              "family-name": { value: "Doctor" }
            }
          }
        });
      }
    );
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      orcid: {},
      officialWeb: {
        provider: "direct",
        allowedDomains: ["hospital.example"],
        maximumResults: 3
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.lookupOrcid(
        "0000-0002-1825-0097",
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      name: "Example Doctor",
      orcid: "0000-0002-1825-0097"
    });
    await expect(
      adapters.searchOfficialSources(
        "Example Doctor Example Hospital Cardiology",
        new AbortController().signal,
        {
          seedUrls: [
            "https://hospital.example/doctors/example"
          ]
        }
      )
    ).resolves.toHaveLength(1);
    expect(adapters.budgetHints).toEqual({
      officialSearchRequestUnits: 0
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(
      adapters.searchOfficialSources(
        "Example Doctor Example Hospital Cardiology",
        new AbortController().signal,
        {
          seedUrls: ["https://unapproved.example/doctors/example"]
        }
      )
    ).rejects.toThrow("not allowlisted");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
