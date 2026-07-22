import { countReviewContractContent } from "./review-contract-policy.js";

export type ReviewContractLanguage = "zh-CN" | "en";

const citedResultFragment =
  /[^。！？]{0,220}(?:显示|表明|发现|提示)\s*(\[[0-9,\s-]+\])\s*[。！？]/u;
const titleInferenceFragment =
  /[^。！？]{0,220}(?:标题|题名)所暗示[^。！？]{0,220}?(\[[0-9,\s-]+\])\s*[。！？]/u;
const unfinishedComparison =
  /[^。！？]{0,220}(?:与|较)[^。！？]{1,120}相比\s*[。！？]/u;
const orphanedAssociation =
  /(^|[。！？]\s*)[^。！？]{0,48}(?:回归|分析|检验)[^。！？]{0,48}(?:确认|支持|提示)(?:了)?该关联[。！？]/u;
const orphanedContrast =
  /(^|[。！？]\s*)(?:但|然而|不过)[，,\s]*该(?:趋势|结果|发现|关联)[^。！？]*[。！？]/u;
const orphanedStudyLead =
  /^(\s*)(?:但|然而|不过)\s*该(?:项)?研究/u;
const orphanedCoverageLead =
  /^(\s*)涵盖(?=.{2,120}(?:研究|证据|影像|治疗|技术|人群|领域))/u;
const orphanedResearchVerb =
  /(^|[。！？]\s*)(发现|评估|比较|分析|探讨|考察)(?=.{4,220}(?:相关|关联|价值|影响|可行性|结果))/u;
const orphanedSystem = /(^|[。！？]\s*)该系统/u;
const orphanedCase = /(^|[。！？]\s*)该(?:个案|病例)/u;
const orphanedFinding = /(^|[。！？]\s*)该(?:发现|结果|趋势)/u;
const orphanedStudy =
  /(^|[。！？]\s*)该((?:大样本)?(?:回顾性|前瞻性|观察性)?研究)/u;
const orphanedComparative =
  /(^|[。！？]\s*)(在[^。！？]{2,48}方面，)(较[^。！？]{4,120}(?:减少|增加|降低|提高))/u;

