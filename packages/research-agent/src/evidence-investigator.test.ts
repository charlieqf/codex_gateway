import { describe, expect, it, vi } from "vitest";
import { investigateDoctorEvidence, type EvidenceInvestigationInput, type EvidenceInvestigationState } from "./evidence-investigator.js";
import type { FrozenOfficialSource, FrozenPublicationMetadata } from "./adapters.js";
import { investigationTiming } from "./investigation-timing.js";

// Entirely synthetic fixtures. These tests verify orchestration and evidence closure,
// not a language model's accuracy on a real doctor.
const page: FrozenOfficialSource = {
  sourceId: "src_directory", url: "https://university.example/people", title: "Hospital directory",
  accessedAt: "2026-09-10T12:00:00Z", contentSha256: "a".repeat(64),
  untrustedText: "Harbour University Hospital\nAlice Example | Endocrinology | Consultant\nBob Example | Cardiology | Professor\nAlice Example publications: Hormone monitoring in adults, PMID 101.",
  navigationLinks: [{ url: "https://university.example/alice", text: "Alice profile" }]
};
const paper: FrozenPublicationMetadata = {
  referenceId: "ref_101", pmid: "101", doi: null, title: "Hormone monitoring in adults", journal: "Example Journal", publicationYear: 2025,
  authors: ["Example A", "Example B"], authorAffiliations: [
    { author: "Example A", affiliations: ["Endocrinology, Harbour University Hospital"] },
    { author: "Example B", affiliations: ["Cardiology, Other University Hospital"] }
  ], abstractText: "An observational study of hormone monitoring in adults.",
  sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/101/", accessedAt: page.accessedAt, contentSha256: "b".repeat(64)
};
const citation = { sourceId: page.sourceId, quote: "Alice Example | Endocrinology | Consultant" };
function conclusion() {
  return { evidence: {
    facts: [{ type: "position", text: "Alice Example 是内分泌科顾问医师。", citations: [citation] }],
    topics: { terms: ["endocrinology"], explanation: "The directory establishes the person's specialty.", citations: [citation] },
    doctorPublications: [{ pmid: "101", author: "Example A", affiliationQuote: "Endocrinology, Harbour University Hospital" as string | null,
      corroboration: [] as Array<{ sourceId: string; quote: string }>, explanation: "The author's own affiliation matches the verified institution and specialty." }],
    fieldPublications: [{ pmid: "101", rationale: "Hormone monitoring is within the established endocrine specialty." }], limitations: [] as string[],
    coreEvidence: [{ pmid: "101", study_type: "Observational study", sample_and_source: "Adults; the abstract does not give a sample size.",
      methods: "Hormone monitoring was studied in adults.", key_results: "The supplied abstract does not report an effect estimate.",
      limitations: "Only an abstract was supplied for this investigation.",
      citations: [{ sourceId: "src_pubmed_101", quote: "An observational study of hormone monitoring in adults." }] }]
  } };
}
function fixture(responses: unknown[], options: { publication?: FrozenPublicationMetadata; state?: EvidenceInvestigationState } = {}) {
  const calls = [...responses];
  const saved: EvidenceInvestigationState[] = [];
  const dependencies = {
    signal: new AbortController().signal,
    searchPubMed: vi.fn(async (_query: string) => ["101"]), readPublication: vi.fn(async (_pmid: string) => options.publication ?? paper),
    readPage: vi.fn(async () => ({ ...page, sourceId: "src_profile", url: "https://university.example/alice" })),
    generate: vi.fn(async (_request: { role: string; prompt: string }) => JSON.stringify(calls.shift() ?? { unresolved: "insufficient_evidence", explanation: "No more evidence." })),
    save: vi.fn(async (state: EvidenceInvestigationState) => { saved.push(structuredClone(state)); })
  };
  const input: EvidenceInvestigationInput = {
    doctor: { name: "Alice Example", hospital: "港湾大学医院", department: "内分泌科", title: null, city: null, orcid: null, officialProfileUrls: [] },
    identity: { name: "Alice Example", institution: "Harbour University Hospital", department: "Endocrinology",
      citations: ["person", "institution", "department", "authority"].map(aspect => ({ ...citation, aspect: aspect as "person", explanation: "Synthetic reviewed identity." })) },
    identityPages: [page], language: "zh-CN", startYear: 2022, endYear: 2026,
    minimumReferences: 1, maximumReferences: 5, profileOnly: false,
    ...(options.state ? { restoredState: options.state } : {}), dependencies
  };
  return { input, dependencies, saved };
}
const search = { actions: [{ type: "search_pubmed", query: '"Example A"[Author]', purpose: "doctor" }] };
const read = { actions: [{ type: "read_publications", pmids: ["101"] }] };
const accept = { accepted: true, issues: [] };

