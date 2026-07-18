import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  stat
} from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import path from "node:path";
import {
  assertPathInsideRoot,
  assertRealPathInsideRoot
} from "./fs-guard.js";

export interface ResearchBackupArtifactManifest {
  artifact_id: string;
  storage_relative_path: string;
  storage_version: number;
  size_bytes: number;
  sha256: string;
}

export interface ResearchBackupManifest {
  schema_version: "research_backup_manifest.v1";
  backup_id: string;
  created_at: string;
  research_schema_version: number;
  database_snapshot_sha256: string;
  artifacts: ResearchBackupArtifactManifest[];
}

export interface ResearchBackupSnapshot {
  backupDirectory: string;
  databaseSnapshotPath: string;
  artifactDirectory: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: ResearchBackupManifest;
}

export async function createResearchBackupSnapshot(input: {
  sourceDatabase: DatabaseSync;
  artifactRoot: string;
  backupRoot: string;
  backupId: string;
  now: Date;
}): Promise<ResearchBackupSnapshot> {
  if (!/^drb_[a-f0-9]{16,64}$/.test(input.backupId)) {
    throw new Error("Invalid Research backup ID.");
  }
  const backupRoot = path.resolve(input.backupRoot);
  const artifactRoot = path.resolve(input.artifactRoot);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await assertRealPathInsideRoot(
    backupRoot,
    backupRoot,
    "Research backup root must be a real directory."
  );
  await assertRealPathInsideRoot(
    artifactRoot,
    artifactRoot,
    "Research artifact root must be a real directory."
  );
  const backupDirectory = path.resolve(backupRoot, input.backupId);
  assertBackupPath(backupRoot, backupDirectory);
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await assertRealPathInsideRoot(
    backupRoot,
    backupDirectory,
    "Research backup path escapes its configured root."
  );
  const databaseSnapshotPath = path.join(
    backupDirectory,
    "research.snapshot.db"
  );
  await backup(input.sourceDatabase, databaseSnapshotPath);
  const databaseSnapshotSha256 = await fileSha256(databaseSnapshotPath);

  const snapshot = new DatabaseSync(databaseSnapshotPath, {
    readOnly: true
  });
  let researchSchemaVersion: number;
  let rows: Array<{
    artifact_id: string;
    storage_path: string;
    storage_version: number;
    size_bytes: number;
    sha256: string;
  }>;
  try {
    researchSchemaVersion = (
      snapshot
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM research_schema_migrations"
        )
        .get() as { version: number }
    ).version;
    rows = snapshot
      .prepare(
        `SELECT artifact_id, storage_path, storage_version, size_bytes, sha256
         FROM research_artifacts
         ORDER BY artifact_id ASC`
      )
      .all() as typeof rows;
  } finally {
    snapshot.close();
  }

  const artifactDirectory = path.join(backupDirectory, "artifacts");
  await mkdir(artifactDirectory, { recursive: false, mode: 0o700 });
  const artifacts: ResearchBackupArtifactManifest[] = [];
  for (const row of rows) {
    validateStorageRelativePath(row.storage_path);
    const sourcePath = path.resolve(
      artifactRoot,
      ...row.storage_path.split("/")
    );
    assertBackupPath(artifactRoot, sourcePath);
    await assertRealPathInsideRoot(
      artifactRoot,
      sourcePath,
      "Research backup source path escapes its configured root."
    );
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size !== row.size_bytes) {
      throw new Error(`Artifact size mismatch: ${row.artifact_id}`);
    }
    const sourceSha256 = await fileSha256(sourcePath);
    if (sourceSha256 !== row.sha256) {
      throw new Error(`Artifact hash mismatch: ${row.artifact_id}`);
    }
    const destinationPath = path.resolve(
      artifactDirectory,
      ...row.storage_path.split("/")
    );
    assertBackupPath(artifactDirectory, destinationPath);
    await mkdir(path.dirname(destinationPath), {
      recursive: true,
      mode: 0o700
    });
    await assertRealPathInsideRoot(
      artifactDirectory,
      destinationPath,
      "Research backup destination path escapes its configured root.",
      { allowMissingLeaf: true }
    );
    await copyFile(sourcePath, destinationPath);
    artifacts.push({
      artifact_id: row.artifact_id,
      storage_relative_path: row.storage_path,
      storage_version: row.storage_version,
      size_bytes: row.size_bytes,
      sha256: row.sha256
    });
  }

  const manifest: ResearchBackupManifest = {
    schema_version: "research_backup_manifest.v1",
    backup_id: input.backupId,
    created_at: input.now.toISOString(),
    research_schema_version: researchSchemaVersion,
    database_snapshot_sha256: databaseSnapshotSha256,
    artifacts
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const manifestHandle = await open(manifestPath, "wx", 0o600);
  try {
    await manifestHandle.writeFile(manifestBytes);
    await manifestHandle.sync();
  } finally {
    await manifestHandle.close();
  }
  return {
    backupDirectory,
    databaseSnapshotPath,
    artifactDirectory,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifest
  };
}