function global(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags}g`);
}

function normalizeParagraphForDuplicateCheck(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\[[0-9,\s-]+\]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function hasBalancedDelimiter(
  value: string,
  open: string,
  close: string
): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function removeUnmatchedDelimiterCharacters(
  value: string,
  open: string,
  close: string
): string {
  const characters = Array.from(value);
  const unmatchedOpenIndexes: number[] = [];
  const removeIndexes = new Set<number>();
  for (const [index, character] of characters.entries()) {
    if (character === open) {
      unmatchedOpenIndexes.push(index);
      continue;
    }
    if (character !== close) {
      continue;
    }
    const matchingOpen = unmatchedOpenIndexes.pop();
    if (matchingOpen === undefined) {
      removeIndexes.add(index);
    }
  }
  for (const index of unmatchedOpenIndexes) {
    removeIndexes.add(index);
  }
  return removeIndexes.size === 0
    ? value
    : characters
        .filter((_, index) => !removeIndexes.has(index))
        .join("");
}

/**
 * Removes only unmatched delimiter glyphs; it never inserts text or turns
 * malformed citation text into a citation. Callers must rerun the complete
 * review contract after applying this bounded mechanical repair.
 */
export function repairReviewUnbalancedDelimiters(value: string): string {
  return value
    .split(/(\n\s*\n)/gu)
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }
      let repaired = part;
      for (const [open, close] of [
        ["(", ")"],
        ["\uFF08", "\uFF09"],
        ["[", "]"]
      ] as const) {
        repaired = removeUnmatchedDelimiterCharacters(
          repaired,
          open,
          close
        );
      }
      return repaired;
    })
    .join("");
}

export function validateReviewProseIntegrityRules(
  markdown: string,
  language: ReviewContractLanguage
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, paragraph] of markdown
    .split(/\n\s*\n/gu)
    .entries()) {
    const trimmed = paragraph.trim();
    if (trimmed === "" || /^#{1,6}\s/u.test(trimmed)) {
      continue;
    }
    const normalized = normalizeParagraphForDuplicateCheck(trimmed);
    if (
      countReviewContractContent(normalized, language) >=
      (language === "zh-CN" ? 40 : 20)
    ) {
      if (seen.has(normalized)) {
        errors.push(`review_duplicate_paragraph:paragraph=${index + 1}`);
      }
      seen.add(normalized);
    }
    if (
      !hasBalancedDelimiter(trimmed, "(", ")") ||
      !hasBalancedDelimiter(trimmed, "（", "）") ||
      !hasBalancedDelimiter(trimmed, "[", "]")
    ) {
      errors.push(`review_unbalanced_delimiter:paragraph=${index + 1}`);
    }
    if (
      language === "zh-CN" &&
      /(?:率|比例|占|为|达|至|约|术后|随访|纳入|共)\s*[0-9]+[.。](?![0-9])/u.test(
        trimmed
      )
    ) {
      errors.push(`review_truncated_numeric_prose:paragraph=${index + 1}`);
    }
    if (
      language === "zh-CN" &&
      /^(?:评估|比较|分析|探讨|考察)(?=.{4,180}(?:的关联|的价值|的影响)\s*\[[0-9,\s-]+\][。！？])/u.test(
        trimmed
      )
    ) {
      errors.push(`review_orphaned_prose_start:paragraph=${index + 1}`);
    }
    if (language === "zh-CN" && /^该系统/u.test(trimmed)) {
      errors.push(
        `review_orphaned_demonstrative_start:paragraph=${index + 1}`
      );
    }
  }
  return [...new Set(errors)];
}

export function validateCompleteReviewPresentationRules(input: {
  markdown: string;
  language: ReviewContractLanguage;
  hasEmbeddedAuxiliaryOutput: boolean;
}): string[] {
  const errors: string[] = [];
  if (input.hasEmbeddedAuxiliaryOutput) {
    errors.push("review_embedded_auxiliary_output");
  }
  if (input.language !== "zh-CN") {
    return errors;
  }
  for (const [index, paragraph] of input.markdown
    .split(/\n\s*\n/gu)
    .entries()) {
    const trimmed = paragraph.trim();
    if (trimmed === "" || /^#{1,6}\s/u.test(trimmed)) {
      continue;
    }
    if (
      orphanedResearchVerb.test(trimmed) ||
      orphanedStudyLead.test(trimmed) ||
      orphanedCoverageLead.test(trimmed)
    ) {
      errors.push(`review_orphaned_prose_start:paragraph=${index + 1}`);
    }
    if (
      orphanedSystem.test(trimmed) ||
      orphanedCase.test(trimmed) ||
      orphanedFinding.test(trimmed) ||
      orphanedStudy.test(trimmed) ||
      orphanedAssociation.test(trimmed) ||
      orphanedContrast.test(trimmed)
    ) {
      errors.push(
        `review_orphaned_demonstrative_start:paragraph=${index + 1}`
      );
    }
    if (orphanedComparative.test(trimmed)) {
      errors.push(
        `review_orphaned_comparative_start:paragraph=${index + 1}`
      );
    }
    if (
      unfinishedComparison.test(trimmed) ||
      citedResultFragment.test(trimmed) ||
      titleInferenceFragment.test(trimmed)
    ) {
      errors.push(
        `review_incomplete_evidence_sentence:paragraph=${index + 1}`
      );
    }
    const enumeration = [...trimmed.matchAll(/（([0-9]{1,2})）/gu)].map(
      (match) => Number.parseInt(match[1]!, 10)
    );
    if (
      enumeration.length >= 2 &&
      enumeration.some((value, itemIndex) => value !== itemIndex + 1)
    ) {
      errors.push(
        `review_inline_enumeration_sequence:paragraph=${index + 1}`
      );
    }
  }
  return [...new Set(errors)];
}

export function repairReviewProseStarts(
  value: string,
  language: ReviewContractLanguage
): string {
  if (language !== "zh-CN") {
    return value;
  }
  return value
    .replace(
      global(citedResultFragment),
      "公开摘要中的具体结果以所引证据$1为准。"
    )
    .replace(
      global(titleInferenceFragment),
      "所引文献的具体方法和结果未在公开摘要中披露$1。"
    )
    .replace(global(unfinishedComparison), "")
    .replace(global(orphanedAssociation), "$1")
    .replace(global(orphanedContrast), "$1")
    .replace(global(orphanedStudyLead), "$1相关研究")
    .replace(global(orphanedCoverageLead), "$1本综述所引证据涵盖")
    .replace(global(orphanedResearchVerb), "$1一项研究$2")
    .replace(global(orphanedSystem), "$1所引研究中的器械系统")
    .replace(global(orphanedCase), "$1所引病例")
    .replace(global(orphanedFinding), "$1所引研究的发现")
    .replace(global(orphanedStudy), "$1所引$2")
    .replace(global(orphanedComparative), "$1所引研究显示，$2$3");
}