describe("evidence investigation with Agent decisions and mechanical provenance", () => {
  it("reads an explicitly cited PMID from an already read profile without an unnecessary search", async () => {
    const f = fixture([read, conclusion(), accept]);
    let elapsedMs = 350_000;
    f.input.dependencies.timing = () => {
      const result = investigationTiming(new Date(0), new Date(elapsedMs), 900_000);
      elapsedMs += 10_000;
      return result;
    };
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(f.dependencies.readPublication).toHaveBeenCalledWith("101");
    expect(f.dependencies.searchPubMed).not.toHaveBeenCalled();
    expect(JSON.parse(f.dependencies.generate.mock.calls[0]![0].prompt).service_timing.elapsed_ms).toBe(350_000);
    expect(JSON.parse(f.dependencies.generate.mock.calls[1]![0].prompt).service_timing.elapsed_ms).toBe(360_000);
  });

  it("hands already read page text to the next phase and provides the malformed response for correction", async () => {
    const f = fixture([search, read, conclusion(), accept]);
    const malformed = '{"evidence": invalid JSON}';
    f.dependencies.generate.mockResolvedValueOnce(malformed);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    const initial = JSON.parse(f.dependencies.generate.mock.calls[0]![0].prompt);
    expect(initial.pages[0].initial_text).toContain("Alice Example publications:");
    const next = JSON.parse(f.dependencies.generate.mock.calls[1]![0].prompt);
    expect(next.observations[0]).toMatchObject({ action: "invalid_response", result: { previous_response: malformed } });
  });

  it("lets the Agent revise an empty query and preserves translated, reviewed facts without a name-window rule", async () => {
    const first = { actions: [{ type: "search_pubmed", query: '"Alice Example"[Author] AND "administrative title"[Affiliation]', purpose: "doctor" }] };
    const f = fixture([first, search, read, conclusion(), accept]);
    f.dependencies.searchPubMed.mockResolvedValueOnce([]).mockResolvedValueOnce(["101"]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(f.dependencies.searchPubMed.mock.calls).toHaveLength(2);
    expect(f.dependencies.searchPubMed.mock.calls[1]?.[0]).toBe('("Example A"[Author]) AND (2022:2026[Date - Publication])');
    if (result.outcome === "resolved") expect(result.evidence.facts[0]?.text).toContain("顾问医师");
    expect(f.saved[0]?.modelCalls).toBe(1);
  });

  it("rejects borrowing another author's affiliation before invoking semantic review", async () => {
    const bad = conclusion(); bad.evidence.doctorPublications[0]!.author = "Example B";
    const f = fixture([search, read, bad, { unresolved: "insufficient_evidence", explanation: "The matching affiliation belongs to someone else." }]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("unresolved");
    expect(result.state.observations).toContainEqual(expect.objectContaining({ action: "invalid_evidence", result: expect.objectContaining({ message: expect.stringContaining("not another coauthor") }) }));
    expect(f.dependencies.generate.mock.calls.every(call => call[0].role !== "evidence_reviewer")).toBe(true);
  });

  it("supports explicit publication corroboration when author affiliations are missing", async () => {
    const proposed = conclusion();
    proposed.evidence.doctorPublications[0]!.affiliationQuote = null;
    proposed.evidence.doctorPublications[0]!.corroboration = [{ sourceId: page.sourceId, quote: "Alice Example publications: Hormone monitoring in adults, PMID 101." }];
    const f = fixture([search, read, proposed, accept], { publication: { ...paper, authorAffiliations: [] } });
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(result.state.reviewedEvidence?.doctorPublications[0]?.affiliationQuote).toBeNull();
  });

  it("does not accept a matching author name without affiliation or publication corroboration", async () => {
    const proposed = conclusion(); proposed.evidence.doctorPublications[0]!.affiliationQuote = null;
    const f = fixture([search, read, proposed], { publication: { ...paper, authorAffiliations: [] } });
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("unresolved");
    expect(result.state.observations).toContainEqual(expect.objectContaining({ action: "invalid_evidence", result: expect.objectContaining({ message: expect.stringContaining("matching name is insufficient") }) }));
  });

  it("returns semantic objections to the investigator and accepts only the corrected profile", async () => {
    const wrong = conclusion(); wrong.evidence.facts[0]!.text = "Alice is a cardiology professor.";
    wrong.evidence.facts[0]!.citations = [{ sourceId: page.sourceId, quote: "Bob Example | Cardiology | Professor" }];
    const f = fixture([search, read, wrong, { accepted: false, issues: ["The professor role belongs to Bob, not Alice."] }, conclusion(), accept]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(result.state.reviewedEvidence?.facts[0]?.text).not.toContain("professor");
    expect(result.state.observations).toContainEqual({ action: "review_requires_correction", result: {
      issues: ["The professor role belongs to Bob, not Alice."], previous_proposal: wrong.evidence } });
  });

  it("reuses reviewed state and refuses a checkpoint for a different identity", async () => {
    const first = fixture([search, read, conclusion(), accept]);
    const result = await investigateDoctorEvidence(first.input);
    const second = fixture([], { state: result.state });
    expect((await investigateDoctorEvidence(second.input)).outcome).toBe("resolved");
    expect(second.dependencies.generate).not.toHaveBeenCalled();
    expect(second.dependencies.searchPubMed).not.toHaveBeenCalled();
    second.input.doctor.name = "Other Person";
    await expect(investigateDoctorEvidence(second.input)).rejects.toThrow("checkpoint does not match");
  });

  it("persists search reservation before dispatch and does not send when that save fails", async () => {
    const f = fixture([search]);
    f.dependencies.save.mockImplementation(async state => {
      if (state.searches.some(s => s.status === "pending")) throw new Error("Lease lost while reserving search.");
    });
    await expect(investigateDoctorEvidence(f.input)).rejects.toThrow("Lease lost");
    expect(f.dependencies.searchPubMed).not.toHaveBeenCalled();
  });

  it("distinguishes an upstream search failure from a successful empty result across resume", async () => {
    const f = fixture([search, { unresolved: "upstream_unavailable", explanation: "PubMed timed out." }]);
    f.dependencies.searchPubMed.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    const result = await investigateDoctorEvidence(f.input);
    expect(result).toMatchObject({ outcome: "unresolved", reason: "upstream_unavailable", state: { searches: [{ status: "failed" }] } });
    const resumed = fixture([search], { state: result.state });
    resumed.input.policy = { maximumSearchRequests: 1, maximumPublicationRequests: 30, maximumPageRequests: 4, maximumModelCalls: 10 };
    await investigateDoctorEvidence(resumed.input);
    expect(resumed.dependencies.searchPubMed).not.toHaveBeenCalled();
  });

  it("does not read invented URLs or undiscovered publications", async () => {
    const f = fixture([{ actions: [{ type: "read_page", url: "https://university.example/guessed" }, { type: "read_publications", pmids: ["999"] }] }]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("unresolved");
    expect(f.dependencies.readPage).not.toHaveBeenCalled();
    expect(f.dependencies.readPublication).not.toHaveBeenCalled();
  });

  it("requires core quotations to belong to the same paper and preserves reviewed semantic extraction", async () => {
    const wrong = conclusion();
    wrong.evidence.coreEvidence[0]!.citations = [citation];
    const corrected = conclusion();
    corrected.evidence.coreEvidence[0]!.study_type = "Observational cohort; random sampling does not imply randomized treatment.";
    const f = fixture([search, read, wrong, corrected, accept]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(result.state.observations).toContainEqual(expect.objectContaining({ action: "invalid_evidence", result: expect.objectContaining({ message: expect.stringContaining("that row's own publication") }) }));
    expect(result.state.reviewedEvidence?.coreEvidence[0]?.study_type).toBe(corrected.evidence.coreEvidence[0]!.study_type);
  });
});
