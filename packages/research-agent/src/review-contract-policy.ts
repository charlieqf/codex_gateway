export const reviewedMedicalSkillBundleSha256 =
  "6d5e839f942f87f1064a6d855c37b54302300aacd700360aa5fef8907a2fa351";

export const reviewContractPolicy = Object.freeze({
  policyVersion: "doctor_research_review_contract.v1",
  responsibility: "medical_team",
  sourceSkill: "docs/research/采访skill/doctor-research-query/SKILL.md",
  sourceBundleSha256: reviewedMedicalSkillBundleSha256,
  title: {
    minimumHanCharacters: 8,
    minimumEnglishWords: 6
  },
  abstract: {
    zhCN: {
      minimum: 300,
      maximum: 500,
      nearMinimum: 260,
      repairFloor: 150,
      targetMinimum: 340,
      targetMaximum: 450
    },
    en: {
      minimum: 120,
      maximum: 350,
      nearMinimum: 100,
      repairFloor: 60
    }
  },
  sections: {
    introduction: { minimum: 800, requiredCount: 1 },
    topic: {
      minimum: 600,
      promptTargetMinimum: 750,
      minimumCount: 4,
      maximumCount: 7,
      bodyFragmentCount: 4
    },
    synthesis: { minimum: 800, requiredCount: 1 },
    limitations: { minimum: 600, requiredCount: 1 },
    conclusion: { minimum: 200, requiredCount: 1 }
  },
  keywords: { minimumCount: 3, maximumCount: 12 },
  coreEvidence: {
    minimumCount: 3,
    maximumCount: 8,
    targetReferenceCount: 40
  },
  questions: { requiredCount: 5 },
  answers: { requiredCount: 5 }
} as const);

export function assertReviewedReviewContractPolicy(
  activeBundleSha256: string
): void {
  if (activeBundleSha256 !== reviewContractPolicy.sourceBundleSha256) {
    throw new Error(
      "Medical-team Skill bundle changed; the derived review contract requires re-approval."
    );
  }
}

export function countHanCharacters(value: string): number {
  return Array.from(value.normalize("NFC")).filter((character) =>
    /\p{Script=Han}/u.test(character)
  ).length;
}

export function countEnglishWords(value: string): number {
  return (
    value
      .normalize("NFC")
      .match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? []
  ).length;
}

export function formatReviewContractEnglishCount(value: number): string {
  const words = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve"
  ];
  return words[value] ?? String(value);
}

export function countReviewContractContent(
  value: string,
  language: "zh-CN" | "en"
): number {
  return language === "zh-CN"
    ? countHanCharacters(value)
    : countEnglishWords(value);
}
