import { describe, expect, it, vi } from "vitest";
import {
  fetchApprovedWebDocument,
  isPublicResearchAddress,
  LiveResearchAdapters,
  ResearchExternalServiceError,
  ResearchHttpError
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

  it("pins an approved dual-stack source to IPv4 before unreachable IPv6", async () => {
    const requestedAddresses: string[] = [];
    const result = await fetchApprovedWebDocument({
      url: new URL("https://hospital.example/doctors/example"),
      allowedDomains: ["hospital.example"],
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maximumBytes: 10_000,
      userAgent: "codex-gateway-research-test/1.0",
      lookupImpl: async () => [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "202.120.143.40", family: 4 }
      ],
      requestPinnedAddressImpl: async (input) => {
        requestedAddresses.push(input.address);
        if (input.family === 6) {
          throw Object.assign(new Error("IPv6 is unreachable"), {
            code: "ENETUNREACH"
          });
        }
        return {
          statusCode: 200,
          headers: {
            "content-type": "text/html",
            "content-encoding": "identity"
          },
          bytes: Buffer.from(
            "<html><head><title>Verified profile</title></head><body>Example Doctor at Example Hospital.</body></html>",
            "utf8"
          )
        };
      }
    });

    expect(requestedAddresses).toEqual(["202.120.143.40"]);
    expect(result).toMatchObject({
      title: "Verified profile",
      text: "Verified profile Example Doctor at Example Hospital."
    });
  });

  it.each([
    [
      "unsafe blocks",
      `Visible profile ${"<script>".repeat(20_000)}hidden`,
      "Visible profile"
    ],
    [
      "generic tags",
      `Visible profile ${"<".repeat(20_000)}hidden`,
      "Visible profile"
    ],
    [
      "title tags",
      `Visible profile ${"<title>".repeat(20_000)}hidden`,
      "Visible profile hidden"
    ]
  ])("bounds malformed %s cleanup", async (_kind, body, expected) => {
    const result = await fetchApprovedWebDocument({
      url: new URL("https://hospital.example/doctors/example"),
      allowedDomains: ["hospital.example"],
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maximumBytes: 500_000,
      userAgent: "codex-gateway-research-test/1.0",
      lookupImpl: async () => [{ address: "202.120.143.40", family: 4 }],
      requestPinnedAddressImpl: async () => ({
        statusCode: 200,
        headers: {
          "content-type": "text/html",
          "content-encoding": "identity"
        },
        bytes: Buffer.from(body, "utf8")
      })
    });

    expect(result.text).toBe(expected);
  }, 1_000);

  it("falls back to the next pinned public address after a connection error", async () => {
    const requestedAddresses: string[] = [];
    const result = await fetchApprovedWebDocument({
      url: new URL("https://hospital.example/doctors/example"),
      allowedDomains: ["hospital.example"],
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maximumBytes: 10_000,
      userAgent: "codex-gateway-research-test/1.0",
      lookupImpl: async () => [
        { address: "202.120.143.40", family: 4 },
        { address: "202.120.143.41", family: 4 }
      ],
      requestPinnedAddressImpl: async (input) => {
        requestedAddresses.push(input.address);
        if (requestedAddresses.length === 1) {
          throw Object.assign(new Error("route unavailable"), {
            code: "ENETUNREACH"
          });
        }
        return {
          statusCode: 200,
          headers: {
            "content-type": "text/plain",
            "content-encoding": "identity"
          },
          bytes: Buffer.from("Verified fallback profile", "utf8")
        };
      }
    });

    expect(requestedAddresses).toEqual([
      "202.120.143.40",
      "202.120.143.41"
    ]);
    expect(result.text).toBe("Verified fallback profile");
  });

  it("parses bounded PubMed, Crossref, ORCID, and general Brave identity metadata", async () => {
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
              pubdate: "2024",
              epubdate: "2023/12/15",
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
            published: { "date-parts": [[2024, 1, 2]] }
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
        expect(url.searchParams.get("q")).toContain("Example Doctor");
        expect(url.searchParams.get("q")).not.toContain("site:");
        return jsonResponse({
          web: {
            results: [
              {
                title: "Example Doctor approved profile",
                url: "https://hospital.example/doctors/example",
                description: "Example Hospital profile"
              },
              {
                title: "Discovered university profile",
                url: "https://new-university.example/people/example",
                description: "Example Doctor at Example Hospital"
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
      publicationYear: 2024,
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
      publicationYear: 2024,
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
    expect(sources).toHaveLength(2);
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

  it("searches the open web once and accepts safe discovered HTTPS hosts", async () => {
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
        return jsonResponse({
          web: {
            results: [
              {
                title: "Example Doctor hospital profile",
                url: "https://hospital.example/doctors/example",
                description: "Approved profile"
              },
              {
                title: "New hospital profile",
                url: "https://new-hospital.example/doctors/example",
                description: "Example Doctor approved profile"
              },
              {
                title: "Unsafe result",
                url: "http://127.0.0.1/internal",
                description: "Must be ignored"
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
    expect(queries).toHaveLength(1);
    expect(queries.every((query) => query.length <= 400)).toBe(true);
    expect(queries[0]).toContain("Example Doctor Example Hospital Cardiology");
    expect(queries[0]).not.toContain("site:");
  });

  it("adds exactly one bounded hospital-site search and labels its candidates", async () => {
    const requests: Array<{ query: string; maximumResults: string | null }> = [];
    const adapters = new LiveResearchAdapters({
      ncbi: {},
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "serpapi",
        apiKey: "serpapi-test-key",
        serpApiEngine: "google",
        allowedDomains: ["hospital.example"],
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
        requests.push({
          query,
          maximumResults: url.searchParams.get("num")
        });
        if (query === '"Example Hospital" official site') {
          return jsonResponse({
            search_metadata: { status: "Success" },
            organic_results: [
              {
                title: "Example Hospital",
                link: "https://hospital.example/",
                snippet: "Official home page"
              },
              {
                title: "Example Hospital information",
                link: "https://second-hospital.example/",
                snippet: "Candidate two"
              },
              {
                title: "Example Hospital information",
                link: "https://third-hospital.example/",
                snippet: "Candidate three"
              },
              {
                title: "Example Hospital information",
                link: "https://fourth-hospital.example/",
                snippet: "Must be excluded by the fixed top-three bound"
              }
            ]
          });
        }
        return jsonResponse({
          search_metadata: { status: "Success" },
          organic_results: [
            {
              title: "Example Doctor profile",
              link: "https://hospital.example/doctors/example",
              snippet: "Example Doctor, Cardiology"
            }
          ]
        });
      },
      approvedDocumentFetchImpl: async (input) => ({
        url: input.url.toString(),
        title: input.url.pathname === "/" ? "Example Hospital" : "Profile",
        text:
          input.url.pathname === "/"
            ? "Example Hospital official home page"
            : "Example Doctor, Cardiology",
        contentSha256: "a".repeat(64),
        sizeBytes: 100
      })
    });

    const sourceIds = await adapters.searchOfficialSources(
      '"Example Doctor" Example Hospital Cardiology doctor profile',
      new AbortController().signal,
      { hospital: "Example Hospital" }
    );

    expect(requests).toHaveLength(2);
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          query: '"Example Doctor" Example Hospital Cardiology doctor profile',
          maximumResults: "2"
        },
        {
          query: '"Example Hospital" official site',
          maximumResults: "3"
        }
      ])
    );
    expect(sourceIds).toHaveLength(4);
    const sources = await Promise.all(
      sourceIds.map((sourceId) =>
        adapters.fetchApprovedSource(
          sourceId,
          new AbortController().signal
        )
      )
    );
    expect(
      sources.find((source) => source?.url.includes("/doctors/example"))
        ?.discoveryKinds
    ).toEqual(["doctor_identity"]);
    expect(
      sources.filter((source) =>
        source?.discoveryKinds?.includes("hospital_official")
      )
    ).toHaveLength(3);
    expect(sources.some((source) => source?.url.includes("fourth"))).toBe(false);
  });

  it("keeps exact identity candidates when the optional hospital search is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      if (url.searchParams.get("q") === '"Example Hospital" official site') {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return jsonResponse({
        search_metadata: { status: "Success" },
        organic_results: [
          {
            title: "Example Doctor profile",
            link: "https://hospital.example/doctors/example",
            snippet: "Example Doctor, Example Hospital, Cardiology"
          }
        ]
      });
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {},
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "serpapi",
        apiKey: "serpapi-test-key",
        serpApiEngine: "google",
        allowedDomains: ["hospital.example"],
        maximumResults: 2
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchOfficialSources(
        '"Example Doctor" Example Hospital Cardiology doctor profile',
        new AbortController().signal,
        { hospital: "Example Hospital" }
      )
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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

  it("retries a malformed successful PubMed search response within the same call", async () => {
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length < 3) {
        return jsonResponse({ error: "temporary malformed response" });
      }
      return jsonResponse({ esearchresult: { idlist: ["1001", "1001", "1002"] } });
    });
    const adapters = new LiveResearchAdapters({
      ncbi: { maximumResults: 5 },
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "direct",
        allowedDomains: ["hospital.example"]
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchPubMed("verified query", new AbortController().signal)
    ).resolves.toEqual(["1001", "1002"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects a PubMed identity search when NCBI drops every identity field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        esearchresult: {
          idlist: ["1001", "1002"],
          querytranslation: "2022:2026[Date - Publication]"
        }
      })
    );
    const adapters = new LiveResearchAdapters({
      ncbi: { maximumResults: 5 },
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "direct",
        allowedDomains: ["hospital.example"]
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchPubMed(
        '("\u59dc\u4fdd\u56fd"[Author] AND "\u5317\u4eac\u5927\u5b66\u4eba\u6c11\u533b\u9662"[Affiliation]) AND (2022:2026[Date - Publication])',
        new AbortController().signal
      )
    ).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies an exhausted malformed PubMed response as a request-scoped upstream payload error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null));
    const adapters = new LiveResearchAdapters({
      ncbi: { maximumResults: 5 },
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "direct",
        allowedDomains: ["hospital.example"]
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    const error = await adapters
      .searchPubMed("verified query", new AbortController().signal)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ResearchExternalServiceError);
    expect(error).toMatchObject({
      name: "ResearchExternalServiceError",
      kind: "invalid_payload"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("skips unavailable discovered pages while explicit seed URLs stay fail-closed", async () => {
    const discoveredAdapters = new LiveResearchAdapters({
      ncbi: {},
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "brave",
        apiKey: "brave-test-key",
        allowedDomains: ["hospital.example"],
        maximumResults: 1
      },
      timeoutMs: 1_000,
      maximumSourceBytes: 10_000,
      userAgent: "codex-gateway-research-test/1.0",
      approvedDocumentFetchImpl: async () => {
        throw new ResearchHttpError(403, null);
      },
      fetchImpl: async () =>
        jsonResponse({
          web: {
            results: [
              {
                title: "Example Doctor profile",
                url: "https://hospital.example/example-doctor",
                description: "Example Doctor, Example Hospital, Cardiology"
              }
            ]
          }
        })
    });
    const discoveredIds = await discoveredAdapters.searchOfficialSources(
      "Example Doctor Example Hospital Cardiology",
      AbortSignal.timeout(5_000)
    );
    expect(discoveredIds).toHaveLength(1);
    await expect(
      discoveredAdapters.fetchApprovedSource(
        discoveredIds[0]!,
        new AbortController().signal
      )
    ).resolves.toBeNull();

    const seededAdapters = new LiveResearchAdapters({
      ncbi: {},
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "direct",
        allowedDomains: ["hospital.example"],
        maximumResults: 1
      },
      timeoutMs: 1_000,
      maximumSourceBytes: 10_000,
      userAgent: "codex-gateway-research-test/1.0",
      approvedDocumentFetchImpl: async () => {
        throw new ResearchHttpError(403, null);
      }
    });
    const seededIds = await seededAdapters.searchOfficialSources(
      "Example Doctor Example Hospital Cardiology",
      AbortSignal.timeout(5_000),
      { seedUrls: ["https://hospital.example/example-doctor"] }
    );
    expect(seededIds).toHaveLength(1);
    await expect(
      seededAdapters.fetchApprovedSource(
        seededIds[0]!,
        new AbortController().signal
      )
    ).rejects.toThrow();
  });

  it("discovers safe identity candidates through one bounded SerpAPI Google search", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      expect(url.origin).toBe("https://serpapi.com");
      expect(url.pathname).toBe("/search.json");
      expect(url.searchParams.get("engine")).toBe("google");
      expect(url.searchParams.get("q")).toBe(
        '"Example Doctor" Example Hospital Cardiology doctor profile'
      );
      expect(url.searchParams.get("num")).toBe("2");
      expect(url.searchParams.get("safe")).toBe("active");
      expect(url.searchParams.get("api_key")).toBe("serpapi-test-key");
      return jsonResponse({
        search_metadata: { status: "Success" },
        organic_results: [
          {
            title: "Example Doctor hospital profile",
            link: "https://hospital.example/doctors/example",
            snippet: "Example Doctor, Example Hospital, Cardiology"
          },
          {
            title: "Unsafe Example Doctor result",
            link: "http://127.0.0.1/internal",
            snippet: "Must be ignored"
          }
        ]
      });
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      orcid: { enabled: false },
      officialWeb: {
        provider: "serpapi",
        apiKey: "serpapi-test-key",
        serpApiEngine: "google",
        allowedDomains: ["hospital.example"],
        maximumResults: 2
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchOfficialSources(
        '"Example Doctor" Example Hospital Cardiology doctor profile',
        new AbortController().signal
      )
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(adapters.budgetHints).toEqual({
      officialSearchRequestUnits: 4
    });
    expect(adapters.versions.official_web).toBe(
      "serpapi-google-bounded-hospital-identity-search-v3+pinned-source-fetch.v2"
    );
  });

  it("adds research-direction intent to Chinese SerpAPI Google identity searches", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      expect(url.searchParams.get("engine")).toBe("google");
      expect(url.searchParams.get("q")).toBe(
        '"沈柏用" 上海交通大学医学院附属瑞金医院 外科 医生 简介 研究方向 研究领域'
      );
      return jsonResponse({
        search_metadata: { status: "Success" },
        organic_results: [
          {
            title: "沈柏用-博士研究生指导教师",
            link: "https://jiankang.usst.edu.cn/doctor/shen-baiyong",
            snippet: "沈柏用，瑞金医院普外科，主要研究方向为胰腺癌。"
          }
        ]
      });
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {},
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "serpapi",
        apiKey: "serpapi-test-key",
        serpApiEngine: "google",
        allowedDomains: ["hospital.example"],
        maximumResults: 5
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchOfficialSources(
        '"沈柏用" 上海交通大学医学院附属瑞金医院 外科 doctor profile',
        new AbortController().signal
      )
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(adapters.versions.official_web).toBe(
      "serpapi-google-bounded-hospital-identity-search-v3+pinned-source-fetch.v2"
    );
  });

  it("localizes Baidu identity intent without dropping the exact doctor name", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      expect(url.searchParams.get("engine")).toBe("baidu");
      expect(url.searchParams.get("q")).toBe(
        '"沈柏用" 上海交通大学医学院附属瑞金医院 外科 医生 简介'
      );
      return jsonResponse({
        search_metadata: { status: "Success" },
        organic_results: [
          {
            title: "沈柏用 - 上海交通大学医学院附属瑞金医院",
            link: "https://www.rjh.com.cn/doctor/shen-baiyong",
            snippet: "沈柏用，外科医生。"
          }
        ]
      });
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {},
      crossref: {},
      orcid: { enabled: false },
      officialWeb: {
        provider: "serpapi",
        apiKey: "serpapi-test-key",
        serpApiEngine: "baidu",
        allowedDomains: ["hospital.example"],
        maximumResults: 5
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });

    await expect(
      adapters.searchOfficialSources(
        '"沈柏用" 上海交通大学医学院附属瑞金医院 外科 doctor profile',
        new AbortController().signal
      )
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(adapters.versions.official_web).toBe(
      "serpapi-baidu-bounded-hospital-identity-search-v3+pinned-source-fetch.v2"
    );
  });

  it("fails SerpAPI responses without exposing provider error details", async () => {
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      orcid: { enabled: false },
      officialWeb: {
        provider: "serpapi",
        apiKey: "serpapi-test-key",
        serpApiEngine: "baidu",
        allowedDomains: ["hospital.example"],
        maximumResults: 1
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
        expect(url.searchParams.get("engine")).toBe("baidu");
        expect(url.searchParams.get("q")).toBe(
          '"Example Doctor" Example Hospital Cardiology 医生 简介'
        );
        expect(url.searchParams.get("q")).not.toContain("doctor profile");
        expect(url.searchParams.get("rn")).toBe("1");
        expect(url.searchParams.get("ct")).toBe("2");
        return jsonResponse({
          search_metadata: { status: "Success" },
          error: "invalid private credential serpapi-test-key"
        });
      }
    });

    const error = await adapters
      .searchOfficialSources(
        '"Example Doctor" Example Hospital Cardiology doctor profile',
        new AbortController().signal
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Official web search provider returned an error."
    );
    expect((error as Error).message).not.toContain("serpapi-test-key");
    expect(adapters.versions.official_web).toBe(
      "serpapi-baidu-bounded-hospital-identity-search-v3+pinned-source-fetch.v2"
    );
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

  it("skips ORCID preflight and returns no identity when ORCID is disabled", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      if (url.pathname.endsWith("/esearch.fcgi")) {
        return jsonResponse({ esearchresult: { idlist: [] } });
      }
      if (url.hostname === "api.crossref.org") {
        return jsonResponse({
          message: {
            title: ["The proximal origin of SARS-CoV-2"],
            "container-title": ["Nature Medicine"],
            author: [{ given: "Kristian", family: "Andersen" }],
            published: { "date-parts": [[2020, 3, 17]] }
          }
        });
      }
      throw new Error(`Unexpected disabled-ORCID URL: ${url.hostname}`);
    });
    const adapters = new LiveResearchAdapters({
      ncbi: {
        email: "operator@example.org",
        maximumResults: 1
      },
      crossref: { mailto: "operator@example.org" },
      orcid: { enabled: false },
      officialWeb: {
        provider: "direct",
        allowedDomains: ["hospital.example"],
        maximumResults: 1
      },
      userAgent: "codex-gateway-research-test/1.0",
      fetchImpl
    });
    const signal = new AbortController().signal;

    await expect(adapters.assertAvailable(signal)).resolves.toBeUndefined();
    await expect(
      adapters.lookupOrcid("0000-0002-1825-0097", signal)
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        ).hostname.includes("orcid")
      )
    ).toBe(false);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
