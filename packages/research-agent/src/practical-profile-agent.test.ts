import { describe, expect, it, vi } from "vitest";
import { preparePracticalProfile, type PracticalProfileDraft, type PracticalProfileInput, type PracticalProfileState } from "./practical-profile-agent.js";
import { assemblePracticalProfile } from "./practical-profile-output.js";
import { renderDoctorResearchArtifacts } from "./artifacts.js";
import { parseAndValidateDoctorResearchModelOutput } from "./contracts.js";
import { investigationTiming } from "./investigation-timing.js";

function fixture(responses: unknown[]) {
  const page = { sourceId: "src_example_profile", title: "Professional profile", url: "https://hospital.example/profile",
    accessedAt: "2026-09-11T00:00:00.000Z", contentSha256: "a".repeat(64),
    untrustedText: "Alice Example works at Example Hospital in cardiology. Her current clinical role is consultant.",
    navigationLinks: [{ url: "https://hospital.example/career", text: "Career" }] };
  const draft: PracticalProfileDraft = { facts: [{ type: "position", text: "Alice Example is a cardiology consultant.", citations: [{ sourceId: page.sourceId, passageId: "text_0" }] }],
    background: [{ text: "Her public profile identifies her cardiology role at Example Hospital.", citations: [{ sourceId: page.sourceId, passageId: "text_0" }] }],
    qa: Array.from({ length: 5 }, (_, i) => ({ question: `Which aspect of your professional work would you like to discuss (${i + 1})?`,
      answer: "Her published role is cardiology consultant. Specific priorities should be confirmed in conversation.", citations: [{ sourceId: page.sourceId, passageId: "text_0" }] })), limitations: [] };
  let saved: PracticalProfileState | undefined;
  const input: PracticalProfileInput = {
    doctor: { name: "Alice Example", hospital: "Example Hospital", department: "Cardiology", title: null, city: null, orcid: null },
    identity: { name: "Alice Example", institution: "Example Hospital", department: "Cardiology", citations: [
      { aspect: "person", sourceId: page.sourceId, quote: page.untrustedText, explanation: "Verified by independent identity stage." }
    ] }, pages: [page], language: "en",
    dependencies: {
      signal: new AbortController().signal, timing: () => investigationTiming(new Date(page.accessedAt), new Date(page.accessedAt), 570000),
      save: async state => { saved = structuredClone(state); },
      generate: vi.fn(async () => { const value = responses.shift(); if (value instanceof Error) throw value; if (!value) throw new Error("Unexpected model call"); return typeof value === "string" ? value : JSON.stringify(value); }),
      readPage: vi.fn(async () => ({ ...page, sourceId: "src_example_career", url: "https://hospital.example/career" })),
      searchPublications: vi.fn(async () => ["12345"]), readPublication: vi.fn(async () => null), isFatalError: () => false
    }
  };
  return { input, draft, page, saved: () => saved! };
}

