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
  const projectedDocuments = bundle.documents.map((document) => ({
    document,
    projectedContent: projectMedicalSkillForResearchApi(document)
  }));
  const projectionDigest = createHash("sha256")
    .update(
      projectedDocuments
        .map(
          ({ document, projectedContent }) =>
            `${document.relativePath}\u0000${createHash("sha256")
              .update(projectedContent, "utf8")
              .digest("hex")}`
        )
        .join("\n"),
      "utf8"
    )
    .digest("hex");
  return [
    "BEGIN MEDICAL TEAM SKILL EXECUTION PROJECTION",
    `bundle_sha256: ${bundle.digest}`,
    `projection_sha256: ${projectionDigest}`,
    "This projection is mechanically derived at runtime from the exact read-only bundle. It keeps the parent business directives and output templates plus the child Skills' workflow, evidence, citation, writing, and quality directives. Packaging-only reference examples, installation commands, optional visual/PDF deliverables, external tool instructions, resources, dependencies, and assets that are outside this four-text-artifact API are omitted.",
    ...projectedDocuments.flatMap(({ document, projectedContent }) => [
      `BEGIN ${document.relativePath} source_sha256=${document.sha256}`,
      projectedContent,
      `END ${document.relativePath}`
    ]),
    "END MEDICAL TEAM SKILL EXECUTION PROJECTION"
  ].join("\n\n");
}

const childExecutionSections: Readonly<
  Record<
    Exclude<MedicalSkillName, "doctor-research-query">,
    ReadonlySet<string>
  >
> = {
  "literature-review": new Set([
    "Overview",
    "When to Use This Skill",
    "Core Workflow",
    "Citation Style Guide",
    "Prioritizing High-Impact Papers (CRITICAL)",
    "Best Practices",
    "Common Pitfalls to Avoid",
    "Summary"
  ]),
  "citation-management": new Set([
    "Overview",
    "When to Use This Skill",
    "Core Workflow",
    "Search Strategies",
    "Best Practices",
    "Common Pitfalls to Avoid",
    "Summary"
  ]),
  "scientific-writing": new Set([
    "Overview",
    "When to Use This Skill",
    "Core Capabilities",
    "Workflow for Manuscript Development"
  ])
};

function projectMedicalSkillForResearchApi(
  document: MedicalSkillDocument
): string {
  const lines = document.content.split(/\r?\n/gu);
  const selected: string[] = [];
  let include = true;
  let fenced = false;
  const allowed =
    document.name === "doctor-research-query"
      ? null
      : childExecutionSections[document.name];
  for (const line of lines) {
    const heading = /^## (.+?)\s*$/u.exec(line)?.[1];
    if (heading) {
      include =
        allowed === null
          ? !heading.startsWith("七、完整输出示例")
          : allowed.has(heading);
      fenced = false;
    }
    if (!include) {
      continue;
    }
    if (allowed !== null && /^```/u.test(line.trim())) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) {
      selected.push(line);
    }
  }
  const projection = selected.join("\n").trim();
  if (
    projection.length < 1_000 ||
    !projection.includes("#") ||
    !projection.includes("Skill")
  ) {
    throw new Error(
      `Medical Research Skill execution projection is invalid: ${document.relativePath}`
    );
  }
  return projection;
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
