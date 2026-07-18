import { lstat, readdir, statfs } from "node:fs/promises";
import path from "node:path";
import { assertRealPathInsideRoot } from "./fs-guard.js";

export interface ResearchStorageAdmissionPolicy {
  minimumFreeBytes: number;
  minimumFreePercent: number;
  maximumResearchBytes: number;
}

export interface ResearchStorageAdmissionReport {
  available: boolean;
  freeBytes: number;
  totalBytes: number;
  freePercent: number;
  researchBytes: number;
  reasons: Array<
    | "minimum_free_bytes"
    | "minimum_free_percent"
    | "maximum_research_bytes"
  >;
}

export async function probeResearchStorageAdmission(input: {
  filesystemPath: string;
  researchRoot: string;
  policy: ResearchStorageAdmissionPolicy;
}): Promise<ResearchStorageAdmissionReport> {
  validatePolicy(input.policy);
  const filesystem = await statfs(path.resolve(input.filesystemPath), {
    bigint: true
  });
  const freeBytesBig = filesystem.bavail * filesystem.bsize;
  const totalBytesBig = filesystem.blocks * filesystem.bsize;
  const freeBytes = safeBigIntNumber(freeBytesBig, "free bytes");
  const totalBytes = safeBigIntNumber(totalBytesBig, "total bytes");
  const freePercent =
    totalBytes === 0 ? 0 : (freeBytes / totalBytes) * 100;
  const researchBytes = await directoryBytes(path.resolve(input.researchRoot));
  const reasons: ResearchStorageAdmissionReport["reasons"] = [];
  if (freeBytes < input.policy.minimumFreeBytes) {
    reasons.push("minimum_free_bytes");
  }
  if (freePercent < input.policy.minimumFreePercent) {
    reasons.push("minimum_free_percent");
  }
  if (researchBytes >= input.policy.maximumResearchBytes) {
    reasons.push("maximum_research_bytes");
  }
  return {
    available: reasons.length === 0,
    freeBytes,
    totalBytes,
    freePercent,
    researchBytes,
    reasons
  };
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    await assertRealPathInsideRoot(
      root,
      root,
      "Research storage root must be a real directory."
    );
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return 0;
    }
    throw error;
  }
  for (const entry of entries) {
    const child = path.resolve(root, entry.name);
    await assertRealPathInsideRoot(
      root,
      child,
      "Research storage path escapes its configured root."
    );
    const childStat = await lstat(child);
    if (childStat.isSymbolicLink()) {
      throw new Error("Research storage roots must not contain symbolic links.");
    }
    if (childStat.isDirectory()) {
      total = safeStorageByteSum(total, await directoryBytes(child));
    } else if (childStat.isFile()) {
      total = safeStorageByteSum(total, childStat.size);
    }
  }
  return total;
}

function safeStorageByteSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Research storage byte count exceeds the safe range.");
  }
  return total;
}

function validatePolicy(policy: ResearchStorageAdmissionPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer.`);
    }
  }
  if (policy.minimumFreePercent > 100) {
    throw new Error("minimumFreePercent cannot exceed 100.");
  }
  if (policy.maximumResearchBytes === 0) {
    throw new Error("maximumResearchBytes must be greater than zero.");
  }
}

function safeBigIntNumber(value: bigint, description: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Filesystem ${description} exceeds safe integer range.`);
  }
  return Number(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}
