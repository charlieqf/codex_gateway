import type { ResearchAdapterBundle } from "./adapters.js";
import type { DoctorResearchContent } from "./contracts.js";
import { countEnglishWords } from "./review-contract-policy.js";

export { countEnglishWords } from "./review-contract-policy.js";

export interface DoctorResearchEvalPolicy {
  language: "zh-CN" | "en";
  minimumReviewContent: number;
  minimumReferences: number;
  maximumQuestionLength: number;
  minimumAnswerContent: number;
  maximumAnswerContent: number;
  forbiddenOutputFragments: readonly string[];
}

export interface DoctorResearchEvalCheck {
  code: string;
  passed: boolean;
  actual?: number | string;
  expected?: number | string;
}

export interface DoctorResearchEvalReport {
  schema_version: "doctor_research_eval_report.v1";
  passed: boolean;
  checks: DoctorResearchEvalCheck[];
  metrics: {
    review_content_count: number;
    reference_count: number;
    citation_count: number;
    question_count: number;
    maximum_question_length: number;
    answer_content_counts: number[];
  };
}

export async function evaluateDoctorResearchResult(
  result: DoctorResearchContent,
  policy: DoctorResearchEvalPolicy,
  adapters: ResearchAdapterBundle,
  signal: AbortSignal
): Promise<DoctorResearchEvalReport> {
  const count =
    policy.language === "zh-CN"
      ? countUnicodeContentCharacters
      : countEnglishWords;
  const reviewContentCount = count(result.review.markdown);
  const questionLengths = result.predicted_questions.map((question) =>
    countUnicodeContentCharacters(question)
  );
  const answerCounts = result.answers.map((answer) => count(answer.answer));
  const citations = extractNumericCitations(result.review.markdown);
  const checks: DoctorResearchEvalCheck[] = [
    thresholdCheck(
      "review_content_minimum",
      reviewContentCount >= policy.minimumReviewContent,
      reviewContentCount,
      policy.minimumReviewContent
    ),
    thresholdCheck(
      "reference_count_minimum",
      result.review.references.length >= policy.minimumReferences,
      result.review.references.length,
      policy.minimumReferences
    ),
    thresholdCheck(
      "questions_exactly_five",
      result.predicted_questions.length === 5,
      result.predicted_questions.length,
      5
    ),
    thresholdCheck(
      "question_length_maximum",
      questionLengths.every(
        (length) => length <= policy.maximumQuestionLength
      ),
      Math.max(0, ...questionLengths),
      policy.maximumQuestionLength
    ),
    {
      code: "answers_match_questions",
      passed:
        result.answers.length === 5 &&
        result.answers.every(
          (answer, index) => answer.question_index === index + 1
        )
    },
    thresholdCheck(
      "answer_length_range",
      answerCounts.every(
        (length) =>
          length >= policy.minimumAnswerContent &&
          length <= policy.maximumAnswerContent
      ),
      answerCounts.join(","),
      `${policy.minimumAnswerContent}-${policy.maximumAnswerContent}`
    ),
    {
      code: "citation_numbers_in_range",
      passed: citations.every(
        (citation) =>
          citation >= 1 && citation <= result.review.references.length
      )
    },
    {
      code: "every_reference_cited",
      passed: result.review.references.every((_, index) =>
        citations.includes(index + 1)
      )
    },
    {
      code: "prompt_injection_not_propagated",
      passed: forbiddenFragmentsAbsent(result, policy.forbiddenOutputFragments)
    }
  ];

  checks.push(
    ...(await verifyReferenceMetadata(result, adapters, signal))
  );
  checks.push(...verifyClaimSourceClosure(result));

  return {
    schema_version: "doctor_research_eval_report.v1",
    passed: checks.every((check) => check.passed),
    checks,
    metrics: {
      review_content_count: reviewContentCount,
      reference_count: result.review.references.length,
      citation_count: citations.length,
      question_count: result.predicted_questions.length,
      maximum_question_length: Math.max(0, ...questionLengths),
      answer_content_counts: answerCounts
    }
  };
}

export function countUnicodeContentCharacters(value: string): number {
  return Array.from(value.normalize("NFC")).filter(
    (character) => !/\s/u.test(character)
  ).length;
}

export function extractNumericCitations(markdown: string): number[] {
  const citations: number[] = [];
  for (const match of markdown.matchAll(/\[([0-9,\s-]+)\]/g)) {
    const groups = match[1]!.split(",").map((group) => group.trim());
    for (const group of groups) {
      const range = /^([0-9]+)-([0-9]+)$/.exec(group);
      if (range) {
        const start = Number.parseInt(range[1]!, 10);
        const end = Number.parseInt(range[2]!, 10);
        if (start <= end && end - start <= 100) {
          for (let value = start; value <= end; value += 1) {
            citations.push(value);
          }
        } else {
          citations.push(Number.NaN);
        }
      } else if (/^[0-9]+$/.test(group)) {
        citations.push(Number.parseInt(group, 10));
      }
    }
  }
  return citations;
}

async function verifyReferenceMetadata(
  result: DoctorResearchContent,
  adapters: ResearchAdapterBundle,
  signal: AbortSignal
): Promise<DoctorResearchEvalCheck[]> {
  const checks: DoctorResearchEvalCheck[] = [];
  for (const reference of result.review.references) {
    const resolved = await Promise.all([
      reference.pmid
        ? adapters.getPubMedMetadata(reference.pmid, signal)
        : Promise.resolve(null),
      reference.doi
        ? adapters.getCrossrefMetadata(reference.doi, signal)
        : Promise.resolve(null)
    ]);
    const expectedCount =
      (reference.pmid === null ? 0 : 1) + (reference.doi === null ? 0 : 1);
    checks.push({
      code: `reference_metadata:${reference.reference_id}`,
      passed:
        expectedCount > 0 &&
        resolved.filter((value) => value !== null).length === expectedCount &&
        resolved.every(
          (value) =>
            value === null ||
            (normalizeMetadataText(value.title) ===
              normalizeMetadataText(reference.title) &&
              normalizeMetadataText(value.journal) ===
                normalizeMetadataText(reference.journal) &&
              value.publicationYear === reference.publication_year)
        )
    });
  }
  return checks;
}

function verifyClaimSourceClosure(
  result: DoctorResearchContent
): DoctorResearchEvalCheck[] {
  const sourceIds = new Set(result.sources.map((source) => source.source_id));
  return result.profile.claims.map((claim) => ({
    code: `claim_source_closure:${claim.claim_id}`,
    passed:
      claim.source_ids.length > 0 &&
      claim.source_ids.every((sourceId) => sourceIds.has(sourceId))
  }));
}

function forbiddenFragmentsAbsent(
  result: DoctorResearchContent,
  fragments: readonly string[]
): boolean {
  const serialized = JSON.stringify(result).normalize("NFC").toLowerCase();
  return fragments.every(
    (fragment) =>
      fragment.length > 0 &&
      !serialized.includes(fragment.normalize("NFC").toLowerCase())
  );
}

function normalizeMetadataText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function thresholdCheck(
  code: string,
  passed: boolean,
  actual: number | string,
  expected: number | string
): DoctorResearchEvalCheck {
  return { code, passed, actual, expected };
}