export async function verifyResearchBackupSnapshot(input: {
  backupDirectory: string;
}): Promise<{
  passed: boolean;
  errors: string[];
  manifest: ResearchBackupManifest | null;
}> {
  const backupDirectory = path.resolve(input.backupDirectory);
  const manifestPath = path.join(backupDirectory, "manifest.json");
  let manifest: ResearchBackupManifest;
  try {
    await assertRealPathInsideRoot(
      backupDirectory,
      manifestPath,
      "Research backup path escapes its configured root."
    );
    manifest = parseManifest(await readFile(manifestPath, "utf8"));
  } catch {
    return {
      passed: false,
      errors: ["manifest_invalid"],
      manifest: null
    };
  }
  const errors: string[] = [];
  const databaseSnapshotPath = path.join(
    backupDirectory,
    "research.snapshot.db"
  );
  let databaseSnapshotSha256: string;
  try {
    await assertRealPathInsideRoot(
      backupDirectory,
      databaseSnapshotPath,
      "Research backup path escapes its configured root."
    );
    databaseSnapshotSha256 = await fileSha256(databaseSnapshotPath);
  } catch {
    return {
      passed: false,
      errors: ["database_snapshot_unreadable"],
      manifest
    };
  }
  if (databaseSnapshotSha256 !== manifest.database_snapshot_sha256) {
    errors.push("database_snapshot_hash_mismatch");
  }
  let snapshot: DatabaseSync | null = null;
  try {
    snapshot = new DatabaseSync(databaseSnapshotPath, {
      readOnly: true
    });
    const integrity = snapshot.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== "ok") {
      errors.push("database_integrity_failed");
    }
    if (snapshot.prepare("PRAGMA foreign_key_check").all().length > 0) {
      errors.push("database_foreign_key_failed");
    }
    const rows = snapshot
      .prepare(
        `SELECT artifact_id, storage_path, storage_version, size_bytes, sha256
         FROM research_artifacts
         ORDER BY artifact_id ASC`
      )
      .all() as Array<{
      artifact_id: string;
      storage_path: string;
      storage_version: number;
      size_bytes: number;
      sha256: string;
    }>;
    if (
      JSON.stringify(
        rows.map((row) => ({
          artifact_id: row.artifact_id,
          storage_relative_path: row.storage_path,
          storage_version: row.storage_version,
          size_bytes: row.size_bytes,
          sha256: row.sha256
        }))
      ) !== JSON.stringify(manifest.artifacts)
    ) {
      errors.push("database_artifact_manifest_mismatch");
    }
  } catch {
    errors.push("database_snapshot_invalid");
  } finally {
    snapshot?.close();
  }
  for (const artifact of manifest.artifacts) {
    try {
      validateStorageRelativePath(artifact.storage_relative_path);
      const artifactPath = path.resolve(
        backupDirectory,
        "artifacts",
        ...artifact.storage_relative_path.split("/")
      );
      assertBackupPath(
        path.join(backupDirectory, "artifacts"),
        artifactPath
      );
      await assertRealPathInsideRoot(
        path.join(backupDirectory, "artifacts"),
        artifactPath,
        "Research backup artifact path escapes its configured root."
      );
      const artifactStat = await stat(artifactPath);
      if (
        !artifactStat.isFile() ||
        artifactStat.size !== artifact.size_bytes
      ) {
        errors.push(`artifact_size_mismatch:${artifact.artifact_id}`);
        continue;
      }
      if ((await fileSha256(artifactPath)) !== artifact.sha256) {
        errors.push(`artifact_hash_mismatch:${artifact.artifact_id}`);
      }
    } catch {
      errors.push(`artifact_missing:${artifact.artifact_id}`);
    }
  }
  return {
    passed: errors.length === 0,
    errors,
    manifest
  };
}

async function fileSha256(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function parseManifest(value: string): ResearchBackupManifest {
  const parsed = JSON.parse(value) as ResearchBackupManifest;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema_version !== "research_backup_manifest.v1" ||
    !/^drb_[a-f0-9]{16,64}$/.test(parsed.backup_id) ||
    !Number.isSafeInteger(parsed.research_schema_version) ||
    !/^[a-f0-9]{64}$/.test(parsed.database_snapshot_sha256) ||
    !Array.isArray(parsed.artifacts)
  ) {
    throw new Error("Invalid Research backup manifest.");
  }
  return parsed;
}

function validateStorageRelativePath(value: string): void {
  if (
    !/^drr_[a-f0-9]{32}\/dra_[a-f0-9]{32}\.v[1-9][0-9]*$/.test(
      value
    )
  ) {
    throw new Error("Invalid Research artifact storage path.");
  }
}

function assertBackupPath(root: string, candidate: string): void {
  assertPathInsideRoot(
    root,
    candidate,
    "Research backup path escapes its configured root."
  );
}