describe("Practical profile scope, provenance and durable recovery (scripted model)", () => {
  it.each(["inline_fence", "missing_outer_envelope"])("accepts a complete draft with %s while still requiring factual editing", async defect => {
    const responses: unknown[] = []; const f = fixture(responses);
    const text = JSON.stringify({ draft: f.draft });
    responses.push(defect === "inline_fence" ? "```json\n" + text + "```" : text.slice(0, -1), { approved: true, draft: f.draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved", draft: f.draft });
    const calls = vi.mocked(f.input.dependencies.generate).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]![0].role).toBe("editor");
    expect(JSON.parse(calls[1]![0].prompt).service_timing.request_date).toBe("2026-09-11");
  });

  it.each(["truncated_inner", "trailing_object", "truncated_approval"])("does not infer incomplete content or approval: %s", async defect => {
    const responses: unknown[] = []; const f = fixture(responses);
    const text = JSON.stringify({ draft: f.draft });
    const malformed = defect === "truncated_inner" ? text.slice(0, -2) : defect === "trailing_object" ? text + " {}" : '{"approved":true,"draft":' + JSON.stringify(f.draft);
    responses.push(malformed, { draft: f.draft }, { approved: true, draft: f.draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved" });
    const calls = vi.mocked(f.input.dependencies.generate).mock.calls;
    expect(calls).toHaveLength(3); expect(calls[1]![0].role).toBe("author"); expect(calls[2]![0].role).toBe("editor");
    expect(calls[1]![0].prompt).toContain("invalid_response");
  });

  it("preserves excerpt provenance and qualification in the contract and every delivered file", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    f.input.pages = [{ ...f.page, title: "[Search excerpt; original page unavailable] Professional profile", retrieval: { method: "search_excerpt", query: "Alice Example" } }];
    responses.push({ draft: f.draft }, { approved: true, draft: f.draft });
    const result = await preparePracticalProfile(f.input);
    expect(result.outcome).toBe("resolved"); if (result.outcome !== "resolved") return;
    const output = assemblePracticalProfile({ ...f.input, canonicalIdentityId: `dci_${"a".repeat(32)}`, draft: result.draft, state: result.state, now: new Date(f.page.accessedAt) });
    expect(parseAndValidateDoctorResearchModelOutput(JSON.stringify(output))).toMatchObject({ ok: true });
    expect(output.sources[0]!.retrieval_method).toBe("search_excerpt");
    expect(output.identity_resolution.confidence).toBe("medium");
    expect(output.quality.warnings.join(" ")).toContain("could not be read in full");
    for (const artifact of renderDoctorResearchArtifacts(output, "en", "practical").filter(a => a.kind !== "questions")) {
      expect(artifact.content).toContain("could not be read in full");
    }
    for (const [request] of vi.mocked(f.input.dependencies.generate).mock.calls) {
      expect(JSON.parse(request.prompt).sources[0].retrieval.method).toBe("search_excerpt");
    }
  });

  it("delivers four useful files from a single official profile with zero literature and no academic minimum", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    responses.push({ draft: f.draft }, { approved: true, draft: f.draft });
    const result = await preparePracticalProfile(f.input);
    expect(result.outcome).toBe("resolved"); if (result.outcome !== "resolved") return;
    expect(f.input.dependencies.searchPublications).not.toHaveBeenCalled();
    expect(f.input.dependencies.readPublication).not.toHaveBeenCalled();
    const output = assemblePracticalProfile({ ...f.input, canonicalIdentityId: `dci_${"a".repeat(32)}`, draft: result.draft, state: result.state, now: new Date(f.page.accessedAt) });
    const validated = parseAndValidateDoctorResearchModelOutput(JSON.stringify(output));
    expect(validated, JSON.stringify(validated)).toMatchObject({ ok: true });
    expect(output.review.references).toEqual([]);
    expect(output.source_coverage.literature_sources).toEqual([]);
    expect(output.quality.status).toBe("passed");
    const artifacts = renderDoctorResearchArtifacts(output, "en", "practical");
    expect(artifacts.map(a => a.kind)).toEqual(["profile", "review", "questions", "answers"]);
    expect(artifacts[1]!.content).toContain(f.page.url);
    expect(artifacts[1]!.content).not.toMatch(/Core Evidence Table|Search Report|Abstract|Keywords/);
    expect(artifacts[3]!.content).toContain("not the person's answers or opinions");
    const restored = await preparePracticalProfile({ ...f.input, restoredState: f.saved() });
    expect(restored.outcome).toBe("resolved");
    expect(f.input.dependencies.generate).toHaveBeenCalledTimes(2);
  });

  it("allows the editor to remove an unsupported optional achievement without an extra academic review cycle", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    const bad = structuredClone(f.draft); bad.facts.push({ type: "representative_output", text: "Invented research award", citations: bad.facts[0]!.citations });
    responses.push({ draft: bad }, { approved: true, draft: f.draft });
    const result = await preparePracticalProfile(f.input);
    expect(result).toMatchObject({ outcome: "resolved", draft: f.draft });
    expect(f.input.dependencies.generate).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(f.input.dependencies.generate).mock.calls;
    expect(calls[1]![0].role).toBe("editor");
    expect(calls[1]![0].prompt).toContain(f.page.untrustedText);
  });

  it("reports multiple nonexistent citations together and never approves a fabricated source handle", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    const bad = structuredClone(f.draft); bad.facts[0]!.citations[0]!.passageId = "text_99"; bad.qa[1]!.citations[0]!.sourceId = "src_unread";
    responses.push({ draft: bad }, { draft: f.draft }, { approved: true, draft: bad }, { approved: true, draft: f.draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved", draft: f.draft });
    const calls = vi.mocked(f.input.dependencies.generate).mock.calls;
    expect(calls[1]![0].prompt).toContain("facts/0:"); expect(calls[1]![0].prompt).toContain("qa/1:");
    expect(calls[3]![0].role).toBe("editor");
    expect(calls[3]![0].prompt).toContain("invalid_edited_draft");
  });

  it("survives an optional literature outage using existing reliable information", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    f.input.dependencies.searchPublications = vi.fn(async () => { throw new DOMException("Timed out", "TimeoutError"); });
    responses.push({ actions: [{ type: "search_publications", query: "Alice Example[Author]" }] }, { draft: f.draft }, { approved: true, draft: f.draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved", state: { searches: [{ status: "failed" }] } });
    expect(vi.mocked(f.input.dependencies.generate).mock.calls[1]![0].prompt).toContain("publication_search_failed");
  });

  it("restores a candidate after a transient editorial failure and reuses successful tool results", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    const search = { type: "search_publications", query: "Alice Example[Author]" };
    const read = { type: "read_page", url: "https://hospital.example/career" };
    responses.push({ actions: [search, read] }, { actions: [search, read] }, { draft: f.draft }, new Error("Transient model failure"));
    await expect(preparePracticalProfile(f.input)).rejects.toThrow("Transient model failure");
    expect(f.saved().candidate).toEqual(f.draft);
    responses.push({ approved: true, draft: f.draft });
    expect(await preparePracticalProfile({ ...f.input, restoredState: f.saved() })).toMatchObject({ outcome: "resolved" });
    expect(f.input.dependencies.searchPublications).toHaveBeenCalledTimes(1); expect(f.input.dependencies.readPage).toHaveBeenCalledTimes(1);
    await expect(preparePracticalProfile({ ...f.input, doctor: { ...f.input.doctor, name: "Another Person" }, restoredState: f.saved() })).rejects.toThrow("checkpoint mismatch");
  });

  it("blocks invented URLs and PMIDs without external calls and carries editor feedback with the prior draft", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    responses.push({ actions: [{ type: "read_page", url: "https://unread.example/person" }, { type: "read_publications", pmids: ["999"] }] },
      { draft: f.draft }, { approved: false, issues: ["Please omit the unnecessary ambiguous appointment."] }, { draft: f.draft }, { approved: true, draft: f.draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved" });
    expect(f.input.dependencies.readPage).not.toHaveBeenCalled(); expect(f.input.dependencies.readPublication).not.toHaveBeenCalled();
    const retry = JSON.parse(vi.mocked(f.input.dependencies.generate).mock.calls[3]![0].prompt);
    expect(retry.observations.find((o: { action: string }) => o.action === "editor_needs_evidence").result.previous_draft).toEqual(f.draft);
  });
});
