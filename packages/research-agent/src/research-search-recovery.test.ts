import { describe, expect, it, vi } from "vitest";
import { LiveResearchAdapters } from "./live-adapters.js";
import { ResearchExternalServiceError } from "./safe-http.js";

function adapter(fetchImpl: typeof fetch) {
  return new LiveResearchAdapters({
    ncbi: {}, crossref: {}, orcid: { enabled: false },
    officialWeb: { provider: "serpapi", serpApiEngine: "google", apiKey: "private-test-search-key", allowedDomains: ["hospital.example"] },
    userAgent: "research-search-recovery-test/1.0", fetchImpl
  });
}

describe("search failure recovery", () => {
  it.each([
    { error: new DOMException("private transport details", "TimeoutError"), name: "TimeoutError", kind: undefined },
    { error: new TypeError("private transport details"), name: "ResearchExternalServiceError", kind: "transport" }
  ])("preserves a bounded $name failure for the worker", async ({ error, name, kind }) => {
    const request = vi.fn(async () => { throw error; });
    const caught = await adapter(request).searchOfficialSources('"Example Doctor"', new AbortController().signal).catch((value: unknown) => value);
    expect(request).toHaveBeenCalledTimes(2);
    expect(caught).toMatchObject({ name, ...(kind ? { kind } : {}) });
    if (kind) expect((caught as Error).message).not.toContain("private transport details");
  });

  it.each([
    { status: 401, attempts: 1 }, { status: 403, attempts: 1 },
    { status: 429, attempts: 2 }, { status: 503, attempts: 2 }
  ])("preserves HTTP $status and bounds its attempts", async ({ status, attempts }) => {
    const request = vi.fn(async () => new Response("private-test-search-key", { status }));
    const caught = await adapter(request).searchOfficialSources('"Example Doctor"', new AbortController().signal).catch((value: unknown) => value);
    expect(request).toHaveBeenCalledTimes(attempts);
    expect(caught).toMatchObject({ name: "ResearchHttpError", statusCode: status });
    expect((caught as Error).message).not.toContain("private-test-search-key");
  });

  it("retains invalid JSON classification without exposing the response", async () => {
    const request = vi.fn(async () => new Response("private-test-search-key", { status: 200 }));
    await expect(adapter(request).searchOfficialSources('"Example Doctor"', new AbortController().signal))
      .rejects.toMatchObject({ name: "ResearchExternalServiceError", kind: "invalid_payload" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller cancelled", "AbortError");
    const request = vi.fn(async () => { controller.abort(reason); throw reason; });
    await expect(adapter(request).searchOfficialSources('"Example Doctor"', controller.signal)).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("classifies a processing response without treating it as an empty search", async () => {
    const request = vi.fn(async () => Response.json({ search_metadata: { status: "Processing" } }));
    await expect(adapter(request).searchOfficialSources('"Example Doctor"', new AbortController().signal))
      .rejects.toEqual(new ResearchExternalServiceError("incomplete_response"));
  });

  it("prepares an approved profile without contacting the search provider", async () => {
    const request = vi.fn(async () => { throw new Error("Search must not be used"); });
    const subject = adapter(request);
    expect(await subject.searchOfficialSeedSources(["https://hospital.example/doctor"], new AbortController().signal)).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts an explicitly successful zero-result spelling correction", async () => {
    const request = vi.fn(async () => Response.json({
      search_metadata: { status: "Success" },
      search_information: { total_results: 0, organic_results_state: "Empty showing fixed spelling results" }
    }));
    expect(await adapter(request).searchOfficialSources('"Example Doctor"', new AbortController().signal)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("discovers a hospital leadership page from fetched navigation when it is absent from the index", async () => {
    const subject = new LiveResearchAdapters({
      ncbi: {}, crossref: {}, orcid: { enabled: false },
      officialWeb: { provider: "serpapi", serpApiEngine: "google", apiKey: "private-test-search-key", allowedDomains: ["hospital.example"] },
      userAgent: "research-search-recovery-test/1.0",
      fetchImpl: async () => Response.json({ search_metadata: { status: "Success" }, organic_results: [] }),
      approvedDocumentFetchImpl: async input => ({
        url: input.url.href, title: "Example Hospital", text: "Hospital home page", contentSha256: "a".repeat(64), sizeBytes: 200,
        navigationLinks: [
          { url: "https://hospital.example/leadership", text: "领导团队" },
          { url: "https://untrusted.example/leadership", text: "领导团队" },
          { url: "https://hospital.example/jobs", text: "Jobs" }
        ]
      })
    });
    const signal = new AbortController().signal;
    const ids = await subject.searchOfficialSources('"Example Doctor" Example Hospital', signal, {
      hospital: "Example Hospital", hospitalHomepage: "https://hospital.example/"
    });
    await subject.fetchApprovedSource(ids[0]!, signal);
    const supplement = await subject.searchSupplementalOfficialSources("Example Doctor", signal);
    expect(supplement).toHaveLength(1);
    expect(await subject.fetchApprovedSource(supplement[0]!, signal)).toMatchObject({ url: "https://hospital.example/leadership" });
  });

  it("does not turn a missing result field without an explicit zero count into no results", async () => {
    await expect(adapter(async () => Response.json({ search_metadata: { status: "Success" } }))
      .searchOfficialSources('"Example Doctor"', new AbortController().signal))
      .rejects.toMatchObject({ kind: "invalid_payload" });
  });

  it("records bounded attempts without queries, credentials or provider payloads", async () => {
    const events: unknown[] = [];
    let attempts = 0;
    const subject = new LiveResearchAdapters({
      ncbi: {}, crossref: {}, orcid: { enabled: false },
      officialWeb: { provider: "serpapi", serpApiEngine: "google", apiKey: "private-test-search-key", allowedDomains: ["hospital.example"] },
      userAgent: "research-search-recovery-test/1.0",
      fetchImpl: async () => {
        if (++attempts === 1) throw new DOMException("private transport details", "TimeoutError");
        return Response.json({ search_metadata: { status: "Success", id: "a".repeat(24) }, organic_results: [] });
      },
      onExternalRequest: event => { events.push(event); }
    });
    subject.setRunContext(`drr_${"b".repeat(32)}`);
    await subject.searchOfficialSources('"Private Doctor Query"', new AbortController().signal);
    expect(events).toMatchObject([
      { run_id: `drr_${"b".repeat(32)}`, attempt: 1, outcome: "failed", error_kind: "timeout" },
      { run_id: `drr_${"b".repeat(32)}`, attempt: 2, outcome: "succeeded", search_id: "a".repeat(24) }
    ]);
    const serialized = JSON.stringify(events);
    for (const value of ["private-test-search-key", "Private Doctor Query", "private transport details", "api_key"])
      expect(serialized).not.toContain(value);
  });
});
