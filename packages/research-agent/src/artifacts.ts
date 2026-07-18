import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import {
  researchArtifactKinds,
  type DoctorResearchArtifactManifest,
  type DoctorResearchContent,
  type ResearchArtifactKind
} from "./contracts.js";
import {
  assertPathInsideRoot,
  assertRealPathInsideRoot
} from "./fs-guard.js";

export interface RenderedResearchArtifact {
  kind: ResearchArtifactKind;
  filenameUtf8: string;
  filenameAscii: string;
  contentType:
    | "text/markdown; charset=utf-8"
    | "text/plain; charset=utf-8";
  content: string;
}

export type ArtifactPublishFaultPoint =
  | "after_temp_write"
  | "after_file_sync"
  | "after_rename"
  | "before_metadata_commit";

export interface StagedResearchArtifact {
  artifactId: string;
  kind: ResearchArtifactKind;
  filenameUtf8: string;
  filenameAscii: string;
  contentType: RenderedResearchArtifact["contentType"];
  storageRelativePath: string;
  storageVersion: 1;
  sha256: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface StoredResearchArtifactFile {
  artifactId: string;
  storageRelativePath: string;
  sha256: string;
  sizeBytes: number;
}

export function publicResearchArtifactManifests(
  artifacts: readonly StagedResearchArtifact[]
): DoctorResearchArtifactManifest[] {
  return artifacts.map((artifact) => ({
    artifact_id: artifact.artifactId,
    kind: artifact.kind,
    filename: artifact.filenameUtf8,
    content_type: artifact.contentType,
    size_bytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    expires_at: artifact.expiresAt.toISOString(),
    download_url:
      `/gateway/research/v1/artifacts/${artifact.artifactId}/download`
  }));
}

export async function readVerifiedResearchArtifact(input: {
  root: string;
  artifact: StoredResearchArtifactFile;
  maximumArtifactBytes: number;
}): Promise<Buffer> {
  validatePositiveSizeLimit(
    input.maximumArtifactBytes,
    "maximumArtifactBytes"
  );
  if (
    !/^dra_[a-f0-9]{32}$/.test(input.artifact.artifactId) ||
    !/^drr_[a-f0-9]{32}\/dra_[a-f0-9]{32}\.v1$/.test(
      input.artifact.storageRelativePath
    ) ||
    !input.artifact.storageRelativePath.endsWith(
      `/${input.artifact.artifactId}.v1`
    ) ||
    !/^[a-f0-9]{64}$/.test(input.artifact.sha256) ||
    !Number.isSafeInteger(input.artifact.sizeBytes) ||
    input.artifact.sizeBytes < 0 ||
    input.artifact.sizeBytes > input.maximumArtifactBytes
  ) {
    throw new Error("Research artifact metadata is invalid.");
  }
  const root = path.resolve(input.root);
  const artifactPath = path.resolve(
    root,
    ...input.artifact.storageRelativePath.split("/")
  );
  await assertRealPathInsideRoot(
    root,
    artifactPath,
    "Research artifact path escapes its configured root."
  );
  const artifactStat = await stat(artifactPath);
  if (
    !artifactStat.isFile() ||
    artifactStat.size !== input.artifact.sizeBytes
  ) {
    throw new Error("Research artifact size does not match metadata.");
  }
  const bytes = await readFile(artifactPath);
  if (
    bytes.length !== input.artifact.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== input.artifact.sha256
  ) {
    throw new Error("Research artifact integrity check failed.");
  }
  return bytes;
}

export async function deleteResearchArtifactFiles(input: {
  root: string;
  storageRelativePaths: readonly string[];
}): Promise<{ deleted: number; missing: number }> {
  if (input.storageRelativePaths.length > 100) {
    throw new Error("At most 100 Research artifact paths may be deleted.");
  }
  const root = path.resolve(input.root);
  try {
    await assertRealPathInsideRoot(
      root,
      root,
      "Research artifact root must be a real directory."
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        deleted: 0,
        missing: input.storageRelativePaths.length
      };
    }
    throw error;
  }
  let deleted = 0;
  let missing = 0;
  const runDirectories = new Set<string>();
  for (const relativePath of input.storageRelativePaths) {
    if (
      !/^drr_[a-f0-9]{32}\/dra_[a-f0-9]{32}\.v1$/.test(relativePath)
    ) {
      throw new Error("Research artifact cleanup path is invalid.");
    }
    const artifactPath = path.resolve(root, ...relativePath.split("/"));
    try {
      await assertRealPathInsideRoot(
        root,
        artifactPath,
        "Research artifact cleanup path escapes its configured root."
      );
      await rm(artifactPath);
      deleted += 1;
      runDirectories.add(path.dirname(artifactPath));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        missing += 1;
        continue;
      }
      throw error;
    }
  }
  for (const runDirectory of runDirectories) {
    try {
      await rm(runDirectory);
    } catch (error) {
      if (
        errorCode(error) !== "ENOENT" &&
        errorCode(error) !== "ENOTEMPTY" &&
        errorCode(error) !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
  return { deleted, missing };
}

export function renderDoctorResearchArtifacts(
  result: DoctorResearchContent,
  language: "zh-CN" | "en"
): RenderedResearchArtifact[] {
  if (
    result.predicted_questions.length !== 5 ||
    result.answers.length !== 5
  ) {
    throw new Error("Exactly five questions and answers are required.");
  }
  const displayName = safeDisplayFilenamePart(result.doctor.name);
  const sourceById = new Map(
    result.sources.map((source) => [source.source_id, source])
  );
  const primarySources = result.profile.primary_public_source_ids.map(
    (sourceId) => {
      const source = sourceById.get(sourceId);
      if (!source) {
        throw new Error(`Unknown primary source: ${sourceId}`);
      }
      return `- [${source.title}](${source.url}) — ${source.accessed_at.slice(0, 10)} (${source.source_id})`;
    }
  );
  const profile = [
    `# ${result.doctor.name} ${language === "zh-CN" ? "基础信息与研究方向" : "Profile and Research Directions"}`,
    "",
    section(
      language === "zh-CN" ? "基础档案" : "Profile",
      [
        `${language === "zh-CN" ? "姓名" : "Name"}: ${result.doctor.name}`,
        `${language === "zh-CN" ? "医院" : "Hospital"}: ${result.doctor.hospital ?? "—"}`,
        `${language === "zh-CN" ? "科室" : "Department"}: ${result.doctor.department ?? "—"}`
      ]
    ),
    section(
      language === "zh-CN" ? "专业与任职" : "Expertise and Positions",
      [...result.profile.positions, ...result.profile.expertise]
    ),
    section(
      language === "zh-CN" ? "从业与教育经历" : "Education and Career",
      result.profile.education_and_career
    ),
    section(
      language === "zh-CN" ? "核心研究方向" : "Research Directions",
      result.profile.research_directions
    ),
    section(
      language === "zh-CN" ? "代表性科研成果" : "Representative Outputs",
      result.profile.representative_outputs
    ),
    `## ${language === "zh-CN" ? "主要公开来源" : "Main Public Sources"}`,
    "",
    ...primarySources,
    ""
  ].join("\n");

  const references = result.review.references.map(
    (reference, index) =>
      `${index + 1}. ${reference.title}. ${reference.journal}. ${reference.publication_year}.` +
      `${reference.pmid ? ` PMID: ${reference.pmid}.` : ""}` +
      `${reference.doi ? ` DOI: ${reference.doi}.` : ""}`
  );
  const review = [
    `# ${result.review.title}`,
    "",
    "## Abstract",
    "",
    result.review.abstract,
    "",
    "## Keywords",
    "",
    result.review.keywords.join("; "),
    "",
    result.review.markdown.trim(),
    "",
    "## References",
    "",
    ...references,
    "",
    "## Search Report",
    "",
    `- Databases: ${result.review.search_report.databases.join(", ")}`,
    `- Searched at: ${result.review.search_report.searched_at}`,
    `- Included: ${result.review.search_report.included_count}`,
    ...result.review.search_report.queries.map((query) => `- Query: ${query}`),
    ""
  ].join("\n");
  const questions = result.predicted_questions
    .map((question, index) => `${index + 1}${language === "zh-CN" ? "、" : ". "}${question}`)
    .join("\n");
  const answers = [
    `# ${result.doctor.name} ${language === "zh-CN" ? "问题与答案" : "Questions and Answers"}`,
    "",
    ...result.answers.flatMap((answer, index) => [
      `## ${language === "zh-CN" ? "问题" : "Question"} ${index + 1}`,
      "",
      result.predicted_questions[index]!,
      "",
      `**${language === "zh-CN" ? "答案" : "Answer"}**: ${answer.answer}`,
      ""
    ])
  ].join("\n");

  const names =
    language === "zh-CN"
      ? {
          profile: `${displayName}_基础信息与研究方向.md`,
          review: `${displayName}_相关领域前沿综述.md`,
          questions: `${displayName}_医生可能问机器人问题.txt`,
          answers: `${displayName}_问题与答案.md`
        }
      : {
          profile: `${displayName}_profile-and-research-directions.md`,
          review: `${displayName}_frontier-review.md`,
          questions: `${displayName}_predicted-questions.txt`,
          answers: `${displayName}_questions-and-answers.md`
        };
  return [
    rendered("profile", names.profile, "doctor-research-profile.md", profile),
    rendered("review", names.review, "doctor-research-review.md", review),
    rendered(
      "questions",
      names.questions,
      "doctor-research-questions.txt",
      `${questions}\n`
    ),
    rendered("answers", names.answers, "doctor-research-answers.md", answers)
  ];
}

export async function stageResearchArtifacts(input: {
  root: string;
  runId: string;
  artifacts: readonly RenderedResearchArtifact[];
  expiresAt: Date;
  maximumArtifactBytes: number;
  maximumRunArtifactBytes: number;
  onFaultPoint?: (
    point: ArtifactPublishFaultPoint,
    artifact?: StagedResearchArtifact
  ) => void | Promise<void>;
}): Promise<StagedResearchArtifact[]> {
  if (!/^drr_[a-f0-9]{32}$/.test(input.runId)) {
    throw new Error("Invalid Research run ID.");
  }
  validateRenderedSet(input.artifacts);
  validatePositiveSizeLimit(
    input.maximumArtifactBytes,
    "maximumArtifactBytes"
  );
  validatePositiveSizeLimit(
    input.maximumRunArtifactBytes,
    "maximumRunArtifactBytes"
  );
  const artifactSizes = input.artifacts.map(
    (artifact) => Buffer.byteLength(artifact.content, "utf8")
  );
  if (artifactSizes.some((size) => size > input.maximumArtifactBytes)) {
    throw new Error("A Research artifact exceeds maximumArtifactBytes.");
  }
  if (
    artifactSizes.reduce((total, size) => total + size, 0) >
    input.maximumRunArtifactBytes
  ) {
    throw new Error(
      "Research artifacts exceed maximumRunArtifactBytes."
    );
  }
  const absoluteRoot = path.resolve(input.root);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  await assertRealPathInsideRoot(
    absoluteRoot,
    absoluteRoot,
    "Research artifact root must be a real directory."
  );
  const runDirectory = path.resolve(absoluteRoot, input.runId);
  assertArtifactPath(absoluteRoot, runDirectory);
  try {
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  await assertRealPathInsideRoot(
    absoluteRoot,
    runDirectory,
    "Research artifact path escapes its configured root."
  );

  const staged: StagedResearchArtifact[] = [];
  for (const artifact of input.artifacts) {
    const artifactId = `dra_${randomUUID().replaceAll("-", "")}`;
    const basename = `${artifactId}.v1`;
    const temporaryPath = path.join(
      runDirectory,
      `.${basename}.tmp-${randomUUID().replaceAll("-", "")}`
    );
    const publishedPath = path.join(runDirectory, basename);
    assertArtifactPath(absoluteRoot, temporaryPath);
    assertArtifactPath(absoluteRoot, publishedPath);
    await assertRealPathInsideRoot(
      absoluteRoot,
      temporaryPath,
      "Research artifact path escapes its configured root.",
      { allowMissingLeaf: true }
    );
    await assertRealPathInsideRoot(
      absoluteRoot,
      publishedPath,
      "Research artifact path escapes its configured root.",
      { allowMissingLeaf: true }
    );
    const bytes = Buffer.from(artifact.content, "utf8");
    const stagedArtifact: StagedResearchArtifact = {
      artifactId,
      kind: artifact.kind,
      filenameUtf8: artifact.filenameUtf8,
      filenameAscii: artifact.filenameAscii,
      contentType: artifact.contentType,
      storageRelativePath: `${input.runId}/${basename}`,
      storageVersion: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      expiresAt: input.expiresAt
    };
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await input.onFaultPoint?.("after_temp_write", stagedArtifact);
      await handle.sync();
      await input.onFaultPoint?.("after_file_sync", stagedArtifact);
    } finally {
      await handle.close();
    }
    try {
      await lstat(publishedPath);
      throw new Error("Research artifact destination already exists.");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    await rename(temporaryPath, publishedPath);
    await syncDirectoryBestEffort(runDirectory);
    staged.push(stagedArtifact);
    await input.onFaultPoint?.("after_rename", stagedArtifact);
  }
  await input.onFaultPoint?.("before_metadata_commit");
  return staged;
}

export async function recoverOrphanResearchArtifacts(input: {
  root: string;
  committedRelativePaths: ReadonlySet<string>;
  now: Date;
  graceMs: number;
}): Promise<{ removedTemporary: number; removedPublished: number }> {
  if (!Number.isSafeInteger(input.graceMs) || input.graceMs < 0) {
    throw new Error("graceMs must be a non-negative integer.");
  }
  const absoluteRoot = path.resolve(input.root);
  let removedTemporary = 0;
  let removedPublished = 0;
  let runEntries;
  try {
    runEntries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return { removedTemporary, removedPublished };
    }
    throw error;
  }
  await assertRealPathInsideRoot(
    absoluteRoot,
    absoluteRoot,
    "Research artifact root must be a real directory."
  );
  for (const runEntry of runEntries) {
    if (
      !runEntry.isDirectory() ||
      !/^drr_[a-f0-9]{32}$/.test(runEntry.name)
    ) {
      continue;
    }
    const runDirectory = path.resolve(absoluteRoot, runEntry.name);
    assertArtifactPath(absoluteRoot, runDirectory);
    await assertRealPathInsideRoot(
      absoluteRoot,
      runDirectory,
      "Research artifact path escapes its configured root."
    );
    const files = await readdir(runDirectory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) {
        continue;
      }
      const absolutePath = path.resolve(runDirectory, file.name);
      assertArtifactPath(absoluteRoot, absolutePath);
      await assertRealPathInsideRoot(
        absoluteRoot,
        absolutePath,
        "Research artifact path escapes its configured root."
      );
      const fileStat = await stat(absolutePath);
      if (
        input.now.getTime() - fileStat.mtimeMs < input.graceMs
      ) {
        continue;
      }
      const relativePath = `${runEntry.name}/${file.name}`;
      if (/^\.dra_[a-f0-9]{32}\.v1\.tmp-[a-f0-9]{32}$/.test(file.name)) {
        await rm(absolutePath);
        removedTemporary += 1;
      } else if (
        /^dra_[a-f0-9]{32}\.v1$/.test(file.name) &&
        !input.committedRelativePaths.has(relativePath)
      ) {
        await rm(absolutePath);
        removedPublished += 1;
      }
    }
  }
  return { removedTemporary, removedPublished };
}

function rendered(
  kind: ResearchArtifactKind,
  filenameUtf8: string,
  filenameAscii: string,
  content: string
): RenderedResearchArtifact {
  return {
    kind,
    filenameUtf8,
    filenameAscii,
    contentType:
      kind === "questions"
        ? "text/plain; charset=utf-8"
        : "text/markdown; charset=utf-8",
    content
  };
}

function section(title: string, values: readonly string[]): string {
  return [`## ${title}`, "", ...values.map((value) => `- ${value}`), ""].join(
    "\n"
  );
}

function safeDisplayFilenamePart(value: string): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")
    .replace(/[.\s]+$/u, "")
    .trim();
  const shortened = Array.from(cleaned).slice(0, 80).join("");
  return shortened || "doctor";
}

function validateRenderedSet(
  artifacts: readonly RenderedResearchArtifact[]
): void {
  if (
    artifacts.length !== researchArtifactKinds.length ||
    new Set(artifacts.map((artifact) => artifact.kind)).size !==
      researchArtifactKinds.length ||
    researchArtifactKinds.some(
      (kind) => !artifacts.some((artifact) => artifact.kind === kind)
    )
  ) {
    throw new Error("Exactly four standard Research artifacts are required.");
  }
}

function validatePositiveSizeLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function assertArtifactPath(root: string, candidate: string): void {
  assertPathInsideRoot(
    root,
    candidate,
    "Research artifact path escapes the configured root."
  );
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}
