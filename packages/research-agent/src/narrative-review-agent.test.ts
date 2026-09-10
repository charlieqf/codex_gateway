import { describe, expect, it } from "vitest";
import type { DoctorResearchModelDraft } from "./contracts.js";
import { NarrativeReviewBudgetError, narrativeCandidateHash, reviewNarrativeWithAgent, splitNarrativeDiagnostics } from "./narrative-review-agent.js";

const draft = (): DoctorResearchModelDraft => ({
  schema_version: "doctor_research_model_draft.v1",
  profile: { positions: [], expertise: [], education_and_career: [], research_directions: [], representative_outputs: [], claims: [], primary_public_source_ids: [] },
  review: { title: "Evidence review", abstract: "A cautious synthesis.", keywords: ["evidence"],
    markdown: "## Evidence\n\nThe seven studies reported an association. This study design does not establish causality.[1]",
    core_evidence: [{ reference_id: "ref_1", study_type: "observational", sample_and_source: "Seven studies", methods: "Synthesis", key_results: "An association", limitations: "Causality not established" }] },
  predicted_questions: ["What is known?"], answers: [{ question_index: 1, answer: "An association.", source_ids: ["src_1"] }]
});

const evidence = { references: [{ citation: 1, source_id: "src_1", title: "Observational synthesis", abstract: "Seven studies reported an association. ".repeat(200) + "END_OF_COMPLETE_ABSTRACT" }] };
const inspect = () => ({ blocking: [], observations: ["numeric_evidence_closure:review_3:7"] });
function payload(prompt: string) { return JSON.parse(prompt.split("INDEPENDENT NARRATIVE REVIEW\n\n")[1]!); }
function decision(prompt: string, overrides: Record<string, unknown> = {}) {
  return { schema_version: "doctor_narrative_review.v1", candidate_sha256: payload(prompt).candidate_sha256,
    decision: "accept", checks: { citations: "pass", numerical_claims: "pass", evidence_scope: "pass", coherence: "pass", questions_answers: "pass" },
    explanation: "Reviewed the complete cited source; the seven-study wording is consistent and causal inference is explicitly excluded.", replacements: [], ...overrides };
}

