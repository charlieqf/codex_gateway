import { describe, expect, it } from "vitest";
import {
  allowsBoundedRepairConvergence,
  applyReviewSectionRepair,
  createReviewSectionRepairTarget,
  listReviewSectionSlices,
  selectPeerReviewConvergenceTarget,
  type ReviewSectionRepairDecision
} from "./review-section-repair.js";

const markdown = [
  "preface retained byte-for-byte\r\n",
  "## Introduction\r\n\r\nOriginal introduction [1].\r\n\r\n",
  "## Topic A\r\n\r\nOriginal topic [2].\r\n\r\n",
  "## Conclusion\r\n\r\nOriginal conclusion [3].\r\n"
].join("");

describe("Doctor Research targeted section repair", () => {
  it("replaces only the hash-bound failed section", () => {
    const before = listReviewSectionSlices(markdown);
    const target = createReviewSectionRepairTarget({
      markdown,
      sectionIndex: 1,
      allowedCitationNumbers: [2]
    })!;
    const decision: ReviewSectionRepairDecision = {
      schema_version: "doctor_research_section_repair.v1",
      section_id: target.sectionId,
      original_sha256: target.sha256,
      replacement: "## Topic A\n\nRepaired topic using closed evidence [2]."
    };

    const repaired = applyReviewSectionRepair({ markdown, target, decision });
    const after = listReviewSectionSlices(repaired!);

    expect(repaired).not.toBeNull();
    expect(repaired!.slice(0, before[1]!.start)).toBe(
      markdown.slice(0, before[1]!.start)
    );
    expect(repaired!.slice(after[1]!.end)).toBe(
      markdown.slice(before[1]!.end)
    );
    expect(after[0]!.rawText).toBe(before[0]!.rawText);
    expect(after[2]!.rawText).toBe(before[2]!.rawText);
    expect(after[1]!.rawText).toContain("Repaired topic");
  });

  it("rejects stale hashes, wrong section IDs, and citation expansion", () => {
    const target = createReviewSectionRepairTarget({
      markdown,
      sectionIndex: 1,
      allowedCitationNumbers: [2]
    })!;
    const base: ReviewSectionRepairDecision = {
      schema_version: "doctor_research_section_repair.v1",
      section_id: target.sectionId,
      original_sha256: target.sha256,
      replacement: "## Topic A\n\nRepaired topic [2]."
    };

    expect(
      applyReviewSectionRepair({
        markdown,
        target,
        decision: { ...base, original_sha256: "0".repeat(64) }
      })
    ).toBeNull();
    expect(
      applyReviewSectionRepair({
        markdown,
        target,
        decision: { ...base, section_id: "review_section_3" }
      })
    ).toBeNull();
    expect(
      applyReviewSectionRepair({
        markdown,
        target,
        decision: {
          ...base,
          replacement: "## Topic A\n\nUnsupported reference [3]."
        }
      })
    ).toBeNull();
  });

  it("fails closed instead of converging across independent hard gates", () => {
    expect(
      allowsBoundedRepairConvergence(
        ["numeric_evidence_closure", "answer_length_contract"],
        false
      )
    ).toBe(false);
    expect(
      allowsBoundedRepairConvergence(
        ["review_content_minimum", "review_topic_section_minimum"],
        true
      )
    ).toBe(true);
    expect(
      allowsBoundedRepairConvergence(["review_title_language_contract"], false)
    ).toBe(true);
  });

  it("binds peer convergence to the only failing review field", () => {
    expect(
      selectPeerReviewConvergenceTarget([
        "review_abstract_length_contract"
      ])
    ).toBe("abstract");
    expect(
      selectPeerReviewConvergenceTarget([
        "review_section_contract"
      ])
    ).toBe("markdown");
    expect(
      selectPeerReviewConvergenceTarget([
        "review_abstract_length_contract",
        "review_section_contract"
      ])
    ).toBeNull();
    expect(
      selectPeerReviewConvergenceTarget(["answer_length_contract"])
    ).toBeNull();
    expect(
      selectPeerReviewConvergenceTarget(["review_keywords_contract"])
    ).toBeNull();
  });
});
