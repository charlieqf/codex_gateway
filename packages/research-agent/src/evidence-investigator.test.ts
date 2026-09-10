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
    fieldPublications: [{ pmid: "101", rationale: "Hormone monitoring is within the established endocrine specialty." }],
    limitations: ["The synthetic source provides only this one read publication; no claim of exhaustive coverage is made."] as string[],
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
  it("reports independent record errors together, then reviews only the completely repaired proposal", async () => {
    const bad = structuredClone(conclusion());
    bad.evidence.facts[0]!.citations[0]!.quote = "Invented directory statement.";
    bad.evidence.doctorPublications[0]!.affiliationQuote = null;
    bad.evidence.coreEvidence[0]!.citations[0]!.quote = "Invented publication statement.";
    const f = fixture([read, bad, conclusion(), accept]);
    expect((await investigateDoctorEvidence(f.input)).outcome).toBe("resolved");
    const correction = JSON.parse(f.dependencies.generate.mock.calls[2]![0].prompt);
    const feedback = correction.observations.find((o: { action: string }) => o.action === "invalid_evidence").result.message;
    expect(feedback).toContain("/facts/0:");
    expect(feedback).toContain("/doctorPublications/0:");
    expect(feedback).toContain("/coreEvidence/0:");
    expect(feedback).toContain("src_directory");
    expect(feedback).toContain("src_pubmed_101");
    expect(f.dependencies.generate.mock.calls.map(([call]) => call.role))
      .toEqual(["investigator", "investigator", "investigator", "evidence_reviewer"]);
    const review = JSON.parse(f.dependencies.generate.mock.calls[3]![0].prompt);
    expect(review.proposed).toEqual(conclusion().evidence);
  });

  it.each([false, true])("normalizes the evidence envelope alias before patch overlap checks (overlap: %s)", async overlap => {
    const invalid = conclusion(); invalid.evidence.coreEvidence[0]!.citations[0]!.quote = "Invented citation from nowhere.";
    const f = fixture([read, invalid, { unresolved: "insufficient_evidence" }]);
    const first = await investigateDoctorEvidence(f.input);
    const resumed = fixture([], { state: first.state });
    resumed.dependencies.generate.mockImplementation(async ({ role, prompt }) => {
      if (role === "evidence_reviewer") return JSON.stringify(accept);
      const data = JSON.parse(prompt);
      if (data.observations.some((o: { action: string }) => o.action === "invalid_evidence_patch")) return JSON.stringify({ unresolved: "insufficient_evidence" });
      const replacement = { path: "/evidence/coreEvidence/0/citations/0", value: { sourceId: "src_pubmed_101", passageId: "title" } };
      return JSON.stringify({ evidencePatch: { proposal_sha256: data.pending_proposal.proposal_sha256,
        replacements: overlap ? [replacement, { ...replacement, path: "/coreEvidence/0/citations/0" }] : [replacement] } });
    });
    const result = await investigateDoctorEvidence(resumed.input);
    expect(result.outcome).toBe(overlap ? "unresolved" : "resolved");
    if (overlap) {
      expect(result.state.pendingEvidence).toEqual(invalid.evidence);
      expect(resumed.dependencies.generate.mock.calls.every(([c]) => c.role !== "evidence_reviewer")).toBe(true);
    } else expect(result.state.reviewedEvidence?.coreEvidence[0]?.citations[0]?.quote).toBe(paper.title);
    expect(resumed.dependencies.readPublication).not.toHaveBeenCalled();
  });

  it("retains selected source views across observation eviction and checkpoint recovery without rereading", async () => {
    const pmids = Array.from({ length: 15 }, (_, index) => String(101 + index));
    const focus = [{ pmid: "101", view: "authorship" }, { pmid: "102", view: "abstract" }];
    const f = fixture([search,
      { actions: [{ type: "read_publications", pmids: pmids.slice(0, 10) }], focusPublications: focus },
      { actions: [{ type: "read_publications", pmids: pmids.slice(10) }] },
      { unresolved: "insufficient_evidence" }]);
    f.dependencies.searchPubMed.mockResolvedValue(pmids);
    f.dependencies.readPublication.mockImplementation(async pmid => ({ ...paper, pmid }));
    const first = await investigateDoctorEvidence(f.input);
    expect(first.state.focusedPublications).toEqual(focus);
    expect(first.state.observations.some(o => o.action === "publication" && (o.result as { pmid: string }).pmid === "101")).toBe(false);
    const resumed = fixture([conclusion(), accept], { state: first.state });
    expect((await investigateDoctorEvidence(resumed.input)).outcome).toBe("resolved");
    const prompt = JSON.parse(resumed.dependencies.generate.mock.calls[0]![0].prompt);
    const own = prompt.focused_publications[0];
    const field = prompt.focused_publications[1];
    expect(own).toMatchObject({ pmid: "101", view: "authorship" });
    expect(own.citation_passages).toEqual([{ passageId: "title", quote: paper.title }]);
    const affiliation = own.value.authorAffiliations[0].affiliations[0];
    expect(affiliation.affiliationIndex).toBe(0);
    expect(own.value.affiliationTexts.find((item: { id: string }) => item.id === affiliation.text_id).text)
      .toBe(paper.authorAffiliations![0]!.affiliations[0]);
    expect(field.value).not.toHaveProperty("authorAffiliations");
    expect(field.citation_passages.map((p: { quote: string }) => p.quote).join("")).toContain(paper.abstractText);
    expect(resumed.dependencies.readPublication).not.toHaveBeenCalled();
    expect(resumed.dependencies.searchPubMed).not.toHaveBeenCalled();
  });

  it("compacts repeated affiliation text while preserving each author's order and unassigned affiliations", async () => {
    const texts = ["Department One, Example University", "Department Two, Other University"];
    const authors = Array.from({ length: 20 }, (_, i) => ({ author: `Synthetic ${i}`,
      affiliations: i % 2 ? [...texts].reverse() : [...texts] }));
    const source = { ...paper, authorAffiliations: authors, affiliations: [...texts, "Unassigned Institute"] };
    const f = fixture([{ actions: [{ type: "read_publications", pmids: ["101"], view: "authorship" }],
      focusPublications: [{ pmid: "101", view: "authorship" }] }, { unresolved: "insufficient_evidence" }], { publication: source });
    const result = await investigateDoctorEvidence(f.input);
    const prompt = JSON.parse(f.dependencies.generate.mock.calls[1]![0].prompt);
    const compact = prompt.focused_publications[0].value;
    expect(compact.affiliationTexts).toHaveLength(3);
    const originalText = (id: string) => compact.affiliationTexts.find((item: { id: string }) => item.id === id).text;
    expect(compact.authorAffiliations.map((author: { author: string; affiliations: Array<{ affiliationIndex: number; text_id: string }> }) => {
      expect(author.affiliations.map(a => a.affiliationIndex)).toEqual([0, 1]);
      return { author: author.author, affiliations: author.affiliations.map(a => originalText(a.text_id)) };
    })).toEqual(authors);
    expect(compact.affiliations.map((a: { text_id: string }) => originalText(a.text_id))).toEqual(source.affiliations);
    expect(result.state.publications[0]!.value).toEqual(source);
    expect(prompt.observations).toContainEqual({ action: "publication", result: { pmid: "101", retained_in_focus: true } });
  });

  it("rejects oversized source focus atomically and keeps the prior narrow view usable", async () => {
    const f = fixture([search,
      { ...read, focusPublications: [{ pmid: "101", view: "authorship" }] },
      { actions: [{ type: "read_publications", pmids: ["102"] }],
        focusPublications: [{ pmid: "101", view: "complete" }, { pmid: "102", view: "complete" }] },
      { unresolved: "insufficient_evidence" }]);
    f.dependencies.searchPubMed.mockResolvedValue(["101", "102"]);
    f.dependencies.readPublication.mockImplementation(async pmid => ({ ...paper, pmid, abstractText: "A".repeat(60_000) }));
    const result = await investigateDoctorEvidence(f.input);
    expect(result.state.focusedPublications).toEqual([{ pmid: "101", view: "authorship" }]);
    expect(result.state.observations).toContainEqual(expect.objectContaining({ action: "invalid_focus" }));
    expect(f.dependencies.generate).toHaveBeenCalledTimes(4);
    expect(f.dependencies.generate.mock.calls.every(([call]) => Buffer.byteLength(call.prompt) <= 120_000)).toBe(true);
  });

  it("rejects unknown read views and unread focus without making extra external calls", async () => {
    const f = fixture([{ ...read, focusPublications: [{ pmid: "101", view: "authorship" }] },
      { actions: [{ type: "read_publications", pmids: ["101"], view: "guessed" }],
        focusPublications: [{ pmid: "999", view: "complete" }] },
      { unresolved: "insufficient_evidence" }]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.state.focusedPublications).toEqual([{ pmid: "101", view: "authorship" }]);
    expect(result.state.observations.map(o => o.action)).toEqual(expect.arrayContaining(["invalid_publication_view", "invalid_focus"]));
    expect(f.dependencies.readPublication).toHaveBeenCalledTimes(1);
    expect(f.dependencies.searchPubMed).not.toHaveBeenCalled();
  });

  it.each(["quote", "passageId"])("lets the reviewer assess a personal research fact cited to a read paper (%s)", async mode => {
    const proposal = JSON.parse(JSON.stringify(conclusion()));
    proposal.evidence.facts.push({ type: "research_direction", text: "Alice studies hormone monitoring in adults.",
      citations: [{ sourceId: "src_pubmed_101", ...(mode === "quote" ? { quote: paper.abstractText } : { passageId: "title" }) }] });
    const f = fixture([read, proposal, accept]);
    expect((await investigateDoctorEvidence(f.input)).outcome).toBe("resolved");
    const review = JSON.parse(f.dependencies.generate.mock.calls[2]![0].prompt);
    expect(review.publications[0]).toMatchObject({ pmid: "101", journal: paper.journal, abstractText: paper.abstractText });
    expect(review.proposed.facts[1].citations[0].quote).toBe(mode === "quote" ? paper.abstractText : paper.title);
  });

  it("includes metadata for a profile-cited paper outside the selected lists and requires independent attribution review", async () => {
    const proposal = JSON.parse(JSON.stringify(conclusion()));
    proposal.evidence.doctorPublications = [];
    proposal.evidence.fieldPublications = [];
    proposal.evidence.coreEvidence = [];
    proposal.evidence.topics = { terms: [], explanation: "Only a profile was requested.", citations: [] };
    proposal.evidence.facts = [{ type: "representative_output", text: "Alice authored this paper.", citations: [{ sourceId: "src_pubmed_101", passageId: "title" }] }];
    const f = fixture([read, proposal, { accepted: false, issues: ["The paper belongs to a different person."] }, { unresolved: "insufficient_evidence" }],
      { publication: { ...paper, authors: ["Other C"], authorAffiliations: [{ author: "Other C", affiliations: ["Another hospital"] }] } });
    f.input.profileOnly = true;
    expect((await investigateDoctorEvidence(f.input)).outcome).toBe("unresolved");
    const review = JSON.parse(f.dependencies.generate.mock.calls[2]![0].prompt);
    expect(review.publications[0]).toMatchObject({ authors: ["Other C"], authorAffiliations: [{ author: "Other C", affiliations: ["Another hospital"] }] });
  });
  it("resolves read passage and selected-author affiliation IDs to original text, retaining semantic review", async () => {
    const proposal = conclusion();
    const selected = JSON.parse(JSON.stringify(proposal));
    selected.evidence.facts[0].citations = [{ sourceId: page.sourceId, passageId: "text_0" }];
    selected.evidence.coreEvidence[0].citations = [{ sourceId: "src_pubmed_101", passageId: "title" }];
    delete selected.evidence.doctorPublications[0].affiliationQuote;
    selected.evidence.doctorPublications[0].affiliationIndex = 0;
    const f = fixture([read, selected, accept]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(result.state.reviewedEvidence?.facts[0]?.citations[0]?.quote).toBe(page.untrustedText);
    expect(result.state.reviewedEvidence?.coreEvidence[0]?.citations[0]?.quote).toBe(paper.title);
    expect(result.state.reviewedEvidence?.doctorPublications[0]?.affiliationQuote).toBe("Endocrinology, Harbour University Hospital");
    const review = JSON.parse(f.dependencies.generate.mock.calls[2]![0].prompt);
    expect(review.publications[0].abstractText).toBe(paper.abstractText);
    expect(review.proposed.facts[0].citations[0]).not.toHaveProperty("passageId");
  });

  it("restores an invalid full proposal, applies a small correction, and independently reviews the complete result", async () => {
    const invalid = conclusion(); invalid.evidence.coreEvidence[0]!.citations[0]!.quote = "This quotation was invented.";
    const f = fixture([read, invalid, { unresolved: "insufficient_evidence" }]);
    const first = await investigateDoctorEvidence(f.input);
    expect(first.state.pendingEvidence).toEqual(invalid.evidence);
    const resumed = fixture([], { state: first.state });
    resumed.dependencies.generate.mockImplementation(async ({ role, prompt }) => {
      const data = JSON.parse(prompt);
      if (role === "evidence_reviewer") {
        expect(data.proposed.coreEvidence[0].citations[0].quote).toBe(paper.title);
        expect(data.proposed.fieldPublications).toEqual(invalid.evidence.fieldPublications);
        return JSON.stringify(accept);
      }
      return JSON.stringify({ evidencePatch: { proposal_sha256: data.pending_proposal.proposal_sha256,
        replacements: [{ path: "/coreEvidence/0/citations/0", value: { sourceId: "src_pubmed_101", passageId: "title" } }] } });
    });
    expect((await investigateDoctorEvidence(resumed.input)).outcome).toBe("resolved");
    expect(resumed.dependencies.readPublication).not.toHaveBeenCalled();
    expect(resumed.dependencies.searchPubMed).not.toHaveBeenCalled();
    expect(resumed.dependencies.generate).toHaveBeenCalledTimes(2);
  });

  it.each(["stale", "missing_path", "prototype", "overlap", "unknown_passage"])("refuses invalid proposal repairs without partial acceptance: %s", async kind => {
    const invalid = conclusion(); invalid.evidence.coreEvidence[0]!.citations[0]!.quote = "This quotation was invented.";
    const f = fixture([read, invalid]);
    f.dependencies.generate.mockImplementation(async ({ prompt }) => {
      const data = JSON.parse(prompt);
      if (!data.read_publications.length) return JSON.stringify(read);
      if (!data.pending_proposal) return JSON.stringify(invalid);
      if (data.observations.some((o: { action: string }) => o.action === "invalid_evidence_patch") || data.remaining.model_calls_including_review < 3) return JSON.stringify({ unresolved: "insufficient_evidence" });
      const replacement = { path: "/coreEvidence/0/citations/0", value: { sourceId: "src_pubmed_101", passageId: kind === "unknown_passage" ? "text_999" : "title" } };
      if (kind === "missing_path") replacement.path = "/coreEvidence/999/citations/0";
      if (kind === "prototype") replacement.path = "/__proto__/polluted";
      return JSON.stringify({ evidencePatch: { proposal_sha256: kind === "stale" ? "0".repeat(64) : data.pending_proposal.proposal_sha256,
        replacements: kind === "overlap" ? [replacement, { path: "/coreEvidence/0", value: invalid.evidence.coreEvidence[0] }] : [replacement] } });
    });
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("unresolved");
    expect(result.state.reviewedEvidence).toBeNull();
    expect(f.dependencies.generate.mock.calls.every(([c]) => c.role !== "evidence_reviewer")).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it.each([true, false])("allows reviewed field context only with a professional-remit anchor (%s)", async (hasAnchor) => {
    const proposal = conclusion();
    proposal.evidence.doctorPublications = [];
    proposal.evidence.limitations = ["No own publication was verified; this synthetic field review is not exhaustive."];
    proposal.evidence.topics.citations = [
      ...(hasAnchor ? [citation] : []), { sourceId: "src_pubmed_101", quote: paper.abstractText! }
    ];
    const f = fixture([read, proposal, hasAnchor ? accept : { unresolved: "insufficient_evidence" }]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe(hasAnchor ? "resolved" : "unresolved");
    expect(f.dependencies.generate.mock.calls.some(([call]) => call.role === "evidence_reviewer")).toBe(hasAnchor);
  });
  it("repairs an unambiguous misplaced limitations field without rewriting its content or skipping review", async () => {
    const { limitations, ...evidence } = conclusion().evidence;
    const f = fixture([read, { evidence, limitations }, accept]);
    const result = await investigateDoctorEvidence(f.input);
    expect(result.outcome).toBe("resolved");
    expect(result.state.reviewedEvidence?.limitations).toEqual(limitations);
    expect(f.dependencies.generate.mock.calls[2]![0].role).toBe("evidence_reviewer");
  });
  it("carries the medical reference target and requires a below-target disclosure before semantic review", async () => {
    const missing = conclusion(); missing.evidence.limitations = [];
    const f = fixture([read, missing, conclusion(), accept]);
    expect((await investigateDoctorEvidence(f.input)).outcome).toBe("resolved");
    const initial = JSON.parse(f.dependencies.generate.mock.calls[0]![0].prompt);
    expect(initial).toMatchObject({ minimum_field_references: 1, target_field_references: 5 });
    const correction = JSON.parse(f.dependencies.generate.mock.calls[2]![0].prompt);
    expect(correction.observations).toContainEqual(expect.objectContaining({ action: "invalid_evidence",
      result: expect.objectContaining({ message: expect.stringContaining("safety minimum is not the target") }) }));
    const review = JSON.parse(f.dependencies.generate.mock.calls[3]![0].prompt);
    expect(review.reference_coverage).toMatchObject({ target: 5, selected: 1 });
  });
  it("reads an explicitly cited PMID from an already read profile without an unnecessary search", async () => {
    const f = fixture([{ ...read, workingNotes: "PMID 101 is explicitly linked in the profile; verify its author affiliation before claiming ownership." }, conclusion(), accept]);
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
    expect(JSON.parse(f.dependencies.generate.mock.calls[1]![0].prompt).working_notes).toContain("verify its author affiliation");
    const reviewer = JSON.parse(f.dependencies.generate.mock.calls[2]![0].prompt);
    expect(reviewer.publications[0]).toMatchObject({ abstractText: paper.abstractText,
      selectedAuthorAffiliations: [{ author: "Example A", affiliations: ["Endocrinology, Harbour University Hospital"] }] });
    expect(reviewer.publications[0].selectedAuthorAffiliations).toHaveLength(1);
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
