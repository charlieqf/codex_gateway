import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";

export const medicalSkillRelativePaths = [
  "doctor-research-query/SKILL.md",
  "literature-review/SKILL.md",
  "citation-management/SKILL.md",
  "scientific-writing/SKILL.md"
] as const;

export type MedicalSkillName =
  | "doctor-research-query"
  | "literature-review"
  | "citation-management"
  | "scientific-writing";

export interface MedicalSkillDocument {
  name: MedicalSkillName;
  relativePath: (typeof medicalSkillRelativePaths)[number];
  content: string;
  sha256: string;
}

export interface MedicalSkillBundle {
  rootPath: string;
  digest: string;
  documents: readonly MedicalSkillDocument[];
}

const maximumSkillBytes = 100_000;
const maximumBundleBytes = 400_000;
let defaultBundle: MedicalSkillBundle | null = null;

export function getDefaultMedicalSkillBundle(): MedicalSkillBundle {
  if (!defaultBundle) {
    defaultBundle = loadMedicalSkillBundle(
      process.env.RESEARCH_MEDICAL_SKILL_ROOT ??
        path.resolve("docs/research/采访skill")
    );
  }
  return defaultBundle;
}

export function loadMedicalSkillBundle(
  rootPath: string
): MedicalSkillBundle {
  const resolvedRoot = path.resolve(rootPath);
  const rootMetadata = lstatSync(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(
      "Medical Research Skill root must be a regular directory."
    );
  }
  const canonicalRoot = realpathSync(resolvedRoot);
  const documents: MedicalSkillDocument[] = [];
  let totalBytes = 0;
  for (const relativePath of medicalSkillRelativePaths) {
    const candidate = path.resolve(canonicalRoot, relativePath);
    const relative = path.relative(canonicalRoot, candidate);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Medical Research Skill path escaped its root.");
    }
    const metadata = lstatSync(candidate);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > maximumSkillBytes
    ) {
      throw new Error(
        `Medical Research Skill file is missing or invalid: ${relativePath}`
      );
    }
    const canonicalFile = realpathSync(candidate);
    const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
    if (
      canonicalRelative.startsWith("..") ||
      path.isAbsolute(canonicalRelative)
    ) {
      throw new Error("Medical Research Skill file escaped its root.");
    }
    const bytes = readFileSync(canonicalFile);
    totalBytes += bytes.length;
    if (totalBytes > maximumBundleBytes) {
      throw new Error("Medical Research Skill bundle is too large.");
    }
    const content = bytes.toString("utf8");
    if (content.includes("\uFFFD") || !content.includes("#")) {
      throw new Error(
        `Medical Research Skill file is not valid UTF-8 Markdown: ${relativePath}`
      );
    }
    documents.push({
      name: relativePath.split("/", 1)[0] as MedicalSkillName,
      relativePath,
      content,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  const digest = createHash("sha256")
    .update(
      documents
        .map(
          (document) =>
            `${document.relativePath}\u0000${document.sha256}`
        )
        .join("\n"),
      "utf8"
    )
    .digest("hex");
  return deepFreeze({
    rootPath: canonicalRoot,
    digest,
    documents
  });
}

export function renderMedicalSkillBundleForPrompt(
  bundle: MedicalSkillBundle
): string {
  return [
    "BEGIN MEDICAL TEAM SKILL BUNDLE",
    `bundle_sha256: ${bundle.digest}`,
    ...bundle.documents.flatMap((document) => [
      `BEGIN ${document.relativePath} sha256=${document.sha256}`,
      document.content,
      `END ${document.relativePath}`
    ]),
    "END MEDICAL TEAM SKILL BUNDLE"
  ].join("\n\n");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
