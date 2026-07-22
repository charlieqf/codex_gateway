import { createHash } from "node:crypto";

export interface ReviewSectionSlice {
  sectionId: string;
  index: number;
  heading: string;
  start: number;
  end: number;
  rawText: string;
  sha256: string;
}

export interface ReviewSectionRepairTarget extends ReviewSectionSlice {
  allowedCitationNumbers: readonly number[];
}

export interface ReviewSectionRepairDecision {
  schema_version: "doctor_research_section_repair.v1";
  section_id: string;
  original_sha256: string;
  replacement: string;
}

export function listReviewSectionSlices(
  markdown: string
): ReviewSectionSlice[] {
  const headings = [...markdown.matchAll(/^##(?!#)\s+(.+?)\s*$/gmu)];
  return headings.map((heading, index) => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? markdown.length;
    const rawText = markdown.slice(start, end);
    return {
      sectionId: `review_section_${index + 1}`,
      index,
      heading: heading[1]!.trim(),
      start,
      end,
      rawText,
      sha256: sha256(rawText)
    };
  });
}

export function createReviewSectionRepairTarget(input: {
  markdown: string;
  sectionIndex: number;
  allowedCitationNumbers: readonly number[];
}): ReviewSectionRepairTarget | null {
  const section = listReviewSectionSlices(input.markdown)[input.sectionIndex];
  if (!section) {
    return null;
  }
  return {
    ...section,
    allowedCitationNumbers: [
      ...new Set(input.allowedCitationNumbers)
    ].sort((left, right) => left - right)
  };
}

export function applyReviewSectionRepair(input: {
  markdown: string;
  target: ReviewSectionRepairTarget;
  decision: ReviewSectionRepairDecision;
}): string | null {
  if (
    input.decision.schema_version !==
      "doctor_research_section_repair.v1" ||
    input.decision.section_id !== input.target.sectionId ||
    input.decision.original_sha256 !== input.target.sha256
  ) {
    return null;
  }
  const current = listReviewSectionSlices(input.markdown).find(
    (section) => section.sectionId === input.target.sectionId
  );
  if (
    !current ||
    current.sha256 !== input.target.sha256 ||
    current.heading !== input.target.heading
  ) {
    return null;
  }
  const replacement = input.decision.replacement
    .trim()
    .replace(/^\uFEFF/u, "");
  if (replacement.length === 0 || replacement.length > 100_000) {
    return null;
  }
  const replacementSections = listReviewSectionSlices(replacement);
  if (
    replacementSections.length !== 1 ||
    replacementSections[0]!.start !== 0 ||
    replacementSections[0]!.heading !== current.heading
  ) {
    return null;
  }
  const allowedCitations = new Set(input.target.allowedCitationNumbers);
  if (
    extractNumericCitations(replacement).some(
      (citation) => !allowedCitations.has(citation)
    )
  ) {
    return null;
  }
  const trailingWhitespace = /\s*$/u.exec(current.rawText)?.[0] ?? "";
  const replacementRaw = `${replacement.trimEnd()}${trailingWhitespace}`;
  return (
    input.markdown.slice(0, current.start) +
    replacementRaw +
    input.markdown.slice(current.end)
  );
}

export function allowsBoundedRepairConvergence(
  errorCodes: readonly string[],
  hasSingleSectionCandidate: boolean
): boolean {
  return (
    hasSingleSectionCandidate ||
    (errorCodes.length > 0 && new Set(errorCodes).size === 1)
  );
}

function extractNumericCitations(markdown: string): number[] {
  const citations: number[] = [];
  for (const match of markdown.matchAll(/\[([0-9,\s-]+)\]/gu)) {
    for (const group of match[1]!.split(",").map((value) => value.trim())) {
      const range = /^([0-9]+)-([0-9]+)$/u.exec(group);
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
      } else if (/^[0-9]+$/u.test(group)) {
        citations.push(Number.parseInt(group, 10));
      }
    }
  }
  return citations;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