describe("narrative review Agent boundary", () => {
  it("separates semantic observations from hard identifier, markup and length checks", () => {
    expect(splitNarrativeDiagnostics(["numeric_evidence_closure:p1:7", "causal_claim_evidence_grade:paragraph=2", "review_orphaned_demonstrative_start:paragraph=2", "citation_reference_closure", "review_content_minimum:10/5000", "unsafe_model_markup:raw_url"])).toEqual({
      blocking: ["citation_reference_closure", "review_content_minimum:10/5000", "unsafe_model_markup:raw_url"],
      observations: ["numeric_evidence_closure:p1:7", "causal_claim_evidence_grade:paragraph=2", "review_orphaned_demonstrative_start:paragraph=2"]
    });
  });

  it("requires a real independent review even when code has no blocking findings, retaining full abstracts", async () => {
    let calls = 0;
    const initial = draft();
    const result = await reviewNarrativeWithAgent({ draft: initial, language: "en", contract: "Medical contract", evidence, maximumCalls: 3, inspect,
      async generate(request) { calls++; expect(request.prompt).toContain("END_OF_COMPLETE_ABSTRACT"); expect(request.system).toContain("A matching number alone is not proof"); return JSON.stringify(decision(request.prompt)); }
    });
    expect(calls).toBe(1);
    expect(result?.draft).toEqual(initial);
  });

  it("preserves untouched evidence and requires a subsequent independent review of edits", async () => {
    const initial = draft();
    const hashes: string[] = [];
    const result = await reviewNarrativeWithAgent({ draft: initial, language: "en", contract: "Medical contract", evidence, maximumCalls: 3, inspect,
      async generate({ prompt, call }) {
        const data = payload(prompt); hashes.push(data.candidate_sha256);
        if (call === 1) {
          const target = data.editable_targets.find((item: { target_id: string }) => item.target_id === "review_block_2");
          expect(target).not.toHaveProperty("original_sha256");
          return JSON.stringify(decision(prompt, { decision: "revise", replacements: [{ target_id: target.target_id, value: "Seven studies reported an association without causal inference.[1]" }] }));
        }
        expect(prompt).toContain("Seven studies reported an association without causal inference.");
        return JSON.stringify(decision(prompt));
      }
    });
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(result?.draft.review.core_evidence).toEqual(initial.review.core_evidence);
    expect(result?.draft.profile).toEqual(initial.profile);
    expect(initial).toEqual(draft());
  });

  it.each(["stale_candidate", "edit_on_accept", "missing_checks", "uncertain_check", "immutable_target", "wrong_target_type", "duplicate_target", "no_subsequent_review"])("fails closed for %s", async kind => {
    const result = await reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence, maximumCalls: 1, inspect,
      async generate({ prompt }) {
        const data = payload(prompt);
        const target = data.editable_targets[0];
        const patch: { target_id: string; value: unknown } = { target_id: target.target_id, value: "Revised evidence review" };
        const base = decision(prompt);
        if (kind === "stale_candidate") base.candidate_sha256 = "0".repeat(64);
        if (kind === "missing_checks") base.checks = {} as typeof base.checks;
        if (kind === "uncertain_check") base.checks.numerical_claims = "uncertain";
        if (["edit_on_accept", "immutable_target", "wrong_target_type", "duplicate_target", "no_subsequent_review"].includes(kind)) {
          base.decision = kind === "edit_on_accept" ? "accept" : "revise";
          if (kind === "immutable_target") patch.target_id = "immutable_profile";
          if (kind === "wrong_target_type") patch.value = [];
          base.replacements = (kind === "duplicate_target" ? [patch, patch] : [patch]) as never[];
        }
        return JSON.stringify(base);
      }
    });
    expect(result).toBeNull();
  });

  it("rejects a stale batch after block renumbering and reports invalid batches without partial edits", async () => {
    const initial = draft();
    let originalHash = "";
    let revisedHash = "";
    const result = await reviewNarrativeWithAgent({ draft: initial, language: "en", contract: "Medical contract", evidence, maximumCalls: 4, inspect,
      async generate({ prompt, call }) {
        const data = payload(prompt);
        if (call === 1) {
          originalHash = data.candidate_sha256;
          return JSON.stringify(decision(prompt, { decision: "revise", replacements: [{ target_id: "review_block_1", value: "## Changed heading\n\nNew paragraph.[1]" }] }));
        }
        if (call === 2) {
          revisedHash = data.candidate_sha256;
          expect(revisedHash).not.toBe(originalHash);
          expect(data.prior_reviews).toHaveLength(1);
          expect(data.prior_reviews[0].disposition).toBe("revisions_applied_require_review");
          return JSON.stringify(decision(prompt, { decision: "revise", candidate_sha256: originalHash, replacements: [{ target_id: "review_block_2", value: "Wrong stale target" }] }));
        }
        if (call === 3) {
          expect(data.candidate_sha256).toBe(revisedHash);
          expect(data.prior_feedback[0]).toBe("narrative_decision_invalid_schema_or_hash");
          return JSON.stringify(decision(prompt, { decision: "revise", explanation: "Recheck whether the source reports symptomatic or asymptomatic participants.", replacements: [{ target_id: "title", value: "Must not partially apply" }, { target_id: "answers", value: [] }] }));
        }
        expect(data.candidate_sha256).toBe(revisedHash);
        expect(data.prior_feedback.join(" ")).toContain("replacement[1]: answers requires five ordered objects");
        expect(data.prior_reviews).toHaveLength(2);
        expect(data.prior_reviews[1].explanation).toContain("symptomatic or asymptomatic");
        expect(data.prior_reviews[1].disposition).toContain("batch_rejected_no_changes");
        return JSON.stringify(decision(prompt));
      }
    });
    expect(result?.draft.review.title).toBe(initial.review.title);
    expect(result?.draft.review.markdown).toContain("New paragraph.[1]");
    expect(result?.draft.review.markdown).not.toContain("Wrong stale target");
  });

  it("cannot override a structural failure with semantic approval", async () => {
    const result = await reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence, maximumCalls: 1,
      inspect: () => ({ blocking: ["citation_reference_closure"], observations: [] }),
      async generate({ prompt }) { return JSON.stringify(decision(prompt)); }
    });
    expect(result).toBeNull();
  });

  it.each([true, false])("accepts only an unambiguous surrounding JSON fence (single: %s)", async single => {
    const result = await reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence, maximumCalls: 1, inspect,
      async generate({ prompt }) {
        const fenced = "```json\n" + JSON.stringify(decision(prompt)) + "\n```";
        return single ? fenced : "Commentary\n" + fenced + "\n{}";
      }
    });
    expect(result !== null).toBe(single);
  });

  it.each([false, true])("owns protocol metadata while preserving candidate binding (stale: %s)", async stale => {
    const result = await reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence, maximumCalls: 1, inspect,
      async generate({ prompt }) { return JSON.stringify(decision(prompt, { schema_version: "provider_invented_label.v99", ...(stale ? { candidate_sha256: "0".repeat(64) } : {}) })); }
    });
    expect(result !== null).toBe(!stale);
  });

  it("rejects unsupported claims even when substring checks found nothing", async () => {
    const result = await reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence, maximumCalls: 3, inspect: () => ({ blocking: [], observations: [] }),
      async generate({ prompt }) { return JSON.stringify(decision(prompt, { decision: "reject", explanation: "The evidence cannot establish the claimed clinical benefit." })); }
    });
    expect(result).toBeNull();
  });

  it("propagates provider failure unchanged for workflow classification and recovery", async () => {
    const failure = new Error("Provider timeout");
    await expect(reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence, maximumCalls: 3, inspect,
      async generate() { throw failure; }
    })).rejects.toBe(failure);
  });

  it("reports oversized evidence as a resource failure before a model request", async () => {
    let called = false;
    await expect(reviewNarrativeWithAgent({ draft: draft(), language: "en", contract: "Medical contract", evidence: "x".repeat(240_000), maximumCalls: 1, inspect,
      async generate() { called = true; return "{}"; }
    })).rejects.toBeInstanceOf(NarrativeReviewBudgetError);
    expect(called).toBe(false);
  });
});
