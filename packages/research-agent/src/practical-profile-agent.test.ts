import { describe, expect, it, vi } from "vitest";
import { practicalProfilePolicy, preparePracticalProfile, type PracticalProfileDraft, type PracticalProfileInput, type PracticalProfileState } from "./practical-profile-agent.js";
import { assemblePracticalProfile, normalizePracticalResultWarnings } from "./practical-profile-output.js";
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
    qa: [
      "Which recent advances are changing evidence-based treatment in cardiology?",
      "Which research directions could improve cardiovascular risk stratification?",
      "What methodological challenges limit validation of cardiac biomarkers?",
      "Where do current clinical trials leave important evidence gaps?",
      "What translational evidence is needed before emerging strategies enter clinical practice?"
    ].map(question => ({ question,
      answer: "The available profile establishes the cardiology field but does not report detailed field evidence, so this remains an open academic discussion point.", citations: [{ sourceId: page.sourceId, passageId: "text_0" }] })), limitations: [] };
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
  it("preserves legacy practical result text and artifact bytes while exposing warning codes", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    responses.push({ draft: f.draft }, { approved: true, draft: f.draft });
    const result = await preparePracticalProfile(f.input);
    if (result.outcome !== "resolved") throw Error("Fixture must resolve");
    const output = assemblePracticalProfile({ ...f.input, canonicalIdentityId: `dci_${"a".repeat(32)}`, draft: result.draft, state: result.state, now: new Date(f.page.accessedAt) });
    const legacy = { ...output, quality: { ...output.quality, warnings: ["教育经历尚未核实。"], status: "passed_with_warnings" as const },
      source_coverage: { ...output.source_coverage, limitations: undefined, warnings: ["教育经历尚未核实。"] } };
    const before = structuredClone(legacy);
    const normalized = normalizePracticalResultWarnings(legacy) as unknown as typeof output;
    expect(normalized.quality.warnings).toEqual(["practical_profile_scope_limited"]);
    expect(normalized.source_coverage.limitations).toEqual(["教育经历尚未核实。"]);
    expect(parseAndValidateDoctorResearchModelOutput(JSON.stringify(normalized))).toMatchObject({ ok: true });
    expect(renderDoctorResearchArtifacts(normalized, "zh-CN", "practical")).toEqual(renderDoctorResearchArtifacts(legacy, "zh-CN", "practical"));
    expect(legacy).toEqual(before);
    expect(normalizePracticalResultWarnings(normalized as unknown as Record<string, unknown>)).toBe(normalized);
  });
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
    expect(output.quality.warnings).toEqual(["practical_profile_scope_limited", "search_excerpt_used"]);
    expect(output.source_coverage.limitations?.join(" ")).toContain("could not be read in full");
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

  it("stops on a repeated draft rejection instead of spending the rest of the call budget", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    // A model that cannot act on the fed-back rejection keeps returning the same
    // violation; that is a contract breach, and reporting it as an exhausted budget
    // would point diagnosis at the wrong cause.
    const biographical = structuredClone(f.draft);
    biographical.qa[0]!.question = "Which aspect of your cardiology work should we discuss?";
    for (let i = 0; i < practicalProfilePolicy.maximumModelCalls; i += 1) responses.push({ draft: biographical });
    const result = await preparePracticalProfile(f.input);
    expect(result).toMatchObject({ outcome: "unresolved", reason: "draft_contract_rejected" });
    expect(f.input.dependencies.generate).toHaveBeenCalledTimes(3);
    expect(3).toBeLessThan(practicalProfilePolicy.maximumModelCalls);
  });

  it("keeps retrying while the rejection reason changes, up to the call budget", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    const tooFewQuestions = structuredClone(f.draft); tooFewQuestions.qa = tooFewQuestions.qa.slice(0, 4);
    const biographical = structuredClone(f.draft);
    biographical.qa[0]!.question = "Which aspect of your cardiology work should we discuss?";
    responses.push({ draft: tooFewQuestions }, { draft: biographical }, { draft: tooFewQuestions }, { draft: f.draft }, { approved: true, draft: f.draft });
    const result = await preparePracticalProfile(f.input);
    expect(result).toMatchObject({ outcome: "resolved", draft: f.draft });
    expect(f.input.dependencies.generate).toHaveBeenCalledTimes(5);
  });

  it("rejects biographical questions and accepts field-oriented academic replacements", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    const biographical = structuredClone(f.draft);
    biographical.qa = [
      "What is your current position?",
      "Which awards have you received?",
      "What is your education history?",
      "Which organization roles do you hold?",
      "What are your team's future plans?"
    ].map(question => ({ question, answer: "Public profile detail.", citations: f.draft.facts[0]!.citations }));
    responses.push({ draft: biographical }, { draft: f.draft }, { approved: true, draft: f.draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved", draft: f.draft });
    const calls = vi.mocked(f.input.dependencies.generate).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1]![0].role).toBe("author");
    expect(calls[1]![0].prompt).toContain("Questions must concern the verified field");
  });

  it("rejects the reported Chinese resume questions and keeps five field-level academic questions", async () => {
    const responses: unknown[] = []; const f = fixture(responses);
    f.input.language = "zh-CN";
    f.input.doctor.name = "吴一龙";
    const biographical = structuredClone(f.draft);
    biographical.qa = [
      "吴一龙教授目前在广东省人民医院担任什么职务？",
      "他的主要研究方向是什么？",
      "他在国内外学术组织中有哪些职务？",
      "他获得过哪些重要荣誉？",
      "他的团队近期有哪些代表性研究成果？"
    ].map(question => ({ question, answer: "公开资料中的个人信息。", citations: f.draft.facts[0]!.citations }));
    const academic = structuredClone(f.draft);
    academic.qa = [
      "肺癌精准治疗领域近期有哪些关键前沿进展？",
      "驱动基因阳性肺癌的耐药机制还存在哪些重要研究方向？",
      "围术期免疫治疗的临床证据应如何评价？",
      "真实世界研究在肺癌分层治疗中面临哪些方法学挑战？",
      "新型生物标志物走向临床应用还需要哪些前瞻性验证？"
    ].map(question => ({ question, answer: "现有资料只确认相关专业领域，具体证据边界仍需结合领域文献讨论。", citations: f.draft.facts[0]!.citations }));
    responses.push({ draft: biographical }, { draft: academic }, { approved: true, draft: academic });
    const result = await preparePracticalProfile(f.input);
    expect(result).toMatchObject({ outcome: "resolved", draft: academic });
    expect(result.outcome === "resolved" && result.draft.qa.map(item => item.question)).toEqual(academic.qa.map(item => item.question));
    expect(f.input.dependencies.generate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["zh-CN", "吴一龙", [
      "与其他的靶向药物相比，该类双抗的耐药机制有何不同？",
      "其他在研的双抗有哪些关键临床试验证据？",
      "与其他对照研究相比，真实世界数据在方法学上有哪些局限？",
      "肺癌精准治疗领域近期有哪些关键前沿进展？",
      "新型生物标志物走向临床应用还需要哪些前瞻性验证？"
    ]],
    ["en", "Alice Example", [
      "What is the position of immunotherapy in first-line treatment of this disease?",
      "How do HER-2 targeted therapies differ in resistance mechanisms?",
      "What trial evidence supports treatment of HER2-low disease?",
      "Which emerging biomarkers are advancing precision therapy?",
      "What validation is still needed before translation into clinical practice?"
    ]]
  ] as const)("accepts %s field questions that mention other treatments, a therapy's position or HER-2", async (language, name, questions) => {
    const responses: unknown[] = []; const f = fixture(responses);
    f.input.language = language;
    f.input.doctor.name = name;
    const draft = structuredClone(f.draft);
    draft.qa = questions.map(question => ({ question, answer: "Field-level reference answer.", citations: f.draft.facts[0]!.citations }));
    responses.push({ draft }, { approved: true, draft });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved", draft });
    expect(f.input.dependencies.generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["zh-CN", "他的主要研究方向是什么？"],
    ["zh-CN", "您如何看待这一领域的争议？"],
    ["en", "What is her current research direction?"],
    ["en", "What is your current job title?"]
  ] as const)("still rejects a %s personal question: %s", async (language, personalQuestion) => {
    const responses: unknown[] = []; const f = fixture(responses);
    f.input.language = language;
    const base = language === "zh-CN" ? [
      "肺癌精准治疗领域近期有哪些关键前沿进展？",
      "驱动基因阳性肺癌的耐药机制还存在哪些重要研究方向？",
      "围术期免疫治疗的临床证据应如何评价？",
      "真实世界研究在肺癌分层治疗中面临哪些方法学挑战？",
      "新型生物标志物走向临床应用还需要哪些前瞻性验证？"
    ] : f.draft.qa.map(item => item.question);
    const withQuestions = (questions: string[]) => ({ ...structuredClone(f.draft),
      qa: questions.map(question => ({ question, answer: "Reference answer.", citations: f.draft.facts[0]!.citations })) });
    const corrected = withQuestions(base);
    responses.push({ draft: withQuestions([personalQuestion, ...base.slice(1)]) }, { draft: corrected }, { approved: true, draft: corrected });
    expect(await preparePracticalProfile(f.input)).toMatchObject({ outcome: "resolved", draft: corrected });
    expect(vi.mocked(f.input.dependencies.generate).mock.calls[1]![0].prompt).toContain("Questions must concern the verified field");
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
