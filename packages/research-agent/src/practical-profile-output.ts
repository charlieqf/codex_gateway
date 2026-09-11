import type { DoctorResearchRunInput } from "@codex-gateway/core";
import type { FrozenOfficialSource } from "./adapters.js";
import type { InvestigatedIdentity } from "./identity-investigator.js";
import type { PracticalProfileDraft, PracticalProfileState } from "./practical-profile-agent.js";
import { practicalProfilePolicy } from "./practical-profile-agent.js";
import type { DoctorResearchModelOutput, DoctorResearchSource } from "./contracts.js";
import { markdownInline, markdownHttpsUrl } from "./artifacts.js";

/** Only the factual editor's accepted draft reaches this server-owned assembly. */
export function assemblePracticalProfile(input: {
  doctor: DoctorResearchRunInput["doctor"]; identity: InvestigatedIdentity;
  canonicalIdentityId: string; pages: readonly FrozenOfficialSource[];
  draft: PracticalProfileDraft; state: PracticalProfileState; language: "zh-CN" | "en"; now: Date;
}): DoctorResearchModelOutput {
  const { draft, identity, state } = input;
  const ids = (citations: readonly { sourceId: string }[]) => [...new Set(citations.map(c => c.sourceId))];
  const used = new Set(ids([...identity.citations, ...[...draft.facts, ...draft.background, ...draft.qa].flatMap(r => r.citations)]));
  const pages = [...new Map([...input.pages, ...state.pages].map(p => [p.sourceId, p])).values()].filter(p => used.has(p.sourceId));
  const publications = state.publications.flatMap(p => p.status === "succeeded" && p.value && used.has(`src_pubmed_${p.pmid}`) ? [p.value] : []);
  const sources: DoctorResearchSource[] = pages.map(p => ({ source_id: p.sourceId, source_type: "official_web", title: p.title,
    url: p.url, accessed_at: p.accessedAt, content_sha256: p.contentSha256 }));
  for (const p of publications) {
    if (!p.sourceUrl || !p.accessedAt || !p.contentSha256) throw new Error("Publication provenance is required.");
    sources.push({ source_id: `src_pubmed_${p.pmid}`, source_type: "pubmed", title: p.title,
      url: p.sourceUrl, accessed_at: p.accessedAt, content_sha256: p.contentSha256 });
  }
  if ([...used].some(id => !sources.some(s => s.source_id === id))) throw new Error("Practical profile source closure failed.");
  const profile: DoctorResearchModelOutput["profile"] = {
    positions: [], expertise: [], education_and_career: [], research_directions: [], representative_outputs: [],
    claims: [{ claim_id: "clm_practical_identity", claim_type: "identity", text: `${identity.name} · ${identity.institution} · ${identity.department}`,
      source_ids: ids(identity.citations), verification_status: "verified" }],
    primary_public_source_ids: ids([...identity.citations, ...draft.facts.flatMap(f => f.citations)])
  };
  const fields = { position: "positions", expertise: "expertise", education_and_career: "education_and_career",
    research_direction: "research_directions", representative_output: "representative_outputs" } as const;
  for (const [index, fact] of draft.facts.entries()) {
    profile[fields[fact.type]].push(fact.text);
    profile.claims.push({ claim_id: `clm_practical_${index}`, claim_type: fact.type, text: fact.text,
      source_ids: ids(fact.citations), verification_status: "verified" });
  }
  const warnings = [...new Set([...(identity.limitations ?? []), ...draft.limitations])];
  const references = publications.map(p => ({ reference_id: `ref_pmid_${p.pmid}`, title: p.title, journal: p.journal,
    publication_year: p.publicationYear, pmid: p.pmid, doi: p.doi, verification_status: "verified" as const }));
  const zh = input.language === "zh-CN";
  return {
    schema_version: "doctor_research_model_output.v1",
    doctor: { name: input.doctor.name, hospital: input.doctor.hospital, department: input.doctor.department },
    identity_resolution: { status: "verified", confidence: "high", canonical_identity_id: input.canonicalIdentityId, matched_by: ["institution", "department"] },
    sources, profile,
    review: {
      title: `${input.doctor.name} ${zh ? "专业背景与交流准备" : "Professional Background and Conversation Preparation"}`,
      abstract: draft.background[0]!.text, keywords: [identity.department],
      markdown: draft.background.map(p => markdownInline(p.text) + " " + ids(p.citations).map(id => {
        const source = sources.find(s => s.source_id === id)!;
        return `[${zh ? "来源" : "Source"} ${sources.indexOf(source) + 1}](<${markdownHttpsUrl(source.url)}>)`;
      }).join(" ")).join("\n\n"),
      core_evidence: [], references,
      search_report: { databases: ["public_web", ...(publications.length ? ["pubmed"] : [])], searched_at: input.now.toISOString(),
        queries: state.searches.map(s => s.query), included_count: references.length }
    },
    source_coverage: { literature_sources: publications.length ? ["pubmed"] : [], profile_sources: pages.map(p => p.url),
      cutoff_date: input.now.toISOString().slice(0, 10), warnings },
    predicted_questions: draft.qa.map(p => p.question),
    answers: draft.qa.map((p, index) => ({ question_index: index + 1, answer: p.answer, source_ids: ids(p.citations) })),
    quality: { status: warnings.length ? "passed_with_warnings" : "passed", warnings,
      checks: [practicalProfilePolicy.version, "doctor_identity_resolution", "practical_profile_fact_review", "claim_source_closure", "five_question_answer_contract"] }
  };
}
