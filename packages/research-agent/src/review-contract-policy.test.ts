import { describe, expect, it } from "vitest";
import { getDefaultMedicalSkillBundle } from "./medical-skill-bundle.js";
import {
  assertReviewedReviewContractPolicy,
  reviewContractPolicy,
  reviewedMedicalSkillBundleSha256
} from "./review-contract-policy.js";
import {
  repairReviewProseStarts,
  validateCompleteReviewPresentationRules
} from "./review-prose-rules.js";

describe("Doctor Research derived review contract", () => {
  it("is bound to the exact reviewed medical-team Skill bundle", () => {
    const bundle = getDefaultMedicalSkillBundle();

    expect(bundle.digest).toBe(reviewedMedicalSkillBundleSha256);
    expect(reviewContractPolicy).toMatchObject({
      responsibility: "medical_team",
      sourceBundleSha256: bundle.digest,
      sections: {
        introduction: { minimum: 800 },
        topic: { minimum: 600, minimumCount: 4, maximumCount: 7 },
        synthesis: { minimum: 800 },
        limitations: { minimum: 600 },
        conclusion: { minimum: 200 }
      }
    });
    expect(() => assertReviewedReviewContractPolicy(bundle.digest)).not.toThrow();
  });

  it("fails closed when an unreviewed Skill bundle is presented", () => {
    expect(() =>
      assertReviewedReviewContractPolicy("0".repeat(64))
    ).toThrow(/requires re-approval/u);
  });

  it("uses the same prose predicates before and after deterministic repair", () => {
    const original = [
      "## 研究进展",
      "",
      "该系统显示 [1]。",
      "",
      "在治疗效果方面，较对照组显著提高 [2]。"
    ].join("\n");
    const before = validateCompleteReviewPresentationRules({
      markdown: original,
      language: "zh-CN",
      hasEmbeddedAuxiliaryOutput: false
    });
    const repaired = repairReviewProseStarts(original, "zh-CN");
    const after = validateCompleteReviewPresentationRules({
      markdown: repaired,
      language: "zh-CN",
      hasEmbeddedAuxiliaryOutput: false
    });

    expect(before).toEqual(
      expect.arrayContaining([
        "review_orphaned_demonstrative_start:paragraph=2",
        "review_orphaned_comparative_start:paragraph=3",
        "review_incomplete_evidence_sentence:paragraph=2"
      ])
    );
    expect(after).toEqual([]);
  });

  it("keeps embedded auxiliary output as a language-independent hard error", () => {
    expect(
      validateCompleteReviewPresentationRules({
        markdown: "## Conclusion\n\nSupported conclusion.",
        language: "en",
        hasEmbeddedAuxiliaryOutput: true
      })
    ).toEqual(["review_embedded_auxiliary_output"]);
  });
});
